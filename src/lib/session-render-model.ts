import type { ProjectContextSessionGuard } from "./project-context.js";
import {
  CODEWITH_NATIVE_IMPORTS_ENV, SESSION_INSTRUCTION_LAYERS,
  SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR, SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_MANIFEST_RELATIVE_PATH, SESSION_RENDER_SCHEMA,
  SESSION_RENDER_SNAPSHOT_RELATIVE_DIR,
} from "./session-render-contract.js";

export {
  CODEWITH_NATIVE_IMPORTS_ENV,
  SESSION_INSTRUCTION_LAYERS,
  SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
  SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_MANAGED_NAMESPACE,
  SESSION_RENDER_MANIFEST_RELATIVE_PATH,
  SESSION_RENDER_SCHEMA,
  SESSION_RENDER_SNAPSHOT_RELATIVE_DIR,
} from "./session-render-contract.js";
export const RAW_STORE_ROOT_ENV = "HASNA_CONFIGS_HOME";
export const ANTIGRAVITY_RULE_FILE_CHAR_LIMIT = 12_000;
export const SESSION_RENDERER_OWNER_ID = "instructions-session-renderer";

export const SESSION_RENDER_TOOLS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "codewith",
  "qwen",
  "aicopilot",
  "antigravity",
] as const;

export const SESSION_RENDER_PROFILE_ENTRYPOINTS = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".codewith/CODEWITH.md",
  ".config/opencode/AGENTS.md",
] as const;
export const SESSION_RENDER_OWNED_CONFIG_TARGETS = [
  ...SESSION_RENDER_PROFILE_ENTRYPOINTS,
  ".gemini/GEMINI.md",
  ".gemini/ANTIGRAVITY.md",
] as const;

export type SessionRenderTool = (typeof SESSION_RENDER_TOOLS)[number];
export type SessionRenderMode = "native-imports" | "flattened-markdown" | "cursor-mdc" | "opencode-instructions" | "antigravity-rules";
export type SessionInstructionLayer = (typeof SESSION_INSTRUCTION_LAYERS)[number];
export type SessionInstructionLayerAlias = SessionInstructionLayer | "provider" | "identity" | "project";
export type SessionInstructionMerge = "append" | "replace";
export type SessionRenderFileRole = "index" | "fragment" | "rule" | "config" | "manifest";
export type SessionRenderTargetKind = "session-home" | "project-root" | "blocked";
export type SessionTargetOwnerKind = "provider-profile" | "project" | "blocked";

export interface SessionInstructionOwner {
  kind: string;
  id: string;
}

export interface SessionInstructionSourcePath {
  path: string;
  editable?: boolean;
  required?: boolean;
  hash?: string;
}

export interface SessionInstructionRule {
  id: string;
  content: string;
  label?: string;
  path?: string;
  globs?: string[];
  hash?: string;
  metadata?: Record<string, unknown> | null;
}

export interface SessionToolAdapter {
  tool: SessionRenderTool;
  mode: SessionRenderMode;
  indexFile?: string;
  configFile?: string;
  managedDir: string;
  envVar?: string;
  nativeImports: boolean;
  description: string;
}

export interface SessionInstructionSource {
  id: string;
  content: string;
  label?: string;
  layer?: SessionInstructionLayerAlias;
  merge?: SessionInstructionMerge;
  order?: number;
  path?: string;
  rules?: SessionInstructionRule[];
  provenance?: Record<string, unknown> | null;
  targetProviders?: string[];
  owner?: SessionInstructionOwner | null;
  sourcePaths?: SessionInstructionSourcePath[];
  globs?: string[];
  hash?: string;
  nonOverridable?: boolean;
  replacementScope?: string;
  metadata?: Record<string, unknown> | null;
}

export interface OrderedSessionInstructionSource extends SessionInstructionSource {
  normalizedId: string;
  resolvedLabel: string;
  resolvedLayer: SessionInstructionLayer;
  resolvedMerge: SessionInstructionMerge;
  resolvedOrder: number;
  resolvedRules: OrderedSessionInstructionRule[];
}

export interface OrderedSessionInstructionRule extends SessionInstructionRule {
  normalizedId: string;
  resolvedLabel: string;
  resolvedPath: string;
}

export type IdentityExportShape = "configs-contract" | "canonical-open-identities";

export interface SessionTargetOwner {
  kind: SessionTargetOwnerKind;
  tool: SessionRenderTool;
  profile: string;
  targetHome: string;
  projectRoot: string | null;
  ownedBy: "open-configs";
  canonicalOwner: "instructions";
  writer: {
    id: typeof SESSION_RENDERER_OWNER_ID;
    canonical: true;
    legacyAliases: ["open-configs"];
    scope: "managed-provider-files" | "managed-instruction-fields";
  };
  reason: string;
}

export interface SessionProviderConfig {
  sourceId: string;
  content: string;
}

export interface SessionSkippedSource {
  id: string;
  label: string;
  targetProviders: string[];
  reason: string;
}

export interface SessionProfileRenderSelection {
  sources: SessionInstructionSource[];
  skippedSources: SessionSkippedSource[];
  providerConfig?: SessionProviderConfig;
}

export interface SessionRenderInput {
  tool: SessionRenderTool;
  profile: string;
  sources: SessionInstructionSource[];
  projectRoot?: string;
  targetHome?: string;
  sessionId?: string;
  generatedAt?: string;
  codewithNativeImports?: boolean;
  allowEmptySources?: boolean;
  providerConfig?: SessionProviderConfig;
  skippedSources?: SessionSkippedSource[];
}

export interface SessionRenderFile {
  path: string;
  relativePath: string;
  role: SessionRenderFileRole;
  content: string;
  sha256: string;
  sourceIds: string[];
}

export interface SessionRenderManifest {
  schema: typeof SESSION_RENDER_SCHEMA;
  tool: SessionRenderTool;
  adapterMode: SessionRenderMode;
  profile: string;
  sessionId: string | null;
  targetHome: string;
  targetKind: SessionRenderTargetKind;
  targetOwner: SessionTargetOwner;
  writable: boolean;
  blocked: boolean;
  blockers: string[];
  generatedAt: string;
  env: Record<string, string>;
  sourceHash: string;
  sources: Array<{
    id: string;
    label: string;
    layer: SessionInstructionLayer;
    merge: SessionInstructionMerge;
    order: number;
    path: string | null;
    targetProviders: string[];
    owner: SessionInstructionOwner | null;
    sourcePaths: SessionInstructionSourcePath[];
    hash: string | null;
    nonOverridable: boolean;
    replacementScope: string | null;
    rules: Array<{
      id: string;
      label: string;
      path: string;
      globs: string[];
      hash: string | null;
    }>;
    renderedPayloadSha256: string;
    provenance: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  }>;
  skippedSources: Array<{
    id: string;
    label: string;
    targetProviders: string[];
    reason: string;
  }>;
  files: Array<{
    path: string;
    relativePath: string;
    role: SessionRenderFileRole;
    sha256: string;
    sourceIds: string[];
  }>;
  warnings: string[];
  providerConfig?: {
    sourceId: string;
    selectedPayloadSha256: string;
    renderedPayloadSha256: string;
    selected: boolean;
  };
  projectContext?: {
    schema: string;
    projectId: string;
    revision: string;
    hash: string;
    status: string;
    ageSeconds: number;
    cachePath: string;
    fragmentPath: string;
  };
  compatibility?: Record<string, unknown>;
}

export interface SessionRenderPlan {
  dryRun: true;
  tool: SessionRenderTool;
  adapter: SessionToolAdapter;
  profile: string;
  sessionId: string | null;
  targetHome: string;
  targetKind: SessionRenderTargetKind;
  targetOwner: SessionTargetOwner;
  writable: boolean;
  blocked: boolean;
  blockers: string[];
  env: Record<string, string>;
  files: SessionRenderFile[];
  manifest: SessionRenderManifest;
  manifestFile: SessionRenderFile;
  allFiles: SessionRenderFile[];
  warnings: string[];
  projectContextGuard?: ProjectContextSessionGuard;
}

export const CODEWITH_FLATTENED_ADAPTER: SessionToolAdapter = {
  tool: "codewith",
  mode: "flattened-markdown",
  indexFile: "CODEWITH.md",
  managedDir: SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
  envVar: "CODEWITH_HOME",
  nativeImports: false,
  description: "Codewith CODEWITH.md flattened until native @ imports are implemented in Codewith.",
};

export const CODEWITH_NATIVE_ADAPTER: SessionToolAdapter = {
  tool: "codewith",
  mode: "native-imports",
  indexFile: "CODEWITH.md",
  managedDir: SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
  envVar: "CODEWITH_HOME",
  nativeImports: true,
  description: "Codewith CODEWITH.md with gated @ imports into managed fragments.",
};

export const SESSION_TOOL_ADAPTERS: Record<SessionRenderTool, SessionToolAdapter> = {
  claude: {
    tool: "claude",
    mode: "native-imports",
    indexFile: "CLAUDE.md",
    managedDir: SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
    envVar: "CLAUDE_CONFIG_DIR",
    nativeImports: true,
    description: "Claude Code CLAUDE.md with @ imports into managed fragments.",
  },
  codex: {
    tool: "codex",
    mode: "flattened-markdown",
    indexFile: "AGENTS.md",
    managedDir: SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
    envVar: "CODEX_HOME",
    nativeImports: false,
    description: "Codex AGENTS.md flattened instruction file.",
  },
  cursor: {
    tool: "cursor",
    mode: "cursor-mdc",
    managedDir: ".cursor/rules",
    nativeImports: false,
    description: "Cursor project rule files in .cursor/rules/*.mdc.",
  },
  opencode: {
    tool: "opencode",
    mode: "opencode-instructions",
    indexFile: "AGENTS.md",
    configFile: "opencode.json",
    managedDir: SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
    envVar: "OPENCODE_CONFIG_DIR",
    nativeImports: false,
    description: "OpenCode AGENTS.md plus opencode.json instructions pointing at managed fragments.",
  },
  aicopilot: {
    tool: "aicopilot",
    mode: "flattened-markdown",
    indexFile: "AICOPILOT.md",
    managedDir: SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR,
    envVar: "AICOPILOT_CONFIG_DIR",
    nativeImports: false,
    description: "AI Copilot AICOPILOT.md flattened instruction file.",
  },
  qwen: {
    tool: "qwen",
    mode: "flattened-markdown",
    indexFile: "QWEN.md",
    managedDir: ".qwen/instructions",
    envVar: "QWEN_HOME",
    nativeImports: false,
    description: "Qwen Code QWEN.md hierarchical instructional context file.",
  },
  antigravity: {
    tool: "antigravity",
    mode: "antigravity-rules",
    managedDir: ".agents/rules",
    nativeImports: false,
    description: "Google Antigravity project rules in .agents/rules/*.md.",
  },
  codewith: CODEWITH_FLATTENED_ADAPTER,
};

/**
 * Every directory the session renderer writes into, derived from the adapters
 * themselves so the ownership guard tracks the renderer instead of duplicating
 * a hand-maintained path list.
 */
export const SESSION_RENDER_MANAGED_DIRS: readonly string[] = [
  ...new Set(
    [
      CODEWITH_FLATTENED_ADAPTER,
      CODEWITH_NATIVE_ADAPTER,
      ...Object.values(SESSION_TOOL_ADAPTERS),
    ].map((adapter) => adapter.managedDir),
  ),
];

/**
 * Managed directories the renderer does NOT own exclusively: the config fan-out
 * writes `cursor-mdc` transform outputs into `~/.cursor/rules` as well, so a
 * static ownership match there would break `apply`/`sync` for those rows. Files
 * the renderer actually wrote under a shared directory are still protected —
 * they are claimed by that target home's session render manifest.
 *
 * `session-render-ownership.test.ts` machine-checks this set against the fan-out
 * outputs in `sync.ts`, so the two cannot drift apart silently.
 */
export const SESSION_RENDER_SHARED_MANAGED_DIRS: readonly string[] = [".cursor/rules"];

/**
 * Paths under any session target home that only the session renderer may write.
 * `apply` refuses these regardless of which home they sit in, because the
 * renderer's target homes are provider profile homes, not the config home.
 */
export const SESSION_RENDER_EXCLUSIVE_MANAGED_PATHS: readonly string[] = [
  ...SESSION_RENDER_MANAGED_DIRS.filter((dir) => !SESSION_RENDER_SHARED_MANAGED_DIRS.includes(dir)),
  SESSION_RENDER_MANIFEST_RELATIVE_PATH,
  SESSION_RENDER_SNAPSHOT_RELATIVE_DIR,
];

export const SESSION_LAYER_RANK: Record<SessionInstructionLayer, number> = {
  global: 10,
  tool: 20,
  account: 30,
  machine: 40,
  division: 50,
  workspace: 60,
  repo: 70,
  path: 80,
  agent: 90,
  session: 100,
  local: 110,
};

export function normalizeSessionInstructionLayer(value: unknown): SessionInstructionLayer {
  if (value === "provider") return "tool";
  if (value === "identity") return "agent";
  if (value === "project") return "repo";
  if (
    value === "global" ||
    value === "tool" ||
    value === "account" ||
    value === "machine" ||
    value === "division" ||
    value === "workspace" ||
    value === "repo" ||
    value === "path" ||
    value === "agent" ||
    value === "session" ||
    value === "local"
  ) return value;
  throw new Error(`Invalid session instruction layer: ${String(value)}`);
}

