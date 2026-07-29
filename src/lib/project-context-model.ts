import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { scanSecrets } from "./redact.js";
import type {
  SessionRenderFile, SessionRenderManifest, SessionRenderMode, SessionRenderTool,
} from "./session-render-model.js";
import {
  CODEWITH_NATIVE_IMPORTS_ENV, SESSION_INSTRUCTION_LAYERS, SESSION_RENDER_SCHEMA,
} from "./session-render-contract.js";

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
export const SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const PROJECT_CONTEXT_LOCK_STALE_MS = 5 * 60 * 1_000;
export const LEGACY_CONFIGS_PACKAGE = "@hasna/configs" as const;
export const LEGACY_CONFIGS_COMPAT_VERSION = "0.2.45" as const;
export const LEGACY_CONFIGS_EXECUTABLE = "configs" as const;

export const PROJECT_KINDS = [
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
export const PROJECT_STATUSES = ["active", "archived", "deleted"] as const;
export const LINK_STATES = ["linked", "partial", "unlinked"] as const;
export const RESOLUTION_SOURCES = ["marker", "path", "id-or-slug", "name"] as const;
export const safeId = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
export const nullableId = safeId.nullable();
export const producerSlug = z.string().min(1).max(512);
export const producerName = z.string().max(PROJECT_CONTEXT_MAX_INPUT_BYTES);
export const safeOptionalDisplay = z.string().min(1).max(512).refine(isSafeSingleLine, "must be a safe single-line value").nullable();
export const isoTimestamp = z.string().min(20).max(40).refine(isStrictIsoTimestamp, "must be a strict ISO timestamp with timezone");
export const revisionSchema = z.string().min(1).max(512).refine((value) => revisionKey(value) !== null, "must be a monotonic rev-N or timestamp revision");
export const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const absolutePath = z.string().min(1).max(4_096).refine((value) => isAbsolute(value), "must be absolute").refine(isSafeSingleLine, "must be safe").nullable();
export const commandArg = z.string().min(1).max(1_024).refine((value) => isSafeCommandArgument(value), "unsafe argv item");

export const commandSchema = z.object({
  name: z.enum(["show", "context", "why", "context-bundle"]),
  argv: z.array(commandArg).min(1).max(8),
}).strict();

export const projectContextBundleSchema = z.object({
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

export const storedManifestProjectContextSchema = z.object({
  schema: z.literal(PROJECT_CONTEXT_SCHEMA),
  projectId: safeId,
  revision: revisionSchema,
  hash: hashSchema,
  status: z.enum(["fresh", "stale-source", "stale-cache"]),
  ageSeconds: z.number().int().nonnegative(),
  cachePath: z.string().min(1).max(1_024).refine(isSafeSingleLine, "must be safe"),
  fragmentPath: z.string().min(1).max(1_024).refine(isSafeSingleLine, "must be safe"),
}).strict();

export const storedManifestFileSchema = z.object({
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

export const storedManifestObservationSchema = z.object({
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

export const projectContextCacheSchema = z.object({
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
    portable_create_only?: boolean;
    before_stale_lock_remove?: (lockPath: string) => void;
    before_compare?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    after_fragment?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    before_target_install?: (context: { attempt: number; plan: ProjectContextPlan; temp_path: string }) => void;
    after_target_exchange?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    after_target?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    before_manifest?: (context: { attempt: number; plan: ProjectContextPlan }) => void;
    process_start_identity?: (pid: number) => string | null;
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

export interface ManagedBlock {
  start: number;
  end: number;
  id: string;
  revision: string;
  hash: string;
  legacy: boolean;
}

export interface ProjectContextCache {
  schema: typeof PROJECT_CONTEXT_CACHE_SCHEMA;
  cached_at: string;
  project_id: string;
  revision: string;
  hash: string;
  bundle: ProjectContextBundleV1;
}

export interface ProjectContextManifestObservation {
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

export interface ProjectContextWriteCoordination {
  workspace_root: string;
  assert_held: () => void;
}

export interface WorkspaceLock {
  fd: number;
  contentHash: string;
  identity: { dev: number; ino: number };
}

export interface ProjectContextManifest {
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
    renderedPayloadSha256: string;
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

export class ProjectContextHashRace extends Error {}

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


export function validateLinkConsistency(bundle: ProjectContextBundleV1): void {
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

export function validateSingleLink(label: string, state: "linked" | "partial" | "unlinked", value: string | null): void {
  if (state === "linked" && value === null) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} linked state requires an identifier`);
  if (state === "unlinked" && value !== null) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} unlinked state forbids an identifier`);
  if (state === "partial" && value === null) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} partial state requires its available identifier`);
}

export function validateCommands(bundle: ProjectContextBundleV1): void {
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

export function validateIdentityConsistency(bundle: ProjectContextBundleV1): void {
  if (bundle.project.status !== "active" && bundle.resolution.create_allowed) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "archived or deleted projects cannot allow creation");
  }
}

export function rejectCredentialLikeBundle(bundle: ProjectContextBundleV1): void {
  const encoded = JSON.stringify(bundle);
  const credentialShape = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]|\$\{|https?:\/\//i;
  if (credentialShape.test(encoded) || scanSecrets(encoded, "text").length > 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_SECRET_REJECTED", "credential-like or URL content is forbidden in project context");
  }
}

export function scanGeneratedContent(content: string): void {
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


export function compareRevisions(incoming: string, previous: string): number {
  const a = revisionKey(incoming);
  const b = revisionKey(previous);
  if (!a || !b || a.kind !== b.kind) {
    throw new ProjectContextError("PROJECT_CONTEXT_REVISION_INCOMPARABLE", "project-context revisions use incompatible ordering schemes");
  }
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

export function revisionKey(value: string): { kind: "sequence" | "timestamp"; value: bigint } | null {
  const sequence = value.match(/^(?:rev-)?([0-9]+)$/);
  if (sequence) return { kind: "sequence", value: BigInt(sequence[1]!) };
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) return null;
  const normalized = value.includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? value.replace(" ", "T")
    : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? { kind: "timestamp", value: BigInt(timestamp) } : null;
}


export function isStrictIsoTimestamp(value: string): boolean {
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

export function isSafeSingleLine(value: string): boolean {
  return !/[\u0000-\u001f\u007f\r\n]/.test(value) && !value.includes("<!--") && !value.includes("-->") && !value.includes("`");
}

export function isSafeCommandArgument(value: string): boolean {
  return (
    (/^[A-Za-z0-9_./:@+=,-]+$/.test(value) && !value.includes("://") && !value.startsWith("-")) ||
    /^--[a-z][a-z0-9-]*$/.test(value)
  );
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function removeHashForFingerprint(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "hash") continue;
    copy[key] = item;
  }
  return copy;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
