import { createHash, randomUUID } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
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
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { z } from "zod";
import { scanSecrets } from "./redact.js";
import type { SessionRenderFile, SessionRenderManifest, SessionRenderMode, SessionRenderTool } from "./session-render.js";
import { CODEWITH_NATIVE_IMPORTS_ENV, SESSION_INSTRUCTION_LAYERS, SESSION_RENDER_SCHEMA } from "./session-render-contract.js";

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
const SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const PROJECT_CONTEXT_LOCK_STALE_MS = 5 * 60 * 1_000;
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
const isoTimestamp = z.string().min(20).max(40).refine(isStrictIsoTimestamp, "must be a strict ISO timestamp with timezone");
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
  tool: z.enum(["claude", "codewith", "codex"]),
  adapterMode: z.enum(["native-import", "managed-block"]),
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
    atomic_exchange_unavailable?: boolean;
    before_stale_lock_remove?: (lockPath: string) => void;
    before_compare?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    after_fragment?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    before_target_install?: (context: { attempt: number; plan: ProjectContextPlan; temp_path: string }) => void;
    after_target_exchange?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
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
  tool: "claude" | "codewith" | "codex";
  adapterMode: "native-import" | "managed-block";
  projectContext: z.infer<typeof storedManifestProjectContextSchema>;
  files: Array<z.infer<typeof storedManifestFileSchema>>;
}

export interface ProjectContextSessionRenderInput {
  tool: SessionRenderTool;
  adapter_mode: SessionRenderMode;
  target_home: string;
  project_root?: string;
  files: SessionRenderFile[];
}

export interface ProjectContextSessionRenderComposition {
  files: SessionRenderFile[];
  source: SessionRenderManifest["sources"][number];
  project_context: NonNullable<SessionRenderManifest["projectContext"]>;
  compatibility: Record<string, unknown>;
  guard: ProjectContextSessionGuard;
}

export interface ProjectContextSessionGuard {
  workspace_root: string;
  runtime: ProjectContextRuntime;
  observed_hashes: Array<{
    path: string;
    sha256: string | null;
  }>;
}

interface WorkspaceLock {
  fd: number;
  contentHash: string;
  identity: { dev: number; ino: number };
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
  for (const path of [paths.fragment, paths.target, paths.cache, paths.manifest, paths.sessionManifest]) {
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

export function composeProjectContextSessionRender(
  input: ProjectContextSessionRenderInput,
): ProjectContextSessionRenderComposition | null {
  const guard = observeProjectContextSessionGuard(input);
  if (guard === null) return null;
  const { runtime, workspace_root: workspaceRoot, observed_hashes: observedHashes } = guard;
  const paths = runtimePaths(workspaceRoot, runtime);
  if (!existsSync(paths.manifest)) return null;
  assertCodewithTargetIsConsumed(workspaceRoot, runtime);

  const manifest = readProjectContextManifest(paths.manifest, workspaceRoot);
  if (!manifest) return null;
  if (manifest.tool !== manifestTool(runtime)) return null;
  const nativeImports = input.adapter_mode === "native-imports";
  const expectedAdapterMode = nativeImports ? "native-import" : "managed-block";
  if (manifest.adapterMode !== expectedAdapterMode) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ADAPTER_MISMATCH",
      "the active project-context adapter mode differs from the selected session runtime mode",
    );
  }
  const targetEntries = manifest.files.filter((file) => file.role === "index");
  const fragmentEntry = manifest.files.find((file) => file.relativePath === PROJECT_CONTEXT_FRAGMENT_PATH && file.role === "fragment");
  if (
    targetEntries.length !== 1 ||
    targetEntries[0]!.path !== paths.target ||
    fragmentEntry?.path !== paths.fragment
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "project-context manifest paths do not match the selected runtime workspace");
  }

  const cache = readProjectContextCache(paths.cache, workspaceRoot);
  if (!cache) throw new ProjectContextError("PROJECT_CONTEXT_CACHE_MISSING", "durable project-context cache is missing");
  if (
    cache.project_id !== manifest.projectContext.projectId ||
    cache.revision !== manifest.projectContext.revision ||
    cache.hash !== manifest.projectContext.hash
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "project-context manifest and durable cache identities differ");
  }
  if (currentFileHash(paths.fragment, workspaceRoot) !== fragmentEntry.sha256 || !fragmentMatchesBundle(paths.fragment, cache.bundle, workspaceRoot)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "canonical project-context fragment differs from its durable manifest");
  }
  const fragment = readUtf8RegularFile(paths.fragment, workspaceRoot, PROJECT_CONTEXT_MAX_RENDERED_BYTES);
  scanGeneratedContent(fragment);

  if (!existsSync(paths.target)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "project-context provider target is missing while durable context is active");
  }
  const currentTarget = readUtf8RegularFile(paths.target, workspaceRoot);
  const currentMarkers = parseManagedBlock(currentTarget, false);
  if (!currentMarkers.block) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "project-context provider target lost its managed block");
  }
  if (
    currentMarkers.block.id !== cache.project_id ||
    currentMarkers.block.revision !== cache.revision ||
    currentMarkers.block.hash !== cache.hash
  ) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "project-context provider markers differ from the durable cache");
  }

  const plannedIndexes = input.files.filter((file) => file.role === "index" && resolve(file.path) === paths.target);
  if (plannedIndexes.length !== 1) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "session renderer does not own the selected project-context provider target");
  }
  const index = plannedIndexes[0]!;
  const baseMarkers = parseManagedBlock(index.content, false);
  const body = nativeImports
    ? `@${runtime === "codewith" ? "../" : ""}${PROJECT_CONTEXT_FRAGMENT_PATH}`
    : fragment.trimEnd();
  const managedBlock = buildManagedBlock(cache.bundle, body, preferredEol(index.content));
  scanGeneratedContent(managedBlock);
  const content = ensureTrailingNewline(replaceOrAppendManagedBlock(index.content, managedBlock, baseMarkers, null));
  const files = input.files.map((file) => file === index
    ? {
      ...file,
      content,
      sha256: sha256(content),
      sourceIds: [...new Set([...file.sourceIds, "project-context-bundle"])],
    }
    : file);
  if (observedHashes.some((observed) => currentFileHash(observed.path, workspaceRoot) !== observed.sha256)) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_SESSION_STALE",
      "durable project context changed while the session plan was being created; create a fresh session render plan",
    );
  }

  return {
    files,
    source: projectContextManifestSource(paths.cache, runtime, cache.bundle),
    project_context: {
      ...manifest.projectContext,
    },
    compatibility: manifestCompatibility(),
    guard,
  };
}

export function observeProjectContextSessionGuard(
  input: Pick<ProjectContextSessionRenderInput, "tool" | "target_home" | "project_root">,
): ProjectContextSessionGuard | null {
  const runtime = projectContextRuntimeForSessionTool(input.tool);
  if (runtime === null) return null;
  const workspaceRoot = projectContextWorkspaceForSession(input, runtime);
  if (workspaceRoot === null) return null;
  const paths = runtimePaths(workspaceRoot, runtime);
  return {
    workspace_root: workspaceRoot,
    runtime,
    observed_hashes: projectContextSessionGuardPaths(paths, runtime)
      .map((path) => ({ path, sha256: currentFileHash(path, workspaceRoot) })),
  };
}

export function withProjectContextSessionGuard<T>(
  guard: ProjectContextSessionGuard | undefined,
  action: () => T,
  options: { dry_run?: boolean } = {},
): T {
  if (!guard) return action();
  const validated = validateProjectContextSessionGuard(guard);
  const verify = () => {
    for (const observed of validated.observed_hashes) {
      if (currentFileHash(observed.path, validated.workspace_root) !== observed.sha256) {
        throw new ProjectContextError(
          "PROJECT_CONTEXT_SESSION_STALE",
          "durable project context changed after the session plan was created; create a fresh session render plan",
        );
      }
    }
  };
  if (options.dry_run) {
    verify();
    return action();
  }

  const lockPath = resolve(validated.workspace_root, ...PROJECT_CONTEXT_LOCK_PATH.split("/"));
  const lock = acquireWorkspaceLock(validated.workspace_root, lockPath);
  try {
    verify();
    assertWorkspaceLockHeld(lockPath, lock, validated.workspace_root);
    return action();
  } finally {
    releaseWorkspaceLock(lockPath, lock, validated.workspace_root);
  }
}

function validateProjectContextSessionGuard(guard: ProjectContextSessionGuard): ProjectContextSessionGuard {
  const workspaceRoot = assertSafeWorkspaceRoot(guard.workspace_root);
  if (!(["claude", "codewith", "agents"] as const).includes(guard.runtime)) {
    throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard has an invalid runtime");
  }
  const paths = runtimePaths(workspaceRoot, guard.runtime);
  const allowedPaths = new Set(projectContextSessionGuardPaths(paths, guard.runtime));
  if (!Array.isArray(guard.observed_hashes) || guard.observed_hashes.length !== allowedPaths.size) {
    throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard has an incomplete hash inventory");
  }
  const observedPaths = new Set<string>();
  const observedHashes = guard.observed_hashes.map((observed) => {
    if (!isRecord(observed) || typeof observed.path !== "string") {
      throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard contains malformed hash metadata");
    }
    const path = resolve(observed.path);
    if (!allowedPaths.has(path) || observedPaths.has(path)) {
      throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard contains an unexpected or duplicate path");
    }
    if (observed.sha256 !== null && (typeof observed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(observed.sha256))) {
      throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard contains an invalid hash");
    }
    observedPaths.add(path);
    return { path, sha256: observed.sha256 };
  });
  if (observedPaths.size !== allowedPaths.size) {
    throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard does not cover every durable context path");
  }
  return {
    workspace_root: workspaceRoot,
    runtime: guard.runtime,
    observed_hashes: observedHashes,
  };
}

export function applyProjectContext(options: ProjectContextApplyOptions): ProjectContextApplyResult {
  const workspaceRoot = assertSafeWorkspaceRoot(options.workspace_root);
  const now = options.now ?? new Date();
  const lockPath = resolve(workspaceRoot, ...PROJECT_CONTEXT_LOCK_PATH.split("/"));
  const lock = options.dry_run
    ? null
    : acquireWorkspaceLock(
      workspaceRoot,
      lockPath,
      options.test_hooks?.after_lock_open,
      options.test_hooks?.before_stale_lock_remove,
    );
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
      const sessionManifest = buildSessionCompatibilityManifest(plan, now);
      const sessionOutput = {
        path: runtimePaths(workspaceRoot, plan.runtime).sessionManifest,
        content: `${JSON.stringify(sessionManifest, null, 2)}\n`,
      };
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
        atomicWriteFile(
          plan.fragment_path,
          plan.fragment,
          workspaceRoot,
          0o644,
          expectedPlanHash(plan, plan.fragment_path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
        );
        options.test_hooks?.after_fragment?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        atomicWriteFile(
          plan.target_path,
          plan.target_content,
          workspaceRoot,
          0o644,
          expectedPlanHash(plan, plan.target_path),
          () => options.test_hooks?.after_target_exchange?.({ attempt, plan }),
          options.test_hooks?.atomic_exchange_unavailable,
          (tempPath) => options.test_hooks?.before_target_install?.({ attempt, plan, temp_path: tempPath }),
        );
        options.test_hooks?.after_target?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        atomicWriteFile(
          plan.cache_path,
          cacheContent,
          workspaceRoot,
          0o600,
          expectedPlanHash(plan, plan.cache_path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
        );
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        atomicWriteFile(
          sessionOutput.path,
          sessionOutput.content,
          workspaceRoot,
          0o600,
          expectedPlanHash(plan, sessionOutput.path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
        );
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        options.test_hooks?.before_manifest?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        assertRenderedOutputsStable(plan, cacheContent, sessionOutput);
        const manifest = buildManifest(plan, now);
        atomicWriteFile(
          plan.manifest_path,
          `${JSON.stringify(manifest, null, 2)}\n`,
          workspaceRoot,
          0o600,
          expectedPlanHash(plan, plan.manifest_path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
        );
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
  sessionOutput: { path: string; content: string },
): void {
  const outputs = [
    { path: plan.fragment_path, content: plan.fragment },
    { path: plan.target_path, content: plan.target_content },
    { path: plan.cache_path, content: cacheContent },
    sessionOutput,
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
    staleCacheAgeInSeconds(bundle.generated_at, now, "bundle generated_at"),
    staleCacheAgeInSeconds(cache.cached_at, now, "cache cached_at"),
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
  const sessionManifestPath = runtimePaths(workspaceRoot, runtime).sessionManifest;
  if (!existsSync(sessionManifestPath)) return null;
  const manifest = readSessionManifestRecord(sessionManifestPath, workspaceRoot);
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

function buildSessionCompatibilityManifest(plan: ProjectContextPlan, now: Date): Record<string, unknown> {
  const paths = runtimePaths(plan.workspace_root, plan.runtime);
  const tool = manifestTool(plan.runtime);
  const targetHome = plan.runtime === "codewith" ? resolve(plan.workspace_root, ".codewith") : plan.workspace_root;
  const targetRelativePath = sessionTargetRelativePath(plan.runtime);
  const existing = existsSync(paths.sessionManifest)
    ? readSessionManifestRecord(paths.sessionManifest, plan.workspace_root)
    : {
      schema: SESSION_RENDER_SCHEMA,
      tool,
      adapterMode: plan.native_imports ? "native-imports" : "flattened-markdown",
      profile: "project-context",
      sessionId: null,
      targetHome,
      targetKind: "session-home",
      targetOwner: {},
      env: {},
      sourceHash: null,
      sources: [],
      skippedSources: [],
      files: [],
      warnings: [],
    };
  if (!existing || existing["schema"] !== SESSION_RENDER_SCHEMA || (existing["tool"] !== undefined && existing["tool"] !== tool)) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session manifest is malformed or incompatible");
  }
  const existingTargetHome = safeLegacyMetadataString(existing["targetHome"], null);
  if (existingTargetHome !== null && resolve(existingTargetHome) !== targetHome) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session manifest targets a different workspace");
  }
  const sources = sanitizeLegacySources(existing["sources"])
    .filter((source) => source["id"] !== "project-context-bundle");
  sources.push(manifestSource(plan));
  const files = sanitizeLegacyFiles(existing["files"]);
  const targetIndexes = files.filter((file) => file["relativePath"] === targetRelativePath);
  if (targetIndexes.length > 1) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", `provider session manifest contains duplicate ${targetRelativePath} entries`);
  }
  const previousSourceIds = targetIndexes[0]?.["sourceIds"] as string[] | undefined;
  const updatedTarget = {
    path: plan.target_path,
    relativePath: targetRelativePath,
    role: "index",
    sha256: sha256(plan.target_content),
    sourceIds: [...new Set([...(previousSourceIds ?? []), "project-context-bundle"])],
  };
  const targetOwner = isRecord(existing["targetOwner"]) ? existing["targetOwner"] : {};
  const adapterMode = plan.native_imports ? "native-imports" : "flattened-markdown";
  return {
    schema: SESSION_RENDER_SCHEMA,
    tool,
    adapterMode,
    profile: safeLegacyMetadataString(existing["profile"], "project-context"),
    sessionId: existing["sessionId"] === null ? null : safeLegacyMetadataString(existing["sessionId"], null),
    targetHome,
    targetKind: existing["targetKind"] === "project-root" ? "project-root" : "session-home",
    targetOwner: {
      kind: targetOwner["kind"] === "project" ? "project" : "provider-profile",
      tool,
      profile: safeLegacyMetadataString(targetOwner["profile"], safeLegacyMetadataString(existing["profile"], "project-context")),
      targetHome,
      projectRoot: plan.workspace_root,
      ownedBy: "open-configs",
      canonicalOwner: "instructions",
      reason: "provider session manifest retained for additive Instructions project-context compatibility",
    },
    writable: true,
    blocked: false,
    blockers: [],
    generatedAt: now.toISOString(),
    env: sanitizeLegacyEnvironment(existing["env"]),
    sourceHash: sha256(stableStringify({ previous: typeof existing["sourceHash"] === "string" ? existing["sourceHash"] : null, projectContext: plan.bundle.hash })),
    sources,
    skippedSources: sanitizeLegacySkippedSources(existing["skippedSources"]),
    files: [...files.filter((file) => file["relativePath"] !== targetRelativePath), updatedTarget],
    warnings: [...new Set([...sanitizeLegacyWarnings(existing["warnings"]), ...plan.warnings])].slice(0, 64),
    projectContext: manifestProjectContext(plan),
    compatibility: manifestCompatibility(),
  };
}

function sanitizeLegacySources(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !isRecord(entry))) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source inventory is malformed");
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
      provenance: sanitizeLegacyProvenance(source["provenance"]),
    };
  });
}

function sanitizeLegacyEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 8) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session environment metadata is malformed");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof item !== "string" || !isAbsolute(item) || !isSafeSingleLine(item) || item.length > 4_096) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session environment metadata contains an unsafe entry");
    }
    if (scanSecrets(`${key}=${item}`, "text").length > 0) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session environment metadata contains credential-like content");
    }
    result[key] = item;
  }
  return result;
}

function sanitizeLegacyWarnings(value: unknown): string[] {
  return safeLegacyStringArray(value, 64);
}

function sanitizeLegacyProvenance(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance is malformed");
  }
  const state = { nodes: 0 };
  const sanitized = sanitizeBoundedJsonMetadata(value, 0, state);
  if (!isRecord(sanitized)) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance is malformed");
  }
  const encoded = JSON.stringify(sanitized);
  if (Buffer.byteLength(encoded, "utf8") > PROJECT_CONTEXT_MAX_INPUT_BYTES || scanSecrets(encoded, "text").length > 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance exceeds its bound or contains credential-like content");
  }
  return sanitized;
}

function sanitizeBoundedJsonMetadata(value: unknown, depth: number, state: { nodes: number }): unknown {
  state.nodes++;
  if (state.nodes > 128 || depth > 6) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance exceeds its structural bound");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an invalid number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 4_096 || !isSafeSingleLine(value)) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an unsafe string");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an oversized array");
    return value.map((item) => sanitizeBoundedJsonMetadata(item, depth + 1, state));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 64) throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an oversized object");
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (key.length === 0 || key.length > 256 || !isSafeSingleLine(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an unsafe key");
      }
      result[key] = sanitizeBoundedJsonMetadata(item, depth + 1, state);
    }
    return result;
  }
  throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an unsupported value");
}

function sanitizeLegacyFiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !isRecord(entry))) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session file inventory is malformed");
  }
  return value.map((entry) => {
    const file = entry as Record<string, unknown>;
    const relativePath = safeLegacyMetadataString(file["relativePath"], "");
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("/../")) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session file inventory contains an unsafe relative path");
    }
    const sha = safeLegacyMetadataString(file["sha256"], "");
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session file inventory contains an invalid hash");
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
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session manifest contains malformed string metadata");
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
  return projectContextManifestSource(plan.cache_path, plan.runtime, plan.bundle);
}

function projectContextManifestSource(
  cachePath: string,
  runtime: ProjectContextRuntime,
  bundle: ProjectContextBundleV1,
): ProjectContextManifest["sources"][number] {
  return {
    id: "project-context-bundle",
    label: "Project Context Bundle",
    layer: "repo",
    merge: "replace",
    order: 0,
    path: cachePath,
    targetProviders: [manifestTool(runtime)],
    owner: { kind: "package", id: "@hasna/projects" },
    sourcePaths: [],
    hash: bundle.hash,
    nonOverridable: true,
    replacementScope: "project-context",
    rules: [],
    provenance: {
      schema: PROJECT_CONTEXT_SCHEMA,
      projectId: bundle.project.id,
      revision: bundle.revision,
      hash: bundle.hash,
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
    tool: result.data.tool,
    adapterMode: result.data.adapterMode,
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

function readSessionManifestRecord(path: string, workspaceRoot: string): Record<string, unknown> | null {
  const content = readUtf8RegularFile(path, workspaceRoot, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES);
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
  afterExchange?: () => void,
  atomicExchangeUnavailable = false,
  beforeInstall?: (tempPath: string) => void,
): void {
  const dir = resolve(path, "..");
  ensureSafeDirectory(dir, workspaceRoot, 0o700);
  assertNoSymlinkSegments(workspaceRoot, path);
  const previousMode = existsSync(path) ? statSync(path).mode & 0o777 : defaultMode;
  const tempPath = join(dir, `.project-context-${randomUUID()}.tmp`);
  let fd: number | null = null;
  let preserveTemp = false;
  let directoryChanged = false;
  const desiredHash = sha256(content);
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, previousMode);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    beforeInstall?.(tempPath);
    if (preparedTempHash(tempPath) !== desiredHash) {
      throw new ProjectContextHashRace(`prepared bytes changed before installation: ${relativePosix(workspaceRoot, path)}`);
    }
    if (expectedHash === undefined) {
      renameSync(tempPath, path);
      directoryChanged = true;
    } else if (expectedHash === null) {
      const prepared = lstatSync(tempPath);
      try {
        linkSync(tempPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ProjectContextHashRace(`managed path appeared before creation: ${relativePosix(workspaceRoot, path)}`);
        }
        throw error;
      }
      directoryChanged = true;
      const installed = lstatSync(path);
      if (
        installed.isSymbolicLink() ||
        installed.dev !== prepared.dev ||
        installed.ino !== prepared.ino ||
        preparedTempHash(tempPath) !== desiredHash ||
        currentFileHash(path, workspaceRoot) !== desiredHash
      ) {
        if (!installed.isSymbolicLink() && installed.dev === prepared.dev && installed.ino === prepared.ino) {
          rmSync(path);
        }
        throw new ProjectContextHashRace(`prepared bytes changed during creation: ${relativePosix(workspaceRoot, path)}`);
      }
      rmSync(tempPath);
    } else {
      if (!existsSync(path)) {
        throw new ProjectContextHashRace(`managed path disappeared before replacement: ${relativePosix(workspaceRoot, path)}`);
      }
      if (atomicExchangeUnavailable) {
        throw new ProjectContextError(
          "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
          "the platform could not provide an atomic exchange for compare-and-swap replacement",
        );
      }
      if (currentFileHash(path, workspaceRoot) !== expectedHash) {
        throw new ProjectContextHashRace(`managed path changed before atomic replacement: ${relativePosix(workspaceRoot, path)}`);
      }
      if (preparedTempHash(tempPath) !== desiredHash) {
        throw new ProjectContextHashRace(`prepared bytes changed before atomic replacement: ${relativePosix(workspaceRoot, path)}`);
      }
      atomicExchangePaths(tempPath, path);
      directoryChanged = true;
      let exchanged = true;
      try {
        const displacedAtExchange = currentFileHash(tempPath, workspaceRoot);
        const installedAtExchange = currentFileHash(path, workspaceRoot);
        if (displacedAtExchange !== expectedHash) {
          preserveTemp = true;
          exchanged = false;
          throw new ProjectContextError(
            "PROJECT_CONTEXT_ATOMIC_REPLACE_CONFLICT",
            `the displaced managed file changed before exchange validation: ${relativePosix(workspaceRoot, path)}`,
          );
        }
        if (installedAtExchange !== desiredHash) {
          atomicExchangePaths(tempPath, path);
          exchanged = false;
          throw new ProjectContextHashRace(`prepared bytes changed during atomic replacement: ${relativePosix(workspaceRoot, path)}`);
        }
        afterExchange?.();
        const replacedHash = currentFileHash(tempPath, workspaceRoot);
        const replacementHash = currentFileHash(path, workspaceRoot);
        if (replacedHash !== expectedHash) {
          preserveTemp = true;
          exchanged = false;
          throw new ProjectContextError(
            "PROJECT_CONTEXT_ATOMIC_REPLACE_CONFLICT",
            `the displaced managed file changed during atomic replacement: ${relativePosix(workspaceRoot, path)}`,
          );
        }
        if (replacementHash !== desiredHash) {
          rmSync(tempPath);
          exchanged = false;
          throw new ProjectContextHashRace(`managed path changed immediately after atomic replacement: ${relativePosix(workspaceRoot, path)}`);
        }
        rmSync(tempPath);
        exchanged = false;
      } catch (error) {
        if (exchanged) {
          try {
            if (
              currentFileHash(path, workspaceRoot) === desiredHash &&
              currentFileHash(tempPath, workspaceRoot) === expectedHash
            ) {
              atomicExchangePaths(tempPath, path);
              exchanged = false;
            } else {
              preserveTemp = true;
            }
          } catch {
            preserveTemp = true;
          }
        }
        throw error;
      }
    }
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (!preserveTemp && existsSync(tempPath)) rmSync(tempPath);
    if (directoryChanged) fsyncDirectory(dir);
    throw error;
  }
}

function preparedTempHash(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProjectContextHashRace("prepared project-context output is no longer a regular file");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type AtomicExchange = (left: string, right: string) => boolean;

let atomicExchange: AtomicExchange | null | undefined;
const atomicExchangeLibraries: Array<ReturnType<typeof dlopen>> = [];

function atomicExchangePaths(left: string, right: string): void {
  const exchange = resolveAtomicExchange();
  if (!exchange || !exchange(left, right)) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
      "the platform could not provide an atomic exchange for compare-and-swap replacement",
    );
  }
}

function resolveAtomicExchange(): AtomicExchange | null {
  if (atomicExchange !== undefined) return atomicExchange;
  if (process.platform === "linux") {
    const muslArch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
    const candidates = [
      "libc.so.6",
      "libc.so",
      ...(muslArch ? [`/lib/ld-musl-${muslArch}.so.1`, `/lib/libc.musl-${muslArch}.so.1`] : []),
    ];
    for (const candidate of candidates) {
      try {
        const library = dlopen(candidate, {
          renameat2: {
            args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
            returns: FFIType.i32,
          },
        });
        atomicExchangeLibraries.push(library);
        const renameat2 = library.symbols.renameat2;
        atomicExchange = (left, right) => renameat2(
          -100,
          Buffer.from(`${left}\0`),
          -100,
          Buffer.from(`${right}\0`),
          2,
        ) === 0;
        return atomicExchange;
      } catch {
        // Older glibc and some musl builds expose the kernel call only through syscall(2).
      }
    }
    const renameat2Syscall = process.arch === "arm64" ? 276 : process.arch === "x64" ? 316 : null;
    if (renameat2Syscall !== null) {
      for (const candidate of candidates) {
        try {
          const library = dlopen(candidate, {
            syscall: {
              args: [FFIType.i64, FFIType.i64, FFIType.cstring, FFIType.i64, FFIType.cstring, FFIType.u64],
              returns: FFIType.i64,
            },
          });
          atomicExchangeLibraries.push(library);
          const syscall = library.symbols.syscall;
          atomicExchange = (left, right) => Number(syscall(
            renameat2Syscall,
            -100,
            Buffer.from(`${left}\0`),
            -100,
            Buffer.from(`${right}\0`),
            2,
          )) === 0;
          return atomicExchange;
        } catch {
          // Try the next libc location before failing closed.
        }
      }
    }
  }
  if (process.platform === "darwin") {
    try {
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        renameatx_np: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
      });
      atomicExchangeLibraries.push(library);
      const renameatx = library.symbols.renameatx_np;
      atomicExchange = (left, right) => renameatx(
        -2,
        Buffer.from(`${left}\0`),
        -2,
        Buffer.from(`${right}\0`),
        2,
      ) === 0;
      return atomicExchange;
    } catch {
      // Fall through to a fail-closed unsupported result.
    }
  }
  // Windows ReplaceFileW can atomically install the prepared file, but it cannot
  // atomically materialize the displaced target back at the temp path. Without a
  // journaled recovery protocol that is not a true exchange, so updates fail closed.
  atomicExchange = null;
  return null;
}

function acquireWorkspaceLock(
  workspaceRoot: string,
  lockPath: string,
  afterOpen?: () => void,
  beforeStaleRemove?: (lockPath: string) => void,
): WorkspaceLock {
  const lockDirectory = resolve(lockPath, "..");
  ensureSafeDirectory(lockDirectory, workspaceRoot, 0o700);
  assertNoSymlinkSegments(workspaceRoot, lockPath);
  const tempPath = join(lockDirectory, `.project-context-lock-${randomUUID()}.tmp`);
  let fd: number | null = null;
  let openedIdentity: { dev: number; ino: number } | null = null;
  let openedContentHash: string | null = null;
  let linked = false;
  let preserveTemp = false;
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
    openedContentHash = sha256(content);
    writeFileSync(fd, content);
    fsyncSync(fd);
    try {
      linkSync(tempPath, lockPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const takeover = tryTakeoverStaleWorkspaceLock(
        tempPath,
        lockPath,
        workspaceRoot,
        openedIdentity,
        openedContentHash,
        beforeStaleRemove,
      );
      if (!takeover) {
        throw new ProjectContextError("PROJECT_CONTEXT_LOCKED", "another renderer holds the workspace project-context lock");
      }
      linked = true;
    }
    fsyncDirectory(lockDirectory);
    if (existsSync(tempPath)) {
      rmSync(tempPath);
      fsyncDirectory(lockDirectory);
    }
    const held = lstatSync(lockPath);
    if (
      held.isSymbolicLink() ||
      held.dev !== openedIdentity.dev ||
      held.ino !== openedIdentity.ino ||
      currentFileHash(lockPath, workspaceRoot) !== openedContentHash
    ) {
      throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during initialization");
    }
    afterOpen?.();
    return { fd, contentHash: openedContentHash, identity: openedIdentity };
  } catch (error) {
    preserveTemp = error instanceof ProjectContextError && error.code === "PROJECT_CONTEXT_LOCK_LOST";
    if (linked && openedIdentity && openedContentHash) {
      removeOwnedLockByInode(lockPath, openedIdentity, openedContentHash);
    }
    if (!preserveTemp && existsSync(tempPath)) {
      try { rmSync(tempPath); } catch { /* leave an unreferenced temp for later cleanup */ }
    }
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    throw error;
  }
}

function removeOwnedLockByInode(
  lockPath: string,
  identity: { dev: number; ino: number },
  expectedHash?: string,
): void {
  try {
    if (!existsSync(lockPath)) return;
    const current = lstatSync(lockPath);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    if (expectedHash !== undefined && sha256(readFileSync(lockPath, "utf8")) !== expectedHash) return;
    rmSync(lockPath);
    fsyncDirectory(resolve(lockPath, ".."));
  } catch {
    // Leave an uncertain lock in place rather than deleting another owner's file.
  }
}

function observeStaleWorkspaceLock(
  lockPath: string,
  workspaceRoot: string,
): { identity: { dev: number; ino: number }; contentHash: string } | null {
  let content: string;
  let observed: ReturnType<typeof lstatSync>;
  try {
    content = readUtf8RegularFile(lockPath, workspaceRoot, 2_048);
    observed = lstatSync(lockPath);
    if (observed.isSymbolicLink() || !observed.isFile()) return null;
  } catch {
    return null;
  }
  const contentHash = sha256(content);
  if (currentFileHash(lockPath, workspaceRoot) !== contentHash) return null;
  let pid: number | null = null;
  let createdAtMs: number | null = null;
  try {
    const value = JSON.parse(content) as unknown;
    if (isRecord(value)) {
      if (Number.isSafeInteger(value["pid"]) && Number(value["pid"]) > 0) pid = Number(value["pid"]);
      if (typeof value["created_at"] === "string" && isStrictIsoTimestamp(value["created_at"])) {
        const parsedCreatedAt = Date.parse(value["created_at"]);
        if (parsedCreatedAt <= Date.now()) createdAtMs = parsedCreatedAt;
      }
    }
  } catch {
    if (Date.now() - observed.mtimeMs < PROJECT_CONTEXT_LOCK_STALE_MS) return null;
  }
  const observedStartMs = Math.min(observed.mtimeMs, createdAtMs ?? observed.mtimeMs);
  const staleByAge = Date.now() - observedStartMs >= PROJECT_CONTEXT_LOCK_STALE_MS;
  if (pid !== null && processIsAlive(pid) && !staleByAge) return null;
  if (pid === null && !staleByAge) return null;
  return {
    identity: { dev: observed.dev, ino: observed.ino },
    contentHash,
  };
}

function tryTakeoverStaleWorkspaceLock(
  candidatePath: string,
  lockPath: string,
  workspaceRoot: string,
  candidateIdentity: { dev: number; ino: number },
  candidateHash: string,
  beforeTakeover?: (lockPath: string) => void,
): boolean {
  const stale = observeStaleWorkspaceLock(lockPath, workspaceRoot);
  if (!stale) return false;
  beforeTakeover?.(lockPath);
  atomicExchangePaths(candidatePath, lockPath);
  let exchanged = true;
  try {
    const current = lstatSync(lockPath);
    const displaced = lstatSync(candidatePath);
    const candidateInstalled = (
      !current.isSymbolicLink() &&
      current.dev === candidateIdentity.dev &&
      current.ino === candidateIdentity.ino &&
      currentFileHash(lockPath, workspaceRoot) === candidateHash
    );
    const staleDisplaced = (
      !displaced.isSymbolicLink() &&
      displaced.dev === stale.identity.dev &&
      displaced.ino === stale.identity.ino &&
      currentFileHash(candidatePath, workspaceRoot) === stale.contentHash
    );
    if (!candidateInstalled || !staleDisplaced) {
      if (candidateInstalled && existsSync(candidatePath)) {
        atomicExchangePaths(candidatePath, lockPath);
        exchanged = false;
        return false;
      }
      throw new ProjectContextError(
        "PROJECT_CONTEXT_LOCK_LOST",
        "workspace lock changed during stale-lock takeover and could not be restored safely",
      );
    }
    rmSync(candidatePath);
    fsyncDirectory(resolve(lockPath, ".."));
    exchanged = false;
    return true;
  } catch (error) {
    if (exchanged) {
      try {
        if (currentFileHash(lockPath, workspaceRoot) === candidateHash && existsSync(candidatePath)) {
          atomicExchangePaths(candidatePath, lockPath);
          exchanged = false;
        }
      } catch {
        // Preserve both paths for bounded recovery instead of deleting uncertain ownership.
      }
    }
    if (exchanged) {
      throw new ProjectContextError(
        "PROJECT_CONTEXT_LOCK_LOST",
        "workspace lock takeover could not be completed or rolled back safely",
      );
    }
    throw error;
  }
}

function assertWorkspaceLockHeld(lockPath: string, lock: WorkspaceLock, workspaceRoot: string): void {
  if (!existsSync(lockPath)) {
    throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during render");
  }
  const current = lstatSync(lockPath);
  if (
    current.isSymbolicLink() ||
    current.dev !== lock.identity.dev ||
    current.ino !== lock.identity.ino ||
    currentFileHash(lockPath, workspaceRoot) !== lock.contentHash
  ) {
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
  if (!resolveAtomicExchange()) {
    try {
      removeOwnedLockByInode(lockPath, lock.identity, lock.contentHash);
    } finally {
      try { closeSync(lock.fd); } catch { /* already closed */ }
    }
    return;
  }
  const lockDirectory = resolve(lockPath, "..");
  const releasePath = join(lockDirectory, `.project-context-release-${randomUUID()}.tmp`);
  let releaseFd: number | null = null;
  let releaseIdentity: { dev: number; ino: number } | null = null;
  let releaseHash: string | null = null;
  let exchanged = false;
  try {
    releaseFd = openSync(releasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const opened = fstatSync(releaseFd);
    releaseIdentity = { dev: opened.dev, ino: opened.ino };
    const releaseContent = `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: randomUUID(),
      state: "releasing",
      created_at: new Date().toISOString(),
    })}\n`;
    releaseHash = sha256(releaseContent);
    writeFileSync(releaseFd, releaseContent);
    fsyncSync(releaseFd);
    closeSync(releaseFd);
    releaseFd = null;

    atomicExchangePaths(releasePath, lockPath);
    exchanged = true;
    const installed = lstatSync(lockPath);
    const displaced = lstatSync(releasePath);
    const releaseInstalled = (
      !installed.isSymbolicLink() &&
      installed.dev === releaseIdentity.dev &&
      installed.ino === releaseIdentity.ino &&
      currentFileHash(lockPath, workspaceRoot) === releaseHash
    );
    const ownedDisplaced = (
      !displaced.isSymbolicLink() &&
      displaced.dev === lock.identity.dev &&
      displaced.ino === lock.identity.ino &&
      currentFileHash(releasePath, workspaceRoot) === lock.contentHash
    );
    if (!releaseInstalled || !ownedDisplaced) {
      if (releaseInstalled && existsSync(releasePath)) {
        atomicExchangePaths(releasePath, lockPath);
        exchanged = false;
      }
      return;
    }
    rmSync(releasePath);
    removeOwnedLockByInode(lockPath, releaseIdentity, releaseHash);
    fsyncDirectory(lockDirectory);
    exchanged = false;
  } catch {
    if (exchanged) {
      try {
        if (releaseHash && currentFileHash(lockPath, workspaceRoot) === releaseHash && existsSync(releasePath)) {
          atomicExchangePaths(releasePath, lockPath);
          exchanged = false;
        }
      } catch {
        // Leave both paths in place rather than deleting uncertain lock ownership.
      }
    }
  } finally {
    if (releaseFd !== null) {
      try { closeSync(releaseFd); } catch { /* already closed */ }
    }
    if (!exchanged && existsSync(releasePath)) {
      try { rmSync(releasePath); } catch { /* preserve an uncertain release marker */ }
    }
    try { closeSync(lock.fd); } catch { /* already closed */ }
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
  sessionManifest: string;
} {
  const relativeTarget = runtime === "claude" ? "CLAUDE.md" : runtime === "codewith" ? ".codewith/CODEWITH.md" : "AGENTS.md";
  return {
    target: resolve(workspaceRoot, ...relativeTarget.split("/")),
    fragment: resolve(workspaceRoot, ...PROJECT_CONTEXT_FRAGMENT_PATH.split("/")),
    manifest: resolve(workspaceRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")),
    cache: resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/")),
    sessionManifest: runtime === "codewith"
      ? resolve(workspaceRoot, ".codewith", ".hasna", "session-render-manifest.json")
      : resolve(workspaceRoot, ".hasna", "session-render-manifest.json"),
  };
}

function projectContextSessionGuardPaths(
  paths: ReturnType<typeof runtimePaths>,
  runtime: ProjectContextRuntime,
): string[] {
  return [
    paths.manifest,
    paths.cache,
    paths.fragment,
    paths.target,
    paths.sessionManifest,
    ...(runtime === "codewith" ? [resolve(paths.target, "..", "CODEWITH.override.md")] : []),
  ];
}

function sessionTargetRelativePath(runtime: ProjectContextRuntime): string {
  if (runtime === "claude") return "CLAUDE.md";
  if (runtime === "codewith") return "CODEWITH.md";
  return "AGENTS.md";
}

function projectContextRuntimeForSessionTool(tool: SessionRenderTool): ProjectContextRuntime | null {
  if (tool === "claude") return "claude";
  if (tool === "codewith") return "codewith";
  if (tool === "codex") return "agents";
  return null;
}

function projectContextWorkspaceForSession(
  input: Pick<ProjectContextSessionRenderInput, "target_home" | "project_root">,
  runtime: ProjectContextRuntime,
): string | null {
  const targetHome = resolve(input.target_home);
  if (runtime === "codewith") {
    const workspaceRoot = basename(targetHome) === ".codewith" ? dirname(targetHome) : null;
    if (!workspaceRoot) return null;
    if (input.project_root && resolve(input.project_root) !== workspaceRoot) {
      throw new ProjectContextError(
        "PROJECT_CONTEXT_PATH_INVALID",
        "Codewith project_root must be the parent workspace of target_home",
      );
    }
    if (!existsSync(workspaceRoot) || !lstatSync(workspaceRoot).isDirectory()) return null;
    return assertSafeWorkspaceRoot(workspaceRoot);
  }
  if (!existsSync(targetHome) || !lstatSync(targetHome).isDirectory()) return null;
  return assertSafeWorkspaceRoot(targetHome);
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
  const relativePath = relativePosix(workspaceRoot, path);
  const maxBytes = relativePath === ".hasna/session-render-manifest.json" || relativePath === ".codewith/.hasna/session-render-manifest.json"
    ? SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES
    : 256 * 1024;
  return sha256(readUtf8RegularFile(path, workspaceRoot, maxBytes));
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

function staleCacheAgeInSeconds(timestamp: string, now: Date, field: string): number {
  const deltaMs = now.getTime() - Date.parse(timestamp);
  if (deltaMs < 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", `${field} is in the future`);
  }
  return Math.floor(deltaMs / 1_000);
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

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
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

function isStrictIsoTimestamp(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 && month <= 12 &&
    day >= 1 && day <= monthDays[month - 1]! &&
    hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
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
