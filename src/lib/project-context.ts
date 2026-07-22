import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { z } from "zod";
import { scanSecrets } from "./redact.js";
import { CODEWITH_NATIVE_IMPORTS_ENV, SESSION_INSTRUCTION_LAYERS, SESSION_RENDER_SCHEMA } from "./session-render.js";

export const PROJECT_CONTEXT_SCHEMA = "hasna.projects.project_context_bundle.v1" as const;
export const PROJECT_CONTEXT_MAX_INPUT_BYTES = 8 * 1024;
export const PROJECT_CONTEXT_MAX_RENDERED_BYTES = 4 * 1024;
export const PROJECT_CONTEXT_MAX_APPROX_TOKENS = 1_000;
export const PROJECT_CONTEXT_MAX_COMMANDS = 6;
export const PROJECT_CONTEXT_MAX_WARNINGS = 3;
export const PROJECT_CONTEXT_FRAGMENT_PATH = ".hasna/instructions/project-context.md";
export const PROJECT_CONTEXT_MANIFEST_PATH = ".hasna/project-context-manifest.json";
export const PROJECT_CONTEXT_CACHE_PATH = ".hasna/project-context-cache.json";
export const PROJECT_CONTEXT_LOCK_PATH = ".hasna/project-context.lock";
export const PROJECT_CONTEXT_SNAPSHOT_DIR = ".hasna/project-context-snapshots";
export const PROJECT_CONTEXT_CACHE_SCHEMA = "hasna.instructions.project-context-cache/v1" as const;
export const PROJECT_CONTEXT_MANAGED_COMMENT = "Managed by @hasna/configs project context";
export const LEGACY_CONFIGS_PACKAGE = "@hasna/configs" as const;
export const LEGACY_CONFIGS_COMPAT_VERSION = "0.2.45" as const;
export const LEGACY_CONFIGS_EXECUTABLE = "configs" as const;

const PROJECT_KINDS = [
  "open-source",
  "internal-app",
  "platform",
  "company-website",
  "scaffold",
  "community",
  "project",
  "experiment",
  "docs",
  "remote-only",
  "generic",
] as const;
const PROJECT_STATUSES = ["active", "archived", "deleted"] as const;
const LINK_STATES = ["linked", "partial", "unlinked"] as const;
const RESOLUTION_SOURCES = ["marker", "path", "id-or-slug", "name"] as const;
const safeId = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
const nullableId = safeId.nullable();
const producerSlug = z.string().min(1).max(512);
const producerName = z.string().max(PROJECT_CONTEXT_MAX_INPUT_BYTES);
const safeOptionalDisplay = z.string().min(1).max(512).refine(isSafeSingleLine, "must be a safe single-line value").nullable();
const isoTimestamp = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO timestamp");
const revisionSchema = z.string().min(1).max(512).refine((value) => revisionKey(value) !== null, "must be a monotonic rev-N or timestamp revision");
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const absolutePath = z.string().min(1).max(4_096).refine((value) => isAbsolute(value), "must be absolute").refine(isSafeSingleLine, "must be safe").nullable();
const commandArg = z.string().min(1).max(1_024).refine((value) => isSafeCommandArgument(value), "unsafe argv item");

const commandSchema = z.object({
  name: z.enum(["show", "context", "why", "context-bundle"]),
  argv: z.array(commandArg).min(1).max(8),
}).strict();

const projectContextBundleSchema = z.object({
  schema: z.literal(PROJECT_CONTEXT_SCHEMA),
  generated_at: isoTimestamp,
  hash: hashSchema,
  revision: revisionSchema,
  freshness: z.enum(["fresh", "stale", "unknown"]),
  resolution: z.object({
    source: z.enum(RESOLUTION_SOURCES),
    conflict: z.boolean(),
    create_allowed: z.boolean(),
  }).strict(),
  authority: z.object({
    owner: z.literal("projects"),
    mode: z.enum(["local", "api"]),
    storage: z.enum(["sqlite", "cloud", "self-hosted"]),
    availability: z.enum(["available", "unavailable"]),
  }).strict(),
  project: z.object({
    id: safeId,
    slug: producerSlug,
    name: producerName,
    kind: z.enum(PROJECT_KINDS),
    status: z.enum(PROJECT_STATUSES),
    path: absolutePath,
    updated_at: isoTimestamp,
  }).strict(),
  links: z.object({
    todos: z.object({
      state: z.enum(LINK_STATES),
      project_id: nullableId,
      task_list_id: nullableId,
    }).strict(),
    conversations: z.object({
      state: z.enum(LINK_STATES),
      channel: safeOptionalDisplay,
    }).strict(),
    mementos: z.object({
      state: z.enum(LINK_STATES),
      project_id: nullableId,
      scope: safeOptionalDisplay,
    }).strict(),
  }).strict(),
  station: z.object({
    station_id: nullableId,
    machine_id: nullableId,
  }).strict().nullable(),
  commands: z.array(commandSchema).max(PROJECT_CONTEXT_MAX_COMMANDS),
}).strict();

const storedManifestProjectContextSchema = z.object({
  schema: z.literal(PROJECT_CONTEXT_SCHEMA),
  projectId: safeId,
  revision: revisionSchema,
  hash: hashSchema,
  status: z.enum(["fresh", "stale-source", "stale-cache"]),
  ageSeconds: z.number().int().nonnegative(),
  cachePath: z.string().min(1).max(1_024).refine(isSafeSingleLine, "must be safe"),
  fragmentPath: z.string().min(1).max(1_024).refine(isSafeSingleLine, "must be safe"),
}).strict();

const storedManifestFileSchema = z.object({
  path: z.string().min(1).max(1_024).refine(isSafeSingleLine, "must be safe"),
  relativePath: z.enum([
    PROJECT_CONTEXT_FRAGMENT_PATH,
    "CLAUDE.md",
    ".codewith/CODEWITH.md",
    "AGENTS.md",
  ]),
  role: z.enum(["fragment", "index"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIds: z.tuple([z.literal("project-context-bundle")]),
}).strict();

const storedManifestObservationSchema = z.object({
  schema: z.literal(SESSION_RENDER_SCHEMA),
  kind: z.literal("project-context"),
  projectContext: storedManifestProjectContextSchema,
  files: z.array(storedManifestFileSchema).min(1).max(2),
}).passthrough().superRefine((value, context) => {
  const fragments = value.files.filter((file) => file.relativePath === PROJECT_CONTEXT_FRAGMENT_PATH && file.role === "fragment");
  const indexes = value.files.filter((file) => file.role === "index");
  const uniquePaths = new Set(value.files.map((file) => file.relativePath));
  if (fragments.length !== 1 || indexes.length !== 1 || uniquePaths.size !== value.files.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "manifest must contain one canonical fragment and one unique runtime index",
    });
  }
});

const projectContextCacheSchema = z.object({
  schema: z.literal(PROJECT_CONTEXT_CACHE_SCHEMA),
  cached_at: isoTimestamp,
  project_id: safeId,
  revision: revisionSchema,
  hash: hashSchema,
  bundle: projectContextBundleSchema,
}).strict();

export type ProjectContextBundleV1 = z.infer<typeof projectContextBundleSchema>;
export type ProjectContextRuntime = "claude" | "codewith" | "agents";
export type ProjectContextStatus = "fresh" | "stale-source" | "stale-cache";
export type ProjectContextPhase = "before-compare" | "after-fragment" | "after-target" | "before-manifest";

export interface ProjectContextPlanInput {
  workspace_root: string;
  runtime: ProjectContextRuntime;
  bundle: ProjectContextBundleV1;
  source_path?: string;
  status?: ProjectContextStatus;
  age_seconds?: number;
  now?: Date;
  force?: boolean;
  codewith_native_imports?: boolean;
}

export interface ProjectContextPlan {
  workspace_root: string;
  runtime: ProjectContextRuntime;
  target_path: string;
  target_relative_path: string;
  fragment_path: string;
  manifest_path: string;
  cache_path: string;
  source_path: string;
  bundle: ProjectContextBundleV1;
  fragment: string;
  managed_block: string;
  target_content: string;
  target_previous_content: string | null;
  status: ProjectContextStatus;
  age_seconds: number;
  warnings: string[];
  included_commands: number;
  native_imports: boolean;
  marker: ManagedBlock | null;
  legacy_migration: boolean;
  expected_hashes: Map<string, string | null>;
}

export interface ProjectContextApplyOptions {
  workspace_root: string;
  runtime: ProjectContextRuntime;
  bundle_json?: string;
  bundle?: unknown;
  source_path?: string;
  expected_project_id?: string;
  allow_stale_cache?: boolean;
  max_stale_age_seconds?: number;
  now?: Date;
  force?: boolean;
  dry_run?: boolean;
  codewith_native_imports?: boolean;
  test_hooks?: {
    after_lock_open?: () => void;
    before_compare?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    after_fragment?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    after_target?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    before_manifest?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
  };
}

export interface ProjectContextApplyResult {
  applied: boolean;
  dry_run: boolean;
  workspace_root: string;
  runtime: ProjectContextRuntime;
  project_id: string;
  revision: string;
  hash: string;
  status: ProjectContextStatus;
  age_seconds: number;
  race_retries: number;
  target_path: string;
  fragment_path: string;
  manifest_path: string;
  cache_path: string;
  snapshot_path: string | null;
  warnings: string[];
}

interface ManagedBlock {
  start: number;
  end: number;
  id: string;
  revision: string;
  hash: string;
  legacy: boolean;
}

interface ProjectContextCache {
  schema: typeof PROJECT_CONTEXT_CACHE_SCHEMA;
  cached_at: string;
  project_id: string;
  revision: string;
  hash: string;
  bundle: ProjectContextBundleV1;
}

interface ProjectContextManifestObservation {
  projectContext: z.infer<typeof storedManifestProjectContextSchema>;
  files: Array<z.infer<typeof storedManifestFileSchema>>;
}

interface WorkspaceLock {
  fd: number;
  contentHash: string;
}

interface ProjectContextManifest {
  schema: typeof SESSION_RENDER_SCHEMA;
  kind: "project-context";
  tool: "claude" | "codewith" | "codex";
  adapterMode: "native-import" | "managed-block";
  profile: "project-context";
  sessionId: null;
  targetHome: string;
  targetKind: "project-root";
  targetOwner: {
    kind: "project";
    tool: "claude" | "codewith" | "codex";
    profile: "project-context";
    targetHome: string;
    projectRoot: string;
    ownedBy: "open-configs";
    canonicalOwner: "instructions";
    reason: string;
  };
  writable: true;
  blocked: false;
  blockers: [];
  generatedAt: string;
  env: Record<string, never>;
  sourceHash: string;
  sources: Array<{
    id: "project-context-bundle";
    label: "Project Context Bundle";
    layer: "repo";
    merge: "replace";
    order: 0;
    path: string;
    targetProviders: string[];
    owner: { kind: "package"; id: "@hasna/projects" };
    sourcePaths: [];
    hash: string;
    nonOverridable: true;
    replacementScope: "project-context";
    rules: [];
    provenance: {
      schema: typeof PROJECT_CONTEXT_SCHEMA;
      projectId: string;
      revision: string;
      hash: string;
    };
  }>;
  skippedSources: [];
  files: Array<{
    path: string;
    relativePath: string;
    role: "fragment" | "index";
    sha256: string;
    sourceIds: ["project-context-bundle"];
  }>;
  warnings: string[];
  projectContext: {
    schema: typeof PROJECT_CONTEXT_SCHEMA;
    projectId: string;
    revision: string;
    hash: string;
    status: ProjectContextStatus;
    ageSeconds: number;
    cachePath: string;
    fragmentPath: string;
  };
  compatibility: {
    legacyPackage: typeof LEGACY_CONFIGS_PACKAGE;
    legacyVersion: typeof LEGACY_CONFIGS_COMPAT_VERSION;
    legacyExecutable: typeof LEGACY_CONFIGS_EXECUTABLE;
    manifestSchema: typeof SESSION_RENDER_SCHEMA;
    managedBy: "@hasna/configs";
    ownedBy: "open-configs";
    canonicalOwner: "instructions";
  };
}

export class ProjectContextError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "ProjectContextError";
    this.code = code;
    this.details = details;
  }
}

class ProjectContextHashRace extends Error {}

export function computeProjectContextSourceHash(value: unknown): string {
  const normalized = removeHashForFingerprint(value);
  return `sha256:${sha256(stableStringify(normalized))}`;
}

export function parseProjectContextBundle(input: string | unknown): ProjectContextBundleV1 {
  let encoded: string;
  try {
    const serialized = typeof input === "string" ? input : JSON.stringify(input);
    if (typeof serialized !== "string") throw new Error("not JSON-serializable");
    encoded = serialized;
  } catch {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "bundle is not JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > PROJECT_CONTEXT_MAX_INPUT_BYTES) {
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `bundle exceeds ${PROJECT_CONTEXT_MAX_INPUT_BYTES} bytes`);
  }

  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "bundle is not valid JSON");
  }
  const candidateSchema = isRecord(value) ? value["schema"] : undefined;
  if (typeof candidateSchema === "string" && candidateSchema !== PROJECT_CONTEXT_SCHEMA) {
    if (/^hasna\.projects\.project_context_bundle\.v[0-9]+$/.test(candidateSchema)) {
      throw new ProjectContextError("PROJECT_CONTEXT_UNSUPPORTED_VERSION", `unsupported bundle schema ${candidateSchema}`);
    }
  }

  const result = projectContextBundleSchema.safeParse(value);
  if (!result.success) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "bundle does not match the strict v1 schema", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
    });
  }
  const bundle = result.data;
  validateLinkConsistency(bundle);
  validateCommands(bundle);
  validateIdentityConsistency(bundle);
  rejectCredentialLikeBundle(bundle);
  const expected = computeProjectContextSourceHash(bundle);
  if (bundle.hash !== expected) {
    throw new ProjectContextError("PROJECT_CONTEXT_HASH_MISMATCH", "bundle hash does not match its canonical allowlisted payload");
  }
  return bundle;
}

export function planProjectContext(input: ProjectContextPlanInput): ProjectContextPlan {
  const workspaceRoot = assertSafeWorkspaceRoot(input.workspace_root);
  const bundle = parseProjectContextBundle(input.bundle);
  if (bundle.resolution.conflict) {
    throw new ProjectContextError("PROJECT_CONTEXT_IDENTITY_CONFLICT", "Projects reported a conflicting identity resolution");
  }
  const paths = runtimePaths(workspaceRoot, input.runtime);
  assertCodewithTargetIsConsumed(workspaceRoot, input.runtime);
  for (const path of [paths.target, paths.fragment, paths.manifest, paths.cache]) {
    assertNoSymlinkSegments(workspaceRoot, path);
  }

  const now = input.now ?? new Date();
  const status = input.status ?? (bundle.freshness === "fresh" ? "fresh" : "stale-source");
  const ageSeconds = input.age_seconds ?? ageInSeconds(bundle.generated_at, now);
  const nativeImports = runtimeUsesNativeImports(input.runtime, input.codewith_native_imports);
  const inlineMarkerOverhead = nativeImports ? 0 : Buffer.byteLength(buildManagedBlock(bundle, "", "\n"), "utf8");
  const generated = buildCanonicalFragment(
    bundle,
    status,
    ageSeconds,
    PROJECT_CONTEXT_MAX_RENDERED_BYTES - Math.max(320, inlineMarkerOverhead),
    PROJECT_CONTEXT_MAX_APPROX_TOKENS - Math.max(80, Math.ceil(inlineMarkerOverhead / 4)),
  );
  const previousTargetContent = existsSync(paths.target) ? readUtf8RegularFile(paths.target, workspaceRoot) : null;
  const markerParse = parseManagedBlock(previousTargetContent ?? "", input.force === true);
  if (markerParse.block && markerParse.block.id !== bundle.project.id && !input.force) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "managed block belongs to a different project");
  }
  const eol = preferredEol(previousTargetContent ?? "");
  const body = nativeImports
    ? `@${input.runtime === "codewith" ? "../" : ""}${PROJECT_CONTEXT_FRAGMENT_PATH}`
    : generated.fragment.trimEnd();
  const managedBlock = buildManagedBlock(bundle, body, eol);
  if (Buffer.byteLength(managedBlock, "utf8") > PROJECT_CONTEXT_MAX_RENDERED_BYTES || Math.ceil(managedBlock.length / 4) > PROJECT_CONTEXT_MAX_APPROX_TOKENS) {
    throw new ProjectContextError("PROJECT_CONTEXT_RENDER_TOO_LARGE", "managed provider block exceeds its bounded render budget");
  }

  const legacy = markerParse.block === null
    ? findLegacyCodewithWorkspaceSection(workspaceRoot, input.runtime, previousTargetContent, bundle)
    : null;
  const targetContent = replaceOrAppendManagedBlock(
    previousTargetContent ?? "",
    managedBlock,
    markerParse,
    legacy,
  );
  scanGeneratedContent(generated.fragment);
  scanGeneratedContent(managedBlock);

  const expectedHashes = new Map<string, string | null>();
  for (const path of [paths.fragment, paths.target, paths.cache, paths.manifest, paths.legacyManifest]) {
    if (!path) continue;
    expectedHashes.set(path, currentFileHash(path, workspaceRoot));
  }

  return {
    workspace_root: workspaceRoot,
    runtime: input.runtime,
    target_path: paths.target,
    target_relative_path: relativePosix(workspaceRoot, paths.target),
    fragment_path: paths.fragment,
    manifest_path: paths.manifest,
    cache_path: paths.cache,
    source_path: paths.cache,
    bundle,
    fragment: generated.fragment,
    managed_block: managedBlock,
    target_content: targetContent,
    target_previous_content: previousTargetContent,
    status,
    age_seconds: ageSeconds,
    warnings: generated.warnings,
    included_commands: generated.includedCommands,
    native_imports: nativeImports,
    marker: markerParse.block,
    legacy_migration: legacy !== null,
    expected_hashes: expectedHashes,
  };
}

export function applyProjectContext(options: ProjectContextApplyOptions): ProjectContextApplyResult {
  const workspaceRoot = assertSafeWorkspaceRoot(options.workspace_root);
  const now = options.now ?? new Date();
  const lockPath = resolve(workspaceRoot, ...PROJECT_CONTEXT_LOCK_PATH.split("/"));
  const lock = options.dry_run ? null : acquireWorkspaceLock(workspaceRoot, lockPath, options.test_hooks?.after_lock_open);
  try {
    const resolved = resolveBundleForApply(options, workspaceRoot, now);
    let raceRetries = 0;
    let snapshotPath: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = planProjectContext({
        workspace_root: workspaceRoot,
        runtime: options.runtime,
        bundle: resolved.bundle,
        source_path: resolved.sourcePath,
        status: resolved.status,
        age_seconds: resolved.ageSeconds,
        now,
        force: options.force,
        codewith_native_imports: options.codewith_native_imports,
      });
      assertRevisionOrdering(plan, options.force === true);
      const cacheContent = `${JSON.stringify(buildCache(plan, now), null, 2)}\n`;
      const legacyManifest = buildLegacyCompatibilityManifest(plan, now);
      const legacyOutput = legacyManifest
        ? {
          path: runtimePaths(workspaceRoot, plan.runtime).legacyManifest!,
          content: `${JSON.stringify(legacyManifest, null, 2)}\n`,
        }
        : null;
      options.test_hooks?.before_compare?.({ attempt, plan });
      if (!hashesStillMatch(plan.expected_hashes, workspaceRoot)) {
        if (attempt === 0) {
          raceRetries++;
          continue;
        }
        throw new ProjectContextError("PROJECT_CONTEXT_HASH_RACE", "workspace files changed during both compare-and-render attempts");
      }
      if (options.dry_run) return resultForPlan(plan, true, raceRetries, null);

      assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
      try {
        snapshotPath = writeMetadataSnapshot(plan, now);
        atomicWriteFile(plan.fragment_path, plan.fragment, workspaceRoot, 0o644, expectedPlanHash(plan, plan.fragment_path));
        options.test_hooks?.after_fragment?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        atomicWriteFile(plan.target_path, plan.target_content, workspaceRoot, 0o644, expectedPlanHash(plan, plan.target_path));
        options.test_hooks?.after_target?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        atomicWriteFile(plan.cache_path, cacheContent, workspaceRoot, 0o600, expectedPlanHash(plan, plan.cache_path));
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        if (legacyOutput) {
          atomicWriteFile(legacyOutput.path, legacyOutput.content, workspaceRoot, 0o600, expectedPlanHash(plan, legacyOutput.path));
          assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        }

        options.test_hooks?.before_manifest?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        assertRenderedOutputsStable(plan, cacheContent, legacyOutput);
        const manifest = buildManifest(plan, now);
        atomicWriteFile(plan.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, workspaceRoot, 0o600, expectedPlanHash(plan, plan.manifest_path));
        return resultForPlan(plan, false, raceRetries, snapshotPath);
      } catch (error) {
        if (error instanceof ProjectContextHashRace && attempt === 0) {
          raceRetries++;
          continue;
        }
        if (error instanceof ProjectContextHashRace) {
          throw new ProjectContextError("PROJECT_CONTEXT_HASH_RACE", "workspace files changed during both compare-and-render attempts");
        }
        throw error;
      }
    }
    throw new ProjectContextError("PROJECT_CONTEXT_HASH_RACE", "workspace files changed during both compare-and-render attempts");
  } finally {
    if (lock !== null) releaseWorkspaceLock(lockPath, lock, workspaceRoot);
  }
}

function resultForPlan(
  plan: ProjectContextPlan,
  dryRun: boolean,
  raceRetries: number,
  snapshotPath: string | null,
): ProjectContextApplyResult {
  return {
    applied: !dryRun,
    dry_run: dryRun,
    workspace_root: plan.workspace_root,
    runtime: plan.runtime,
    project_id: plan.bundle.project.id,
    revision: plan.bundle.revision,
    hash: plan.bundle.hash,
    status: plan.status,
    age_seconds: plan.age_seconds,
    race_retries: raceRetries,
    target_path: plan.target_path,
    fragment_path: plan.fragment_path,
    manifest_path: plan.manifest_path,
    cache_path: plan.cache_path,
    snapshot_path: snapshotPath,
    warnings: plan.warnings,
  };
}

function expectedPlanHash(plan: ProjectContextPlan, path: string): string | null {
  if (!plan.expected_hashes.has(path)) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `missing expected hash for managed path ${relativePosix(plan.workspace_root, path)}`);
  }
  return plan.expected_hashes.get(path) ?? null;
}

function assertRenderedOutputsStable(
  plan: ProjectContextPlan,
  cacheContent: string,
  legacyOutput: { path: string; content: string } | null,
): void {
  const outputs = [
    { path: plan.fragment_path, content: plan.fragment },
    { path: plan.target_path, content: plan.target_content },
    { path: plan.cache_path, content: cacheContent },
    ...(legacyOutput ? [legacyOutput] : []),
  ];
  for (const output of outputs) {
    if (currentFileHash(output.path, plan.workspace_root) !== sha256(output.content)) {
      throw new ProjectContextHashRace(`managed path changed before manifest commit: ${relativePosix(plan.workspace_root, output.path)}`);
    }
  }
}

function resolveBundleForApply(
  options: ProjectContextApplyOptions,
  workspaceRoot: string,
  now: Date,
): { bundle: ProjectContextBundleV1; status: ProjectContextStatus; ageSeconds: number; sourcePath: string } {
  const hasInput = options.bundle_json !== undefined || options.bundle !== undefined;
  if (hasInput) {
    try {
      const bundle = parseProjectContextBundle(options.bundle_json ?? options.bundle);
      if (options.expected_project_id && bundle.project.id !== options.expected_project_id) {
        throw new ProjectContextError("PROJECT_CONTEXT_IDENTITY_CONFLICT", "bundle project ID differs from the expected project ID");
      }
      return {
        bundle,
        status: bundle.freshness === "fresh" ? "fresh" : "stale-source",
        ageSeconds: ageInSeconds(bundle.generated_at, now),
        sourcePath: durableSourcePath(options.source_path, workspaceRoot),
      };
    } catch (error) {
      if (!(error instanceof ProjectContextError) || error.code !== "PROJECT_CONTEXT_UNSUPPORTED_VERSION" || !options.allow_stale_cache) {
        throw error;
      }
    }
  }

  if (!options.allow_stale_cache) {
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_REQUIRED", "a v1 bundle is required unless stale-cache fallback is explicit");
  }
  if (!options.expected_project_id) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_ID_REQUIRED", "expected_project_id is required for stale-cache fallback");
  }
  const cachePath = resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/"));
  const cache = readProjectContextCache(cachePath, workspaceRoot);
  if (!cache) throw new ProjectContextError("PROJECT_CONTEXT_CACHE_MISSING", "no last-known-good project context cache exists");
  if (cache.project_id !== options.expected_project_id || cache.bundle.project.id !== options.expected_project_id) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_ID_MISMATCH", "cached project context belongs to a different project");
  }
  const bundle = parseProjectContextBundle(cache.bundle);
  if (bundle.revision !== cache.revision || bundle.hash !== cache.hash) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", "cached revision or hash metadata is inconsistent");
  }
  const ageSeconds = Math.max(
    ageInSeconds(bundle.generated_at, now),
    ageInSeconds(cache.cached_at, now),
  );
  const maxAge = normalizeMaxStaleAge(options.max_stale_age_seconds);
  if (ageSeconds > maxAge) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_EXPIRED", `cached project context age ${ageSeconds}s exceeds ${maxAge}s`);
  }
  return { bundle, status: "stale-cache", ageSeconds, sourcePath: cachePath };
}

function buildCanonicalFragment(
  bundle: ProjectContextBundleV1,
  status: ProjectContextStatus,
  ageSeconds: number,
  maxBytes: number,
  maxTokens: number,
): { fragment: string; warnings: string[]; includedCommands: number } {
  const warnings = boundedWarnings(bundle, status, ageSeconds);
  const commands = [...bundle.commands];
  let fragment = "";
  do {
    fragment = renderFragment(bundle, status, ageSeconds, warnings, commands);
    const bytes = Buffer.byteLength(fragment, "utf8");
    const tokens = Math.ceil(fragment.length / 4);
    if (bytes <= maxBytes && tokens <= maxTokens) break;
    if (commands.length === 0) {
      throw new ProjectContextError("PROJECT_CONTEXT_RENDER_TOO_LARGE", "core project identity exceeds the bounded fragment budget");
    }
    commands.pop();
  } while (true);
  scanGeneratedContent(fragment);
  return { fragment, warnings, includedCommands: commands.length };
}

function renderFragment(
  bundle: ProjectContextBundleV1,
  status: ProjectContextStatus,
  ageSeconds: number,
  warnings: string[],
  commands: ProjectContextBundleV1["commands"],
): string {
  const project = bundle.project;
  const lines = [
    `<!-- ${PROJECT_CONTEXT_MANAGED_COMMENT} fragment. canonicalOwner=instructions id=${project.id} revision=${bundle.revision} hash=${bundle.hash} -->`,
    "# Managed Project Context",
    "",
    `Context: ${statusLabel(status, ageSeconds)}`,
    `Project: ${inlineCode(project.name)} (${inlineCode(project.slug)})`,
    `ID: \`${project.id}\``,
    `Kind: \`${project.kind}\``,
    `Status: \`${project.status}\``,
    `Revision: \`${bundle.revision}\``,
    `Authority: \`${bundle.authority.owner}\` / \`${bundle.authority.mode}\` / \`${bundle.authority.storage}\` / \`${bundle.authority.availability}\``,
    `Resolution: \`${bundle.resolution.source}\`; create allowed: \`${String(bundle.resolution.create_allowed)}\``,
    `Path: ${project.path ? inlineCode(project.path) : "`none`"}`,
    `Updated: \`${project.updated_at}\``,
    "",
    "## Linked Systems",
    "",
    `- Todos (\`${bundle.links.todos.state}\`): project ${inlineNullable(bundle.links.todos.project_id)}, task list ${inlineNullable(bundle.links.todos.task_list_id)}`,
    `- Conversations (\`${bundle.links.conversations.state}\`): channel ${inlineNullable(bundle.links.conversations.channel)}`,
    `- Mementos (\`${bundle.links.mementos.state}\`): project ${inlineNullable(bundle.links.mementos.project_id)}, scope ${inlineNullable(bundle.links.mementos.scope)}`,
    `- Station: ${bundle.station ? `${inlineNullable(bundle.station.station_id)}; machine ${inlineNullable(bundle.station.machine_id)}` : "`unknown`"}`,
  ];
  if (warnings.length > 0) {
    lines.push("", "## Warnings", "", ...warnings.map((warning) => `- ${warning}`));
  }
  if (commands.length > 0) {
    lines.push("", "## Safe Next Commands", "");
    for (const command of commands) {
      lines.push(`- ${escapeText(command.name)}: \`${command.argv.map(shellQuote).join(" ")}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

function boundedWarnings(bundle: ProjectContextBundleV1, status: ProjectContextStatus, ageSeconds: number): string[] {
  const warnings: string[] = [];
  if (status === "stale-cache") warnings.push(`Using a bounded last-known-good cache aged ${ageSeconds}s; refresh from Projects before mutation.`);
  else if (status === "stale-source") warnings.push(`Projects marked this context stale; source age is ${ageSeconds}s.`);
  if (bundle.freshness === "unknown") warnings.push("Projects could not establish source freshness for this bundle.");
  if (bundle.authority.availability === "unavailable") warnings.push("The Projects authority was unavailable when this bundle was produced.");
  if (bundle.links.todos.state === "partial" || bundle.links.conversations.state === "partial" || bundle.links.mementos.state === "partial") {
    warnings.push("One or more linked-system identities are partial.");
  }
  return warnings.slice(0, PROJECT_CONTEXT_MAX_WARNINGS);
}

function buildManagedBlock(bundle: ProjectContextBundleV1, body: string, eol: string): string {
  const revision = encodeURIComponent(bundle.revision);
  const begin = `<!-- ${PROJECT_CONTEXT_MANAGED_COMMENT} BEGIN id=${bundle.project.id} revision=${revision} hash=${bundle.hash} -->`;
  const end = `<!-- ${PROJECT_CONTEXT_MANAGED_COMMENT} END id=${bundle.project.id} revision=${revision} hash=${bundle.hash} -->`;
  return `${begin}${eol}${body.replace(/\r?\n/g, eol).trimEnd()}${eol}${end}`;
}

function parseManagedBlock(content: string, force: boolean): { block: ManagedBlock | null; forceRange: { start: number; end: number } | null } {
  const lines = linesWithOffsets(content);
  const markerLines = lines.filter((line) =>
    (
      line.text.includes(PROJECT_CONTEXT_MANAGED_COMMENT) ||
      /@hasna\/configs project context/i.test(line.text)
    ) && !line.text.includes(`${PROJECT_CONTEXT_MANAGED_COMMENT} fragment.`)
  );
  if (markerLines.length === 0) return { block: null, forceRange: null };

  const parsed = markerLines.map((line) => ({ ...line, marker: parseMarkerLine(line.text) }));
  const malformed = parsed.some((line) => line.marker === null);
  const starts = parsed.filter((line) => line.marker?.kind === "BEGIN");
  const ends = parsed.filter((line) => line.marker?.kind === "END");
  const structurallyInvalid = malformed || starts.length !== 1 || ends.length !== 1 || starts[0]!.start >= ends[0]!.start;
  if (structurallyInvalid) {
    if (!force) throw new ProjectContextError("MANAGED_BLOCK_INVALID", "managed project-context markers are duplicate, nested, malformed, or unbalanced");
    return {
      block: null,
      forceRange: {
        start: markerLines[0]!.start,
        end: lineContentEnd(markerLines[markerLines.length - 1]!),
      },
    };
  }

  const begin = starts[0]!;
  const end = ends[0]!;
  const a = begin.marker!;
  const b = end.marker!;
  if (a.id !== b.id || a.revision !== b.revision || a.hash !== b.hash) {
    if (!force) throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "managed project-context marker metadata is inconsistent");
    return { block: null, forceRange: { start: begin.start, end: lineContentEnd(end) } };
  }
  const nested = parsed.some((line) => line.start > begin.start && line.start < end.start);
  if (nested) {
    if (!force) throw new ProjectContextError("MANAGED_BLOCK_INVALID", "nested managed project-context markers are not supported");
    return { block: null, forceRange: { start: begin.start, end: lineContentEnd(end) } };
  }
  return {
    block: {
      start: begin.start,
      end: lineContentEnd(end),
      id: a.id,
      revision: a.revision,
      hash: a.hash,
      legacy: a.legacy || b.legacy,
    },
    forceRange: null,
  };
}

function parseMarkerLine(text: string): { kind: "BEGIN" | "END"; id: string; revision: string; hash: string; legacy: boolean } | null {
  const line = text.replace(/[\r\n]+$/, "");
  const canonical = line.match(/^<!-- Managed by @hasna\/configs project context (BEGIN|END) id=([A-Za-z0-9][A-Za-z0-9._:@+-]*) revision=([A-Za-z0-9%._~+-]+) hash=(sha256:[a-f0-9]{64}) -->$/);
  if (canonical) {
    try {
      const revision = decodeURIComponent(canonical[3]!);
      if (!revisionSchema.safeParse(revision).success) return null;
      return { kind: canonical[1] as "BEGIN" | "END", id: canonical[2]!, revision, hash: canonical[4]!, legacy: false };
    } catch {
      return null;
    }
  }
  const legacy = line.match(/^<!-- (BEGIN|END) @hasna\/configs project context id=([A-Za-z0-9][A-Za-z0-9._:@+-]*) revision=((?:rev-)?[0-9]+) hash=(sha256:[a-f0-9]{64}) -->$/);
  if (legacy) {
    return { kind: legacy[1] as "BEGIN" | "END", id: legacy[2]!, revision: legacy[3]!, hash: legacy[4]!, legacy: true };
  }
  return null;
}

function replaceOrAppendManagedBlock(
  content: string,
  block: string,
  parsed: ReturnType<typeof parseManagedBlock>,
  legacy: { start: number; end: number } | null,
): string {
  const range = parsed.block ?? parsed.forceRange ?? legacy;
  if (range) return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
  if (!content) return `${block}\n`;
  const eol = preferredEol(content);
  const separator = content.endsWith("\n") || content.endsWith("\r") ? eol : `${eol}${eol}`;
  return `${content}${separator}${block}${eol}`;
}

function findLegacyCodewithWorkspaceSection(
  workspaceRoot: string,
  runtime: ProjectContextRuntime,
  content: string | null,
  bundle: ProjectContextBundleV1,
): { start: number; end: number } | null {
  if (runtime !== "codewith" || !content) return null;
  const legacyManifestPath = runtimePaths(workspaceRoot, runtime).legacyManifest!;
  if (!existsSync(legacyManifestPath)) return null;
  const manifest = readJsonRecord(legacyManifestPath, workspaceRoot);
  if (!manifest || manifest["schema"] !== SESSION_RENDER_SCHEMA) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith session manifest is malformed or incompatible");
  }
  const sources = Array.isArray(manifest["sources"]) ? manifest["sources"] : [];
  const hasFdSource = sources.some((source) => isRecord(source) && typeof source["path"] === "string" && source["path"].startsWith("/dev/fd/"));
  if (!hasFdSource) return null;
  const files = Array.isArray(manifest["files"]) ? manifest["files"] : [];
  const codewith = files.find((file) => isRecord(file) && file["relativePath"] === "CODEWITH.md");
  if (!isRecord(codewith) || codewith["sha256"] !== sha256(content)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "legacy /dev/fd session manifest does not match CODEWITH.md");
  }
  const section = /^## Workspace\r?\n/gm.exec(content);
  if (!section) return null;
  const restStart = section.index + section[0].length;
  const next = /^## [^\r\n]+\r?\n/gm;
  next.lastIndex = restStart;
  const nextMatch = next.exec(content);
  const end = nextMatch?.index ?? content.length;
  const body = content.slice(section.index, end);
  if (!body.includes(".project.json") || !body.includes(bundle.project.id)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "legacy project section cannot be tied to the incoming canonical project ID");
  }
  return { start: section.index, end };
}

function assertRevisionOrdering(plan: ProjectContextPlan, force: boolean): void {
  const observations: Array<{ source: string; id: string; revision: string; hash: string }> = [];
  const manifest = readProjectContextManifest(plan.manifest_path, plan.workspace_root);
  if (manifest) {
    observations.push({
      source: "manifest",
      id: manifest.projectContext.projectId,
      revision: manifest.projectContext.revision,
      hash: manifest.projectContext.hash,
    });
    const fragmentEntry = manifest.files.find((file) => file.relativePath === PROJECT_CONTEXT_FRAGMENT_PATH);
    if (fragmentEntry && existsSync(plan.fragment_path)) {
      const actual = currentFileHash(plan.fragment_path, plan.workspace_root);
      if (actual !== fragmentEntry.sha256 && !fragmentMatchesBundle(plan.fragment_path, plan.bundle, plan.workspace_root) && !force) {
        throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "canonical project-context fragment changed outside Instructions");
      }
    }
  }
  const cache = readProjectContextCache(plan.cache_path, plan.workspace_root);
  if (cache) observations.push({ source: "cache", id: cache.project_id, revision: cache.revision, hash: cache.hash });
  if (plan.marker) observations.push({ source: "marker", id: plan.marker.id, revision: plan.marker.revision, hash: plan.marker.hash });

  for (const observation of observations) {
    if (observation.id !== plan.bundle.project.id) {
      if (!force) throw new ProjectContextError("PROJECT_CONTEXT_IDENTITY_CONFLICT", `${observation.source} belongs to another project`);
      continue;
    }
    const ordering = compareRevisions(plan.bundle.revision, observation.revision);
    if (ordering < 0) {
      throw new ProjectContextError("PROJECT_CONTEXT_REVISION_STALE", `incoming revision ${plan.bundle.revision} is older than ${observation.source} revision ${observation.revision}`);
    }
    if (ordering === 0 && plan.bundle.hash !== observation.hash) {
      throw new ProjectContextError("PROJECT_CONTEXT_REVISION_CONFLICT", `revision ${plan.bundle.revision} has a different hash than ${observation.source}`);
    }
  }
}

function buildCache(plan: ProjectContextPlan, now: Date): ProjectContextCache {
  return {
    schema: PROJECT_CONTEXT_CACHE_SCHEMA,
    cached_at: now.toISOString(),
    project_id: plan.bundle.project.id,
    revision: plan.bundle.revision,
    hash: plan.bundle.hash,
    bundle: plan.bundle,
  };
}

function buildManifest(plan: ProjectContextPlan, now: Date): ProjectContextManifest {
  const tool = manifestTool(plan.runtime);
  const files: ProjectContextManifest["files"] = [
    {
      path: plan.fragment_path,
      relativePath: PROJECT_CONTEXT_FRAGMENT_PATH,
      role: "fragment",
      sha256: sha256(plan.fragment),
      sourceIds: ["project-context-bundle"],
    },
    {
      path: plan.target_path,
      relativePath: plan.target_relative_path,
      role: "index",
      sha256: sha256(plan.target_content),
      sourceIds: ["project-context-bundle"],
    },
  ];
  return {
    schema: SESSION_RENDER_SCHEMA,
    kind: "project-context",
    tool,
    adapterMode: plan.native_imports ? "native-import" : "managed-block",
    profile: "project-context",
    sessionId: null,
    targetHome: plan.workspace_root,
    targetKind: "project-root",
    targetOwner: {
      kind: "project",
      tool,
      profile: "project-context",
      targetHome: plan.workspace_root,
      projectRoot: plan.workspace_root,
      ownedBy: "open-configs",
      canonicalOwner: "instructions",
      reason: "project context is emitted by Projects and written exclusively by Instructions",
    },
    writable: true,
    blocked: false,
    blockers: [],
    generatedAt: now.toISOString(),
    env: {},
    sourceHash: plan.bundle.hash,
    sources: [manifestSource(plan)],
    skippedSources: [],
    files,
    warnings: plan.warnings,
    projectContext: manifestProjectContext(plan),
    compatibility: manifestCompatibility(),
  };
}

function buildLegacyCompatibilityManifest(plan: ProjectContextPlan, now: Date): Record<string, unknown> | null {
  if (plan.runtime !== "codewith") return null;
  const legacyPath = runtimePaths(plan.workspace_root, plan.runtime).legacyManifest!;
  if (!existsSync(legacyPath)) return null;
  const targetHome = resolve(plan.workspace_root, ".codewith");
  const existing = readJsonRecord(legacyPath, plan.workspace_root);
  if (!existing || existing["schema"] !== SESSION_RENDER_SCHEMA || (existing["tool"] !== undefined && existing["tool"] !== "codewith")) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith session manifest is malformed or incompatible");
  }
  const sources = sanitizeLegacySources(existing["sources"])
    .filter((source) => source["id"] !== "project-context-bundle");
  sources.push(manifestSource(plan));
  const files = sanitizeLegacyFiles(existing["files"]);
  const targetIndexes = files.filter((file) => file["relativePath"] === "CODEWITH.md");
  if (targetIndexes.length > 1) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith manifest contains duplicate CODEWITH.md entries");
  }
  const previousSourceIds = targetIndexes[0]?.["sourceIds"] as string[] | undefined;
  const updatedTarget = {
    path: plan.target_path,
    relativePath: "CODEWITH.md",
    role: "index",
    sha256: sha256(plan.target_content),
    sourceIds: [...new Set([...(previousSourceIds ?? []), "project-context-bundle"])],
  };
  const targetOwner = isRecord(existing["targetOwner"]) ? existing["targetOwner"] : {};
  const allowedAdapterModes = new Set(["native-imports", "flattened-markdown", "cursor-mdc", "opencode-instructions", "antigravity-rules"]);
  const adapterMode = typeof existing["adapterMode"] === "string" && allowedAdapterModes.has(existing["adapterMode"])
    ? existing["adapterMode"]
    : plan.native_imports ? "native-imports" : "flattened-markdown";
  return {
    schema: SESSION_RENDER_SCHEMA,
    tool: "codewith",
    adapterMode,
    profile: safeLegacyMetadataString(existing["profile"], "project-context"),
    sessionId: existing["sessionId"] === null ? null : safeLegacyMetadataString(existing["sessionId"], null),
    targetHome,
    targetKind: existing["targetKind"] === "project-root" ? "project-root" : "session-home",
    targetOwner: {
      kind: targetOwner["kind"] === "project" ? "project" : "provider-profile",
      tool: "codewith",
      profile: safeLegacyMetadataString(targetOwner["profile"], safeLegacyMetadataString(existing["profile"], "project-context")),
      targetHome,
      projectRoot: plan.workspace_root,
      ownedBy: "open-configs",
      canonicalOwner: "instructions",
      reason: "legacy Codewith session manifest retained for additive Instructions project-context compatibility",
    },
    writable: true,
    blocked: false,
    blockers: [],
    generatedAt: now.toISOString(),
    env: {},
    sourceHash: sha256(stableStringify({ previous: typeof existing["sourceHash"] === "string" ? existing["sourceHash"] : null, projectContext: plan.bundle.hash })),
    sources,
    skippedSources: sanitizeLegacySkippedSources(existing["skippedSources"]),
    files: [...files.filter((file) => file["relativePath"] !== "CODEWITH.md"), updatedTarget],
    warnings: plan.warnings,
    projectContext: manifestProjectContext(plan),
    compatibility: manifestCompatibility(),
  };
}

function sanitizeLegacySources(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !isRecord(entry))) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith source inventory is malformed");
  }
  return value.map((entry, index) => {
    const source = entry as Record<string, unknown>;
    const id = safeLegacyMetadataString(source["id"], `legacy-source-${index}`);
    const layer = typeof source["layer"] === "string" && SESSION_INSTRUCTION_LAYERS.includes(source["layer"] as typeof SESSION_INSTRUCTION_LAYERS[number])
      ? source["layer"]
      : "local";
    const merge = source["merge"] === "replace" ? "replace" : "append";
    const owner = isRecord(source["owner"])
      ? {
        kind: safeLegacyMetadataString(source["owner"]["kind"], "unknown"),
        id: safeLegacyMetadataString(source["owner"]["id"], id),
      }
      : null;
    const sourcePaths = Array.isArray(source["sourcePaths"])
      ? source["sourcePaths"].slice(0, 64).filter(isRecord).map((item) => ({
        path: safeLegacyMetadataString(item["path"], "unknown"),
        ...(typeof item["editable"] === "boolean" ? { editable: item["editable"] } : {}),
        ...(typeof item["required"] === "boolean" ? { required: item["required"] } : {}),
        ...(typeof item["hash"] === "string" ? { hash: safeLegacyMetadataString(item["hash"], "") } : {}),
      }))
      : [];
    const rules = Array.isArray(source["rules"])
      ? source["rules"].slice(0, 64).filter(isRecord).map((rule, ruleIndex) => ({
        id: safeLegacyMetadataString(rule["id"], `${id}-rule-${ruleIndex}`),
        label: safeLegacyMetadataString(rule["label"], `${id} rule ${ruleIndex + 1}`),
        path: safeLegacyMetadataString(rule["path"], "unknown"),
        globs: safeLegacyStringArray(rule["globs"], 64),
        hash: typeof rule["hash"] === "string" ? safeLegacyMetadataString(rule["hash"], null) : null,
      }))
      : [];
    return {
      id,
      label: safeLegacyMetadataString(source["label"], id),
      layer,
      merge,
      order: Number.isSafeInteger(source["order"]) ? Number(source["order"]) : index,
      path: typeof source["path"] === "string" ? safeLegacyMetadataString(source["path"], null) : null,
      targetProviders: safeLegacyStringArray(source["targetProviders"], 16),
      owner,
      sourcePaths,
      hash: typeof source["hash"] === "string" ? safeLegacyMetadataString(source["hash"], null) : null,
      nonOverridable: source["nonOverridable"] === true,
      replacementScope: typeof source["replacementScope"] === "string" ? safeLegacyMetadataString(source["replacementScope"], null) : null,
      rules,
      provenance: null,
    };
  });
}

function sanitizeLegacyFiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !isRecord(entry))) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith file inventory is malformed");
  }
  return value.map((entry) => {
    const file = entry as Record<string, unknown>;
    const relativePath = safeLegacyMetadataString(file["relativePath"], "");
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("/../")) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith file inventory contains an unsafe relative path");
    }
    const sha = safeLegacyMetadataString(file["sha256"], "");
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith file inventory contains an invalid hash");
    }
    const role = typeof file["role"] === "string" && ["index", "fragment", "rule", "config", "manifest"].includes(file["role"])
      ? file["role"]
      : "index";
    return {
      path: safeLegacyMetadataString(file["path"], ""),
      relativePath,
      role,
      sha256: sha,
      sourceIds: safeLegacyStringArray(file["sourceIds"], 64),
    };
  });
}

function sanitizeLegacySkippedSources(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).filter(isRecord).map((entry, index) => ({
    id: safeLegacyMetadataString(entry["id"], `skipped-${index}`),
    label: safeLegacyMetadataString(entry["label"], `Skipped source ${index + 1}`),
    targetProviders: safeLegacyStringArray(entry["targetProviders"], 16),
    reason: safeLegacyMetadataString(entry["reason"], "unknown"),
  }));
}

function safeLegacyStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith manifest contains malformed string metadata");
  }
  return value
    .map((item) => safeLegacyMetadataString(item, ""))
    .filter((item): item is string => item.length > 0);
}

function safeLegacyMetadataString(value: unknown, fallback: string): string;
function safeLegacyMetadataString(value: unknown, fallback: null): string | null;
function safeLegacyMetadataString(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !isSafeSingleLine(value)) return fallback;
  return value;
}

function manifestSource(plan: ProjectContextPlan): ProjectContextManifest["sources"][number] {
  return {
    id: "project-context-bundle",
    label: "Project Context Bundle",
    layer: "repo",
    merge: "replace",
    order: 0,
    path: plan.cache_path,
    targetProviders: [manifestTool(plan.runtime)],
    owner: { kind: "package", id: "@hasna/projects" },
    sourcePaths: [],
    hash: plan.bundle.hash,
    nonOverridable: true,
    replacementScope: "project-context",
    rules: [],
    provenance: {
      schema: PROJECT_CONTEXT_SCHEMA,
      projectId: plan.bundle.project.id,
      revision: plan.bundle.revision,
      hash: plan.bundle.hash,
    },
  };
}

function manifestProjectContext(plan: ProjectContextPlan): ProjectContextManifest["projectContext"] {
  return {
    schema: PROJECT_CONTEXT_SCHEMA,
    projectId: plan.bundle.project.id,
    revision: plan.bundle.revision,
    hash: plan.bundle.hash,
    status: plan.status,
    ageSeconds: plan.age_seconds,
    cachePath: plan.cache_path,
    fragmentPath: plan.fragment_path,
  };
}

function manifestCompatibility(): ProjectContextManifest["compatibility"] {
  return {
    legacyPackage: LEGACY_CONFIGS_PACKAGE,
    legacyVersion: LEGACY_CONFIGS_COMPAT_VERSION,
    legacyExecutable: LEGACY_CONFIGS_EXECUTABLE,
    manifestSchema: SESSION_RENDER_SCHEMA,
    managedBy: "@hasna/configs",
    ownedBy: "open-configs",
    canonicalOwner: "instructions",
  };
}

function writeMetadataSnapshot(plan: ProjectContextPlan, now: Date): string | null {
  const previous = readProjectContextManifest(plan.manifest_path, plan.workspace_root);
  if (!previous || (previous.projectContext.revision === plan.bundle.revision && previous.projectContext.hash === plan.bundle.hash)) return null;
  const snapshotDir = resolve(plan.workspace_root, ...PROJECT_CONTEXT_SNAPSHOT_DIR.split("/"));
  ensureSafeDirectory(snapshotDir, plan.workspace_root, 0o700);
  const snapshotPath = resolve(snapshotDir, `${safeFilename(previous.projectContext.revision)}-${previous.projectContext.hash.slice(-12)}.json`);
  const snapshot = {
    schema: "hasna.configs.session-render-snapshot/v1",
    kind: "project-context-metadata",
    createdAt: now.toISOString(),
    projectId: previous.projectContext.projectId,
    revision: previous.projectContext.revision,
    hash: previous.projectContext.hash,
    status: previous.projectContext.status,
    files: previous.files.map((file) => ({ relativePath: file.relativePath, role: file.role, sha256: file.sha256 })),
  };
  atomicWriteFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, plan.workspace_root, 0o600);
  return snapshotPath;
}

function readProjectContextManifest(path: string, workspaceRoot: string): ProjectContextManifestObservation | null {
  if (!existsSync(path)) return null;
  const record = readJsonRecord(path, workspaceRoot);
  const result = storedManifestObservationSchema.safeParse(record);
  if (!result.success) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "existing project-context manifest is malformed");
  }
  return {
    projectContext: result.data.projectContext,
    files: result.data.files,
  };
}

function readProjectContextCache(path: string, workspaceRoot: string): ProjectContextCache | null {
  if (!existsSync(path)) return null;
  const record = readJsonRecord(path, workspaceRoot);
  const result = projectContextCacheSchema.safeParse(record);
  if (!result.success) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", "cache is malformed or incompatible");
  }
  const bundle = parseProjectContextBundle(result.data.bundle);
  if (
    result.data.project_id !== bundle.project.id ||
    result.data.revision !== bundle.revision ||
    result.data.hash !== bundle.hash
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", "cache metadata does not match its bundle");
  }
  return { ...result.data, bundle };
}

function readJsonRecord(path: string, workspaceRoot: string): Record<string, unknown> | null {
  const content = readUtf8RegularFile(path, workspaceRoot, PROJECT_CONTEXT_MAX_INPUT_BYTES * 4);
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWriteFile(
  path: string,
  content: string,
  workspaceRoot: string,
  defaultMode: number,
  expectedHash?: string | null,
): void {
  const dir = resolve(path, "..");
  ensureSafeDirectory(dir, workspaceRoot, 0o700);
  assertNoSymlinkSegments(workspaceRoot, path);
  const previousMode = existsSync(path) ? statSync(path).mode & 0o777 : defaultMode;
  const tempPath = join(dir, `.project-context-${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, previousMode);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (expectedHash !== undefined && currentFileHash(path, workspaceRoot) !== expectedHash) {
      throw new ProjectContextHashRace(`managed path changed before replacement: ${relativePosix(workspaceRoot, path)}`);
    }
    renameSync(tempPath, path);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(tempPath)) rmSync(tempPath);
    throw error;
  }
}

function acquireWorkspaceLock(workspaceRoot: string, lockPath: string, afterOpen?: () => void): WorkspaceLock {
  const lockDirectory = resolve(lockPath, "..");
  ensureSafeDirectory(lockDirectory, workspaceRoot, 0o700);
  assertNoSymlinkSegments(workspaceRoot, lockPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tempPath = join(lockDirectory, `.project-context-lock-${randomUUID()}.tmp`);
    let fd: number | null = null;
    let openedIdentity: { dev: number; ino: number } | null = null;
    let linked = false;
    try {
      fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const opened = fstatSync(fd);
      openedIdentity = { dev: opened.dev, ino: opened.ino };
      const content = `${JSON.stringify({
        schema: "hasna.instructions.project-context-lock/v1",
        pid: process.pid,
        nonce: randomUUID(),
        created_at: new Date().toISOString(),
      })}\n`;
      writeFileSync(fd, content);
      fsyncSync(fd);
      linkSync(tempPath, lockPath);
      linked = true;
      fsyncDirectory(lockDirectory);
      closeSync(fd);
      fd = null;
      rmSync(tempPath);
      fsyncDirectory(lockDirectory);
      fd = openSync(lockPath, constants.O_RDONLY);
      const held = fstatSync(fd);
      if (held.dev !== openedIdentity.dev || held.ino !== openedIdentity.ino) {
        throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during initialization");
      }
      afterOpen?.();
      return { fd, contentHash: sha256(content) };
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      if (existsSync(tempPath)) {
        try { rmSync(tempPath); } catch { /* leave an unreferenced temp for later cleanup */ }
      }
      if (linked && openedIdentity) removeOwnedLockByInode(lockPath, openedIdentity);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && removeStaleWorkspaceLock(lockPath, workspaceRoot)) continue;
      throw new ProjectContextError("PROJECT_CONTEXT_LOCKED", "another renderer holds the workspace project-context lock");
    }
  }
  throw new ProjectContextError("PROJECT_CONTEXT_LOCKED", "workspace project-context lock could not be acquired");
}

function removeOwnedLockByInode(lockPath: string, identity: { dev: number; ino: number }): void {
  try {
    if (!existsSync(lockPath)) return;
    const current = lstatSync(lockPath);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    rmSync(lockPath);
    fsyncDirectory(resolve(lockPath, ".."));
  } catch {
    // Leave an uncertain lock in place rather than deleting another owner's file.
  }
}

function removeStaleWorkspaceLock(lockPath: string, workspaceRoot: string): boolean {
  let content: string;
  try {
    content = readUtf8RegularFile(lockPath, workspaceRoot, 2_048);
  } catch {
    return false;
  }
  let pid: number | null = null;
  try {
    const value = JSON.parse(content) as unknown;
    if (isRecord(value) && Number.isSafeInteger(value["pid"]) && Number(value["pid"]) > 0) pid = Number(value["pid"]);
  } catch {
    return removeMalformedStaleWorkspaceLock(lockPath, content);
  }
  if (pid === null) return removeMalformedStaleWorkspaceLock(lockPath, content);
  if (processIsAlive(pid)) return false;
  const expected = sha256(content);
  if (currentFileHash(lockPath, workspaceRoot) !== expected) return false;
  rmSync(lockPath);
  fsyncDirectory(resolve(lockPath, ".."));
  return true;
}

function removeMalformedStaleWorkspaceLock(lockPath: string, content: string): boolean {
  try {
    const observed = lstatSync(lockPath);
    if (observed.isSymbolicLink() || !observed.isFile() || Date.now() - observed.mtimeMs < 5 * 60 * 1_000) return false;
    if (sha256(readFileSync(lockPath, "utf8")) !== sha256(content)) return false;
    removeOwnedLockByInode(lockPath, { dev: observed.dev, ino: observed.ino });
    return !existsSync(lockPath);
  } catch {
    return false;
  }
}

function assertWorkspaceLockHeld(lockPath: string, lock: WorkspaceLock, workspaceRoot: string): void {
  if (!existsSync(lockPath) || currentFileHash(lockPath, workspaceRoot) !== lock.contentHash) {
    throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during render");
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseWorkspaceLock(lockPath: string, lock: WorkspaceLock, workspaceRoot: string): void {
  try {
    closeSync(lock.fd);
  } finally {
    try {
      if (existsSync(lockPath) && currentFileHash(lockPath, workspaceRoot) === lock.contentHash) {
        rmSync(lockPath);
        if (existsSync(resolve(lockPath, ".."))) fsyncDirectory(resolve(lockPath, ".."));
      }
    } catch {
      // A replaced or malformed lock is not ours to remove. Leave it fail-closed.
    }
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureSafeDirectory(path: string, workspaceRoot: string, mode: number): void {
  const rel = relative(workspaceRoot, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new ProjectContextError("PROJECT_CONTEXT_PATH_ESCAPE", "managed directory escapes the workspace root");
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let current = workspaceRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", `managed path uses a symlink: ${current}`);
      if (!statSync(current).isDirectory()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", `managed path is not a directory: ${current}`);
    } else {
      mkdirSync(current, { mode });
      fsyncDirectory(resolve(current, ".."));
    }
  }
}

function validateLinkConsistency(bundle: ProjectContextBundleV1): void {
  const todos = bundle.links.todos;
  const todosCount = Number(todos.project_id !== null) + Number(todos.task_list_id !== null);
  if (
    (todos.state === "linked" && todosCount !== 2) ||
    (todos.state === "partial" && todosCount !== 1) ||
    (todos.state === "unlinked" && todosCount !== 0)
  ) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "Todos link state is inconsistent with its explicit IDs");
  validateSingleLink("Conversations", bundle.links.conversations.state, bundle.links.conversations.channel);
  const mementosCount = Number(bundle.links.mementos.project_id !== null) + Number(bundle.links.mementos.scope !== null);
  if (
    (bundle.links.mementos.state === "linked" && mementosCount !== 2) ||
    (bundle.links.mementos.state === "partial" && mementosCount !== 1) ||
    (bundle.links.mementos.state === "unlinked" && mementosCount !== 0)
  ) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "Mementos link state is inconsistent with its explicit IDs");
}

function validateSingleLink(label: string, state: "linked" | "partial" | "unlinked", value: string | null): void {
  if (state === "linked" && value === null) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} linked state requires an identifier`);
  if (state === "unlinked" && value !== null) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} unlinked state forbids an identifier`);
  if (state === "partial" && value === null) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} partial state requires its available identifier`);
}

function validateCommands(bundle: ProjectContextBundleV1): void {
  for (const command of bundle.commands) {
    const [executable, subcommand, projectId, format, ...rest] = command.argv;
    if (
      executable !== "projects" ||
      subcommand !== command.name ||
      projectId !== bundle.project.id ||
      format !== "--json" ||
      rest.length !== 0
    ) {
      throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "bundle contains a command outside the fixed argv allowlist");
    }
  }
}

function validateIdentityConsistency(bundle: ProjectContextBundleV1): void {
  if (bundle.links.mementos.project_id?.startsWith("wks_") && bundle.links.mementos.project_id !== bundle.project.id) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "Mementos project identity differs from the canonical project ID");
  }
  if (bundle.project.status !== "active" && bundle.resolution.create_allowed) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "archived or deleted projects cannot allow creation");
  }
}

function rejectCredentialLikeBundle(bundle: ProjectContextBundleV1): void {
  const encoded = JSON.stringify(bundle);
  const credentialShape = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]|\$\{|https?:\/\//i;
  if (credentialShape.test(encoded) || scanSecrets(encoded, "text").length > 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_SECRET_REJECTED", "credential-like or URL content is forbidden in project context");
  }
}

function scanGeneratedContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > PROJECT_CONTEXT_MAX_RENDERED_BYTES) {
    throw new ProjectContextError("PROJECT_CONTEXT_RENDER_TOO_LARGE", "generated project context exceeds 4 KiB");
  }
  if (Math.ceil(content.length / 4) > PROJECT_CONTEXT_MAX_APPROX_TOKENS) {
    throw new ProjectContextError("PROJECT_CONTEXT_RENDER_TOO_LARGE", "generated project context exceeds the approximate token budget");
  }
  if (scanSecrets(content, "markdown").length > 0 || /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]|https?:\/\//i.test(content)) {
    throw new ProjectContextError("PROJECT_CONTEXT_SECRET_REJECTED", "generated project context contains credential-like content");
  }
}

function runtimePaths(workspaceRoot: string, runtime: ProjectContextRuntime): {
  target: string;
  fragment: string;
  manifest: string;
  cache: string;
  legacyManifest: string | null;
} {
  const relativeTarget = runtime === "claude" ? "CLAUDE.md" : runtime === "codewith" ? ".codewith/CODEWITH.md" : "AGENTS.md";
  return {
    target: resolve(workspaceRoot, ...relativeTarget.split("/")),
    fragment: resolve(workspaceRoot, ...PROJECT_CONTEXT_FRAGMENT_PATH.split("/")),
    manifest: resolve(workspaceRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")),
    cache: resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/")),
    legacyManifest: runtime === "codewith" ? resolve(workspaceRoot, ".codewith", ".hasna", "session-render-manifest.json") : null,
  };
}

function assertCodewithTargetIsConsumed(workspaceRoot: string, runtime: ProjectContextRuntime): void {
  if (runtime !== "codewith") return;
  const override = resolve(workspaceRoot, ".codewith", "CODEWITH.override.md");
  if (!existsSync(override)) return;
  assertNoSymlinkSegments(workspaceRoot, override);
  if (!lstatSync(override).isFile()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "Codewith override is not a regular file");
  throw new ProjectContextError("PROJECT_CONTEXT_SHADOWED", ".codewith/CODEWITH.override.md shadows .codewith/CODEWITH.md");
}

function assertSafeWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "workspace root must be absolute");
  const normalized = resolve(path);
  if (normalized === parse(normalized).root) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "workspace root cannot be the filesystem root");
  if (!existsSync(normalized) || !lstatSync(normalized).isDirectory()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "workspace root must be an existing directory");
  assertNoSymlinkAncestors(normalized);
  if (lstatSync(normalized).isSymbolicLink()) throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", "workspace root cannot be a symlink");
  return normalized;
}

function assertNoSymlinkSegments(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new ProjectContextError("PROJECT_CONTEXT_PATH_ESCAPE", "managed path escapes workspace root");
  }
  let current = root;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", `managed path uses a symlink: ${current}`);
    }
  }
}

function assertNoSymlinkAncestors(path: string): void {
  const normalized = resolve(path);
  let current = parse(normalized).root;
  for (const segment of relative(current, normalized).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", `workspace ancestor is a symlink: ${current}`);
  }
}

function readUtf8RegularFile(path: string, workspaceRoot: string, maxBytes = 256 * 1024): string {
  assertNoSymlinkSegments(workspaceRoot, path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", `managed path is not a regular file: ${path}`);
  if (stat.size > maxBytes) throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `managed input exceeds ${maxBytes} bytes`);
  return readFileSync(path, "utf8");
}

function currentFileHash(path: string, workspaceRoot: string): string | null {
  if (!existsSync(path)) return null;
  return sha256(readUtf8RegularFile(path, workspaceRoot));
}

function hashesStillMatch(expected: Map<string, string | null>, workspaceRoot: string): boolean {
  for (const [path, hash] of expected) {
    if (currentFileHash(path, workspaceRoot) !== hash) return false;
  }
  return true;
}

function fragmentMatchesBundle(path: string, bundle: ProjectContextBundleV1, workspaceRoot: string): boolean {
  const content = readUtf8RegularFile(path, workspaceRoot);
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  return first.includes(`id=${bundle.project.id}`) && first.includes(`revision=${bundle.revision}`) && first.includes(`hash=${bundle.hash}`);
}

function durableSourcePath(path: string | undefined, workspaceRoot: string): string {
  if (!path || path.startsWith("/dev/fd/")) return resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/"));
  const normalized = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
  if (normalized.startsWith("/dev/fd/")) return resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/"));
  return normalized;
}

function compareRevisions(incoming: string, previous: string): number {
  const a = revisionKey(incoming);
  const b = revisionKey(previous);
  if (!a || !b || a.kind !== b.kind) {
    throw new ProjectContextError("PROJECT_CONTEXT_REVISION_INCOMPARABLE", "project-context revisions use incompatible ordering schemes");
  }
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

function revisionKey(value: string): { kind: "sequence" | "timestamp"; value: bigint } | null {
  const sequence = value.match(/^(?:rev-)?([0-9]+)$/);
  if (sequence) return { kind: "sequence", value: BigInt(sequence[1]!) };
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) return null;
  const normalized = value.includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? value.replace(" ", "T")
    : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? { kind: "timestamp", value: BigInt(timestamp) } : null;
}

function normalizeMaxStaleAge(value: number | undefined): number {
  const result = value ?? 3_600;
  if (!Number.isInteger(result) || result < 1 || result > 7 * 24 * 3_600) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "max stale age must be an integer between 1 second and 7 days");
  }
  return result;
}

function manifestTool(runtime: ProjectContextRuntime): "claude" | "codewith" | "codex" {
  return runtime === "agents" ? "codex" : runtime;
}

function runtimeUsesNativeImports(runtime: ProjectContextRuntime, codewithNativeImports: boolean | undefined): boolean {
  if (runtime === "claude") return true;
  if (runtime === "agents") return false;
  return codewithNativeImports === true || process.env[CODEWITH_NATIVE_IMPORTS_ENV] === "1" || process.env[CODEWITH_NATIVE_IMPORTS_ENV] === "true";
}

function ageInSeconds(generatedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(generatedAt)) / 1_000));
}

function statusLabel(status: ProjectContextStatus, ageSeconds: number): string {
  if (status === "fresh") return "fresh";
  if (status === "stale-cache") return `stale cache (age ${ageSeconds}s)`;
  return `stale source (age ${ageSeconds}s)`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function inlineNullable(value: string | null): string {
  return value === null ? "`none`" : inlineCode(value);
}

function inlineCode(value: string): string {
  const encoded = JSON.stringify(value).slice(1, -1).replace(/`/g, "\\u0060");
  return `\`${encoded}\``;
}

function escapeText(value: string): string {
  return value.replace(/[<>]/g, "");
}

function preferredEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function linesWithOffsets(content: string): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = [];
  const re = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[0] === "" && match.index === content.length) break;
    result.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

function lineContentEnd(line: { text: string; start: number; end: number }): number {
  if (line.text.endsWith("\r\n")) return line.end - 2;
  if (line.text.endsWith("\n") || line.text.endsWith("\r")) return line.end - 1;
  return line.end;
}

function isSafeSingleLine(value: string): boolean {
  return !/[\u0000-\u001f\u007f\r\n]/.test(value) && !value.includes("<!--") && !value.includes("-->") && !value.includes("`");
}

function isSafeCommandArgument(value: string): boolean {
  return (
    (/^[A-Za-z0-9_./:@+=,-]+$/.test(value) && !value.includes("://") && !value.startsWith("-")) ||
    /^--[a-z][a-z0-9-]*$/.test(value)
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function removeHashForFingerprint(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "hash") continue;
    copy[key] = item;
  }
  return copy;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
