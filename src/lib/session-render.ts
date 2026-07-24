import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, posix, relative, resolve } from "node:path";
import type { Config } from "../types/index.js";
import {
  composeProjectContextSessionRender,
  observeProjectContextSessionGuard,
  type ProjectContextSessionGuard,
} from "./project-context.js";
import {
  CODEWITH_NATIVE_IMPORTS_ENV,
  SESSION_INSTRUCTION_LAYERS,
  SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_SCHEMA,
} from "./session-render-contract.js";

export {
  CODEWITH_NATIVE_IMPORTS_ENV,
  SESSION_INSTRUCTION_LAYERS,
  SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_SCHEMA,
} from "./session-render-contract.js";
export const RAW_STORE_ROOT_ENV = "HASNA_CONFIGS_HOME";
export const ANTIGRAVITY_RULE_FILE_CHAR_LIMIT = 12_000;

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

interface OrderedSessionInstructionSource extends SessionInstructionSource {
  normalizedId: string;
  resolvedLabel: string;
  resolvedLayer: SessionInstructionLayer;
  resolvedMerge: SessionInstructionMerge;
  resolvedOrder: number;
  resolvedRules: OrderedSessionInstructionRule[];
}

interface OrderedSessionInstructionRule extends SessionInstructionRule {
  normalizedId: string;
  resolvedLabel: string;
  resolvedPath: string;
}

type IdentityExportShape = "configs-contract" | "canonical-open-identities";

export interface SessionTargetOwner {
  kind: SessionTargetOwnerKind;
  tool: SessionRenderTool;
  profile: string;
  targetHome: string;
  projectRoot: string | null;
  ownedBy: "open-configs";
  reason: string;
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
    provenance: Record<string, unknown> | null;
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

const CODEWITH_FLATTENED_ADAPTER: SessionToolAdapter = {
  tool: "codewith",
  mode: "flattened-markdown",
  indexFile: "CODEWITH.md",
  managedDir: ".hasna/instructions",
  envVar: "CODEWITH_HOME",
  nativeImports: false,
  description: "Codewith CODEWITH.md flattened until native @ imports are implemented in Codewith.",
};

const CODEWITH_NATIVE_ADAPTER: SessionToolAdapter = {
  tool: "codewith",
  mode: "native-imports",
  indexFile: "CODEWITH.md",
  managedDir: ".hasna/instructions",
  envVar: "CODEWITH_HOME",
  nativeImports: true,
  description: "Codewith CODEWITH.md with gated @ imports into managed fragments.",
};

export const SESSION_TOOL_ADAPTERS: Record<SessionRenderTool, SessionToolAdapter> = {
  claude: {
    tool: "claude",
    mode: "native-imports",
    indexFile: "CLAUDE.md",
    managedDir: ".hasna/instructions",
    envVar: "CLAUDE_CONFIG_DIR",
    nativeImports: true,
    description: "Claude Code CLAUDE.md with @ imports into managed fragments.",
  },
  codex: {
    tool: "codex",
    mode: "flattened-markdown",
    indexFile: "AGENTS.md",
    managedDir: ".hasna/instructions",
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
    managedDir: ".hasna/instructions",
    envVar: "OPENCODE_CONFIG_DIR",
    nativeImports: false,
    description: "OpenCode AGENTS.md plus opencode.json instructions pointing at managed fragments.",
  },
  aicopilot: {
    tool: "aicopilot",
    mode: "flattened-markdown",
    indexFile: "AICOPILOT.md",
    managedDir: ".hasna/instructions",
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

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "instruction";
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getRawStoreRoot(): string {
  return resolve(process.env[RAW_STORE_ROOT_ENV] || join(process.env["HOME"] || homedir(), ".hasna", "configs"));
}

function defaultTargetHome(tool: SessionRenderTool, profile: string, sessionId?: string): string {
  return join(getRawStoreRoot(), "sessions", tool, slug(profile), slug(sessionId || "latest"));
}

function joinTarget(targetHome: string, relativePath: string): string {
  const safeTargetHome = assertSafeTargetRoot(targetHome);
  const safeRelativePath = assertSafeRelativePath(relativePath);
  return join(safeTargetHome, ...safeRelativePath.split("/"));
}

function makeFile(
  targetHome: string,
  relativePath: string,
  role: SessionRenderFileRole,
  content: string,
  sourceIds: string[],
): SessionRenderFile {
  const safeTargetHome = assertSafeTargetRoot(targetHome);
  const safeRelativePath = assertSafeRelativePath(relativePath);
  const normalizedContent = ensureTrailingNewline(content);
  return {
    path: joinTarget(safeTargetHome, safeRelativePath),
    relativePath: safeRelativePath,
    role,
    content: normalizedContent,
    sha256: sha256(normalizedContent),
    sourceIds,
  };
}

function normalizeSources(
  sources: SessionInstructionSource[],
  tool: SessionRenderTool,
  allowEmptySources: boolean,
): OrderedSessionInstructionSource[] {
  const ordered = sources
    .map((source, index) => {
      if (!source.id.trim()) throw new Error("Session instruction source id is required.");
      const content = filterProviderOnlyBlocks(source.content ?? "", tool);
      const normalized = {
        ...source,
        content,
        normalizedId: slug(source.id),
        resolvedLabel: source.label ?? source.id,
        resolvedLayer: source.layer === undefined ? "agent" : normalizeSessionInstructionLayer(source.layer),
        resolvedMerge: source.merge ?? "append",
        resolvedOrder: source.order ?? index,
        resolvedRules: normalizeInstructionRules(source, tool),
      };
      const hasPathReferences = (normalized.sourcePaths ?? []).length > 0;
      if (!allowEmptySources && !normalized.content.trim() && normalized.resolvedRules.length === 0 && !hasPathReferences) {
        throw new Error(`Session instruction source "${source.id}" is empty. Pass --allow-empty-sources only for explicit empty renders.`);
      }
      return normalized;
    })
    .sort((a, b) =>
      SESSION_LAYER_RANK[a.resolvedLayer] - SESSION_LAYER_RANK[b.resolvedLayer] ||
      a.resolvedOrder - b.resolvedOrder ||
      a.id.localeCompare(b.id)
    );
  rejectDuplicateSourceSlugs(ordered);
  rejectDuplicateRulePaths(ordered);
  return ordered;
}

function filterProviderOnlyBlocks(content: string, tool: SessionRenderTool): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let activeProviders: string[] | null = null;
  for (const line of lines) {
    const start = line.match(/^\s*<!--\s*@hasna-provider:\s*([^>]+?)\s*-->\s*$/i);
    if (start) {
      if (activeProviders) throw new Error("Nested provider-only instruction blocks are not supported.");
      activeProviders = start[1]!.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
      continue;
    }
    if (/^\s*<!--\s*@hasna-end-provider\s*-->\s*$/i.test(line)) {
      if (!activeProviders) throw new Error("Provider-only instruction block end marker without start marker.");
      activeProviders = null;
      continue;
    }
    if (!activeProviders || activeProviders.includes(tool) || activeProviders.includes("all") || activeProviders.includes("generic")) {
      output.push(line);
    }
  }
  if (activeProviders) throw new Error("Provider-only instruction block was not closed.");
  return output.join("\n");
}

function composeSources(sources: OrderedSessionInstructionSource[]): OrderedSessionInstructionSource[] {
  let start = -1;
  for (let i = 0; i < sources.length; i++) {
    if (sources[i]!.resolvedMerge === "replace") start = i;
  }
  if (start < 0) return sources;
  const protectedSources = sources.slice(0, start).filter((source) => source.nonOverridable);
  return [...protectedSources, ...sources.slice(start)];
}

function sectionForSource(source: OrderedSessionInstructionSource): string {
  const parts = [
    `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
    `# ${source.resolvedLabel}`,
  ];
  if (source.path) parts.push(`Source: ${source.path}`);
  if (source.sourcePaths && source.sourcePaths.length > 0) {
    parts.push([
      "Source paths:",
      ...source.sourcePaths.map((sourcePath) => {
        const flags = [
          sourcePath.editable ? "editable" : null,
          sourcePath.required ? "required" : null,
          sourcePath.hash ? sourcePath.hash : null,
        ].filter(Boolean);
        return `- ${sourcePath.path}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
      }),
    ].join("\n"));
  }
  if (source.owner) parts.push(`Owner: ${source.owner.kind}:${source.owner.id}`);
  const content = source.content.trim();
  if (content) parts.push(content);
  return parts.join("\n\n");
}

function sectionForRule(source: OrderedSessionInstructionSource, rule: OrderedSessionInstructionRule): string {
  const parts = [
    `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
    `# ${rule.resolvedLabel}`,
  ];
  if (source.path) parts.push(`Source: ${source.path}`);
  if (rule.path) parts.push(`Rule path: ${rule.path}`);
  const content = rule.content.trim();
  if (content) parts.push(content);
  return parts.join("\n\n");
}

function fragmentPath(adapter: SessionToolAdapter, index: number, source: OrderedSessionInstructionSource): string {
  const n = String(index + 1).padStart(2, "0");
  return posix.join(adapter.managedDir, `${n}-${source.normalizedId}.md`);
}

function ruleFragmentPath(
  adapter: SessionToolAdapter,
  source: OrderedSessionInstructionSource,
  rule: OrderedSessionInstructionRule,
): string {
  return posix.join(adapter.managedDir, "rules", source.normalizedId, rule.resolvedPath);
}

function importPath(indexRelativePath: string, fragmentRelativePath: string): string {
  const relative = posix.relative(posix.dirname(indexRelativePath), fragmentRelativePath);
  if (relative.startsWith("./") || relative.startsWith("../")) return relative;
  return `./${relative}`;
}

function indexHeader(tool: SessionRenderTool, profile: string): string {
  return [
    `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
    `# ${tool} session instructions`,
    "",
    `Profile: ${profile}`,
  ].join("\n");
}

function buildNativeImportFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  const indexFile = adapter.indexFile!;
  const fragments = sources.flatMap((source, index) => [
    makeFile(targetHome, fragmentPath(adapter, index, source), "fragment", sectionForSource(source), [source.id]),
    ...source.resolvedRules.map((rule) =>
      makeFile(targetHome, ruleFragmentPath(adapter, source, rule), "rule", sectionForRule(source, rule), [source.id, rule.id])
    ),
  ]);
  const imports = fragments.map((file) => `@${importPath(indexFile, file.relativePath)}`);
  const index = makeFile(
    targetHome,
    indexFile,
    "index",
    [indexHeader(adapter.tool, profile), ...imports].join("\n"),
    sources.map((source) => source.id),
  );
  return [index, ...fragments];
}

function buildFlattenedMarkdownFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  const content = [
    indexHeader(adapter.tool, profile),
    ...sources.flatMap((source) => [
      sectionForSource(source),
      ...source.resolvedRules.map((rule) => sectionForRule(source, rule)),
    ]),
  ].join("\n\n");
  return [
    makeFile(targetHome, adapter.indexFile!, "index", content, [
      ...sources.map((source) => source.id),
      ...sources.flatMap((source) => source.resolvedRules.map((rule) => rule.id)),
    ]),
  ];
}

function buildCursorRuleFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  return sources.flatMap((source, index) => {
    const n = String(index + 1).padStart(2, "0");
    const stem = `${n}-${source.normalizedId}`;
    const relativePath = posix.join(adapter.managedDir, `${stem}.mdc`);
    const description = `${source.resolvedLabel} (${source.resolvedLayer})`;
    const content = [
      "---",
      `description: ${yamlQuote(description)}`,
      'globs: ["**/*"]',
      "alwaysApply: true",
      "---",
      "",
      `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
      "",
      source.content.trim(),
    ].join("\n");
    const sourceFile = makeFile(targetHome, relativePath, "rule", content, [source.id]);
    const ruleFiles = source.resolvedRules.map((rule) => {
      const ruleStem = `${n}-${source.normalizedId}-${rule.normalizedId}`;
      const ruleRelativePath = posix.join(adapter.managedDir, `${ruleStem}.mdc`);
      const ruleDescription = `${rule.resolvedLabel} (${source.resolvedLayer})`;
      const ruleContent = [
        "---",
        `description: ${yamlQuote(ruleDescription)}`,
        `globs: ${JSON.stringify(rule.globs && rule.globs.length > 0 ? rule.globs : ["**/*"])}`,
        "alwaysApply: true",
        "---",
        "",
        `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
        "",
        rule.content.trim(),
      ].join("\n");
      return makeFile(targetHome, ruleRelativePath, "rule", ruleContent, [source.id, rule.id]);
    });
    return [sourceFile, ...ruleFiles];
  });
}

function buildOpenCodeFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  const fragments = sources.flatMap((source, index) => [
    makeFile(targetHome, fragmentPath(adapter, index, source), "fragment", sectionForSource(source), [source.id]),
    ...source.resolvedRules.map((rule) =>
      makeFile(targetHome, ruleFragmentPath(adapter, source, rule), "rule", sectionForRule(source, rule), [source.id, rule.id])
    ),
  ]);
  const flattenedIndex = makeFile(
    targetHome,
    adapter.indexFile!,
    "index",
    [
      indexHeader(adapter.tool, profile),
      ...sources.flatMap((source) => [
        sectionForSource(source),
        ...source.resolvedRules.map((rule) => sectionForRule(source, rule)),
      ]),
    ].join("\n\n"),
    [
      ...sources.map((source) => source.id),
      ...sources.flatMap((source) => source.resolvedRules.map((rule) => rule.id)),
    ],
  );
  const config = {
    $schema: "https://opencode.ai/config.json",
    instructions: fragments.map((file) => file.relativePath),
  };
  return [
    flattenedIndex,
    makeFile(targetHome, adapter.configFile!, "config", JSON.stringify(config, null, 2), sources.map((source) => source.id)),
    ...fragments,
  ];
}

function buildAntigravityRuleFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  return sources.flatMap((source, index) => {
    const n = String(index + 1).padStart(2, "0");
    const sourcePath = posix.join(adapter.managedDir, `${n}-${source.normalizedId}.md`);
    const sourceFile = makeAntigravityRuleFile(targetHome, sourcePath, sectionForSource(source), [source.id]);
    const ruleFiles = source.resolvedRules.map((rule) => {
      const rulePath = posix.join(adapter.managedDir, `${n}-${source.normalizedId}-${rule.resolvedPath}`);
      return makeAntigravityRuleFile(targetHome, rulePath, sectionForRule(source, rule), [source.id, rule.id]);
    });
    return [sourceFile, ...ruleFiles];
  });
}

function makeAntigravityRuleFile(
  targetHome: string,
  relativePath: string,
  content: string,
  sourceIds: string[],
): SessionRenderFile {
  const file = makeFile(targetHome, relativePath, "rule", content, sourceIds);
  if (file.content.length > ANTIGRAVITY_RULE_FILE_CHAR_LIMIT) {
    throw new Error(
      `Antigravity rule file ${file.relativePath} is ${file.content.length} characters; split it before rendering because Antigravity limits rule files to ${ANTIGRAVITY_RULE_FILE_CHAR_LIMIT} characters.`
    );
  }
  return file;
}

function buildFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  switch (adapter.mode) {
    case "native-imports":
      return buildNativeImportFiles(targetHome, adapter, profile, sources);
    case "flattened-markdown":
      return buildFlattenedMarkdownFiles(targetHome, adapter, profile, sources);
    case "cursor-mdc":
      return buildCursorRuleFiles(targetHome, adapter, sources);
    case "opencode-instructions":
      return buildOpenCodeFiles(targetHome, adapter, profile, sources);
    case "antigravity-rules":
      return buildAntigravityRuleFiles(targetHome, adapter, sources);
  }
}

function adapterFor(input: SessionRenderInput): SessionToolAdapter {
  if (input.tool !== "codewith") return SESSION_TOOL_ADAPTERS[input.tool];
  const gatedNativeImports =
    input.codewithNativeImports === true ||
    process.env[CODEWITH_NATIVE_IMPORTS_ENV] === "1" ||
    process.env[CODEWITH_NATIVE_IMPORTS_ENV] === "true";
  return gatedNativeImports ? CODEWITH_NATIVE_ADAPTER : CODEWITH_FLATTENED_ADAPTER;
}

function getHomeDir(): string {
  return process.env["CONFIGS_HOME"] || process.env["HOME"] || homedir();
}

export function cleanSessionPathInput(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function resolveSessionPath(path: string): string {
  const cleaned = cleanSessionPathInput(path);
  if (!cleaned) throw new Error("Session render path cannot be empty.");
  const home = getHomeDir();
  if (cleaned === "~") return resolve(home);
  if (cleaned.startsWith("~/")) return resolve(home, cleaned.slice(2));
  if (cleaned === "{{HOME}}" || cleaned === "${HOME}") return resolve(home);
  if (cleaned.startsWith("{{HOME}}/")) return resolve(home, cleaned.slice("{{HOME}}/".length));
  if (cleaned.startsWith("${HOME}/")) return resolve(home, cleaned.slice("${HOME}/".length));
  return resolve(cleaned);
}

function assertSafeRelativePath(relativePath: string): string {
  if (!relativePath.trim()) throw new Error("Session render relative path cannot be empty.");
  if (relativePath.includes("\\")) throw new Error(`Session render relative path must use POSIX separators: ${relativePath}`);
  const normalized = posix.normalize(relativePath);
  if (normalized === "." || posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Session render relative path escapes target root: ${relativePath}`);
  }
  return normalized;
}

function assertSafeTargetRoot(targetHome: string): string {
  if (!isAbsolute(targetHome)) throw new Error(`Session render target must be an absolute path: ${targetHome}`);
  const normalized = resolve(targetHome);
  if (normalized === parse(normalized).root) {
    throw new Error(`Session render target cannot be the filesystem root: ${targetHome}`);
  }
  return normalized;
}

function resolveRenderTarget(input: SessionRenderInput): {
  targetHome: string;
  targetKind: SessionRenderTargetKind;
  blockers: string[];
} {
  if (input.tool === "cursor" || input.tool === "antigravity") {
    if (!input.projectRoot) {
      const label = input.tool === "cursor" ? "Cursor rules" : "Antigravity rules";
      const path = input.tool === "cursor" ? ".cursor/rules files" : ".agents/rules files";
      return {
        targetHome: defaultTargetHome(input.tool, input.profile, input.sessionId),
        targetKind: "blocked",
        blockers: [
          `${label} are project-scoped; pass --project-root (or projectRoot) before applying ${path}. --target-home is not treated as a repository root for ${input.tool}.`,
        ],
      };
    }
    return {
      targetHome: resolveSessionPath(input.projectRoot),
      targetKind: "project-root",
      blockers: [],
    };
  }

  return {
    targetHome: input.targetHome
      ? resolveSessionPath(input.targetHome)
      : defaultTargetHome(input.tool, input.profile, input.sessionId),
    targetKind: "session-home",
    blockers: [],
  };
}

export function resolveSessionTargetOwnership(input: Pick<SessionRenderInput, "tool" | "profile" | "projectRoot">, target: {
  targetHome: string;
  targetKind: SessionRenderTargetKind;
}): SessionTargetOwner {
  if (target.targetKind === "blocked") {
    return {
      kind: "blocked",
      tool: input.tool,
      profile: input.profile,
      targetHome: target.targetHome,
      projectRoot: input.projectRoot ? resolveSessionPath(input.projectRoot) : null,
      ownedBy: "open-configs",
      reason: "target resolution blocked before provider files can be owned",
    };
  }
  if (target.targetKind === "project-root") {
    return {
      kind: "project",
      tool: input.tool,
      profile: input.profile,
      targetHome: target.targetHome,
      projectRoot: target.targetHome,
      ownedBy: "open-configs",
      reason: "project-scoped provider files are generated in the explicit repository root",
    };
  }
  return {
    kind: "provider-profile",
    tool: input.tool,
    profile: input.profile,
    targetHome: target.targetHome,
    projectRoot: null,
    ownedBy: "open-configs",
    reason: "profile-scoped provider home is generated by OpenConfigs from identity/config sources",
  };
}

export function planSessionRender(input: SessionRenderInput): SessionRenderPlan {
  if (!SESSION_RENDER_TOOLS.includes(input.tool)) throw new Error(`Unsupported session render tool: ${input.tool}`);
  if (!input.profile.trim()) throw new Error("Session render profile is required.");

  const adapter = adapterFor(input);
  const { targetHome, targetKind, blockers } = resolveRenderTarget(input);
  const targetOwner = resolveSessionTargetOwnership(input, { targetHome, targetKind });
  const blocked = blockers.length > 0;
  const allowEmptySources = input.allowEmptySources === true;
  const orderedSources = composeSources(normalizeSources(input.sources, input.tool, allowEmptySources));
  if (orderedSources.length === 0 && !allowEmptySources) {
    throw new Error("Session render has no instruction sources. Pass --allow-empty-sources only for explicit empty renders.");
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const env = adapter.envVar && !blocked ? { [adapter.envVar]: targetHome } : {};
  const warnings = [
    ...(orderedSources.length === 0 ? ["No instruction sources were provided."] : []),
    ...blockers,
  ];
  const baseFiles = blocked ? [] : buildFiles(targetHome, adapter, input.profile, orderedSources);
  const projectContext = blocked
    ? null
    : composeProjectContextSessionRender({
      tool: input.tool,
      adapter_mode: adapter.mode,
      target_home: targetHome,
      project_root: input.projectRoot,
      files: baseFiles,
    });
  const projectContextGuard = blocked
    ? null
    : projectContext?.guard ?? observeProjectContextSessionGuard({
      tool: input.tool,
      target_home: targetHome,
      project_root: input.projectRoot,
    });
  if (projectContext && orderedSources.some((source) => source.id === projectContext.source.id)) {
    throw new Error(`Session source ${projectContext.source.id} is reserved for the durable Instructions project-context renderer.`);
  }
  const files = projectContext?.files ?? baseFiles;
  rejectDuplicateRenderPaths(files);

  const manifest: SessionRenderManifest = {
    schema: SESSION_RENDER_SCHEMA,
    tool: input.tool,
    adapterMode: adapter.mode,
    profile: input.profile,
    sessionId: input.sessionId ?? null,
    targetHome,
    targetKind,
    targetOwner,
    writable: !blocked,
    blocked,
    blockers,
    generatedAt,
    env,
    sourceHash: fingerprint(projectContext
      ? {
        sources: orderedSources.map((source) => ({
          id: source.id,
          layer: source.resolvedLayer,
          order: source.resolvedOrder,
          merge: source.resolvedMerge,
          content: source.content,
          rules: source.resolvedRules.map((rule) => ({ id: rule.id, path: rule.resolvedPath, content: rule.content })),
          hash: source.hash ?? null,
        })),
        projectContext: projectContext.project_context,
      }
      : orderedSources.map((source) => ({
        id: source.id,
        layer: source.resolvedLayer,
        order: source.resolvedOrder,
        merge: source.resolvedMerge,
        content: source.content,
        rules: source.resolvedRules.map((rule) => ({ id: rule.id, path: rule.resolvedPath, content: rule.content })),
        hash: source.hash ?? null,
      }))),
    sources: [
      ...orderedSources.map((source) => ({
        id: source.id,
        label: source.resolvedLabel,
        layer: source.resolvedLayer,
        merge: source.resolvedMerge,
        order: source.resolvedOrder,
        path: source.path ?? null,
        targetProviders: source.targetProviders ?? [],
        owner: source.owner ?? null,
        sourcePaths: source.sourcePaths ?? [],
        hash: source.hash ?? null,
        nonOverridable: source.nonOverridable === true,
        replacementScope: source.replacementScope ?? null,
        rules: source.resolvedRules.map((rule) => ({
          id: rule.id,
          label: rule.resolvedLabel,
          path: rule.resolvedPath,
          globs: rule.globs ?? [],
          hash: rule.hash ?? null,
        })),
        provenance: source.provenance ?? null,
      })),
      ...(projectContext ? [projectContext.source] : []),
    ],
    skippedSources: [],
    files: files.map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      role: file.role,
      sha256: file.sha256,
      sourceIds: file.sourceIds,
    })),
    warnings,
    ...(projectContext
      ? {
        projectContext: projectContext.project_context,
        compatibility: projectContext.compatibility,
      }
      : {}),
  };
  const manifestFile = makeFile(
    targetHome,
    posix.join(".hasna", "session-render-manifest.json"),
    "manifest",
    JSON.stringify(manifest, null, 2),
    orderedSources.map((source) => source.id),
  );

  return {
    dryRun: true,
    tool: input.tool,
    adapter,
    profile: input.profile,
    sessionId: input.sessionId ?? null,
    targetHome,
    targetKind,
    targetOwner,
    writable: !blocked,
    blocked,
    blockers,
    env,
    files,
    manifest,
    manifestFile,
    allFiles: [...files, manifestFile],
    warnings,
    ...(projectContextGuard ? { projectContextGuard } : {}),
  };
}

export function sourceFromFilePath(path: string, content: string, order = 0): SessionInstructionSource {
  const file = basename(path);
  return {
    id: file.replace(extname(file), ""),
    label: file,
    content,
    layer: "agent",
    order,
    path,
  };
}

export function sourceFromConfig(
  config: Pick<Config, "slug" | "name" | "content" | "agent" | "target_path">,
  order = 0,
  layer?: SessionInstructionLayer,
): SessionInstructionSource {
  return {
    id: config.slug,
    label: config.name,
    content: config.content,
    layer: layer ?? (config.agent === "global" ? "global" : "agent"),
    order,
    path: config.target_path ?? undefined,
    provenance: {
      source: "open-configs",
      configSlug: config.slug,
      configAgent: config.agent,
    },
  };
}

export function sourcesFromIdentityExport(
  value: unknown,
  options: { path?: string; tool?: SessionRenderTool; orderOffset?: number } = {},
): SessionInstructionSource[] {
  const record = asRecord(value, "identity instruction export");
  const shape = requireIdentityExportShape(record);
  const validation = asOptionalRecord(record["validation"]);
  if (validation && validation["valid"] === false) {
    const issues = Array.isArray(validation["issues"]) ? validation["issues"] : [];
    throw new Error(`Identity instruction export is invalid: ${JSON.stringify(issues)}`);
  }
  const sources = record["sources"];
  if (!Array.isArray(sources)) throw new Error("Identity instruction export sources must be an array.");
  const offset = options.orderOffset ?? 0;
  return sources
    .map((item, index) => identitySourceToSessionSource(item, {
      path: options.path,
      tool: options.tool,
      orderFallback: offset + index,
      exportShape: shape,
    }))
    .filter((source): source is SessionInstructionSource => source !== null);
}

function requireIdentityExportShape(record: Record<string, unknown>): IdentityExportShape {
  if (record["contract"] === "hasna.identities.configs-instructions/v1") return "configs-contract";
  if (record["version"] === 1 && record["package"] === "@hasna/identities") return "canonical-open-identities";
  throw new Error("Unsupported identity instruction export contract.");
}

function normalizeInstructionRules(source: SessionInstructionSource, tool: SessionRenderTool): OrderedSessionInstructionRule[] {
  const seen = new Set<string>();
  return (source.rules ?? []).map((rule) => {
    if (!rule.id.trim()) throw new Error(`Instruction rule id is required for source ${source.id}.`);
    const content = filterProviderOnlyBlocks(rule.content ?? "", tool);
    if (!content.trim() && !rule.path) throw new Error(`Instruction rule content or path is required for rule ${rule.id}.`);
    const resolvedPath = normalizeRulePath(rule.path ?? `${slug(rule.id)}.md`);
    const key = resolvedPath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate rule path for source ${source.id}: ${resolvedPath}`);
    seen.add(key);
    return {
      ...rule,
      content,
      normalizedId: slug(rule.id),
      resolvedLabel: rule.label ?? rule.id,
      resolvedPath,
    };
  });
}

function rejectDuplicateRenderPaths(files: SessionRenderFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.relativePath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate session render file path: ${file.relativePath}`);
    seen.add(key);
  }
}

function rejectDuplicateSourceSlugs(sources: OrderedSessionInstructionSource[]): void {
  const seen = new Map<string, string>();
  for (const source of sources) {
    const existing = seen.get(source.normalizedId);
    if (existing) throw new Error(`Duplicate session instruction source slug: ${source.normalizedId} (${existing}, ${source.id})`);
    seen.set(source.normalizedId, source.id);
  }
}

function rejectDuplicateRulePaths(sources: OrderedSessionInstructionSource[]): void {
  const seen = new Map<string, string>();
  for (const source of sources) {
    for (const rule of source.resolvedRules) {
      const key = rule.resolvedPath.toLowerCase();
      const existing = seen.get(key);
      if (existing) throw new Error(`Duplicate instruction rule path: ${rule.resolvedPath} (${existing}, ${rule.id})`);
      seen.set(key, rule.id);
    }
  }
}

function normalizeRulePath(path: string): string {
  if (!path.trim()) throw new Error("Instruction rule path cannot be empty.");
  if (path.includes("\\")) throw new Error(`Instruction rule path must use POSIX separators: ${path}`);
  const normalized = posix.normalize(path);
  if (normalized === "." || posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Instruction rule path escapes managed rule directory: ${path}`);
  }
  return normalized;
}

function identitySourceToSessionSource(
  value: unknown,
  options: { path?: string; tool?: SessionRenderTool; orderFallback: number; exportShape: IdentityExportShape },
): SessionInstructionSource | null {
  const record = asRecord(value, "identity instruction source");
  const providers = asStringArray(record["targetProviders"]);
  if (options.tool && providers.length > 0 && !providerTargetsTool(providers, options.tool)) return null;
  const sourcePaths = normalizeSourcePaths(record["sourcePaths"]);
  const kind = maybeString(record["kind"]);
  const layer = record["layer"] === undefined ? layerFromIdentityKind(kind, options.exportShape) : requireLayer(record["layer"]);
  const merge = requireMerge(record["merge"] ?? record["mergePolicy"] ?? "append");
  const id = requireString(record["id"], "identity instruction source id");
  const inlineContent = maybeString(record["content"]);
  const resolvedContent = inlineContent && inlineContent.trim()
    ? inlineContent
    : contentFromIdentitySourcePaths(sourcePaths, options.path, id) ?? inlineContent;
  return {
    id,
    label: maybeString(record["label"]) ?? maybeString(record["title"]) ?? id,
    layer,
    merge,
    order: typeof record["order"] === "number"
      ? record["order"]
      : typeof record["precedence"] === "number"
        ? record["precedence"]
        : options.orderFallback,
    content: resolvedContent ?? "",
    path: options.path,
    rules: normalizeIdentityRules(record["rules"]),
    provenance: asOptionalRecord(record["provenance"]) ?? null,
    targetProviders: providers,
    owner: normalizeIdentityOwner(record["owner"]),
    sourcePaths,
    globs: asStringArray(record["globs"]),
    hash: maybeString(record["hash"]),
    nonOverridable: record["nonOverridable"] === true,
    replacementScope: maybeString(record["replacementScope"]),
    metadata: asOptionalRecord(record["metadata"]) ?? null,
  };
}

function layerFromIdentityKind(kind: string | undefined, exportShape: IdentityExportShape): SessionInstructionLayer {
  if (!kind) {
    if (exportShape === "configs-contract") throw new Error("Invalid session instruction layer: undefined");
    return "agent";
  }
  switch (kind) {
    case "global-rules":
    case "global-system-prompt":
      return "global";
    case "provider-rules":
    case "provider-system-prompt":
      return "tool";
    case "identity-doc":
    case "persona-doc":
      return "agent";
    case "account-overlay":
      return "account";
    case "project-overlay":
      return "repo";
    case "machine-overlay":
      return "machine";
    case "session-overlay":
      return "session";
    default:
      throw new Error(`Invalid identity instruction source kind: ${kind}`);
  }
}

function contentFromIdentitySourcePaths(
  sourcePaths: SessionInstructionSourcePath[],
  exportPath: string | undefined,
  sourceId: string,
): string | undefined {
  if (sourcePaths.length === 0 || !exportPath) return undefined;
  const baseDir = dirname(resolveSessionPath(exportPath));
  const contents: Array<{ path: string; content: string }> = [];
  for (const sourcePath of sourcePaths) {
    const content = readIdentitySourcePath(sourcePath, baseDir, sourceId);
    if (content !== undefined) contents.push({ path: sourcePath.path, content });
  }
  if (contents.length === 0) return undefined;
  if (contents.length === 1) return ensureTrailingNewline(contents[0]!.content);
  return ensureTrailingNewline(contents.map((item) => `<!-- Source path: ${item.path} -->\n${item.content.trimEnd()}`).join("\n\n"));
}

function readIdentitySourcePath(
  sourcePath: SessionInstructionSourcePath,
  baseDir: string,
  sourceId: string,
): string | undefined {
  const resolvedPath = resolveIdentitySourcePath(sourcePath.path, baseDir, sourceId);
  if (!existsSync(resolvedPath)) {
    if (sourcePath.required) {
      throw new Error(`Required identity instruction source path not found for ${sourceId}: ${sourcePath.path}`);
    }
    return undefined;
  }
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Identity instruction source path is not a file for ${sourceId}: ${sourcePath.path}`);
  }
  const realBase = realpathSync(baseDir);
  const realPath = realpathSync(resolvedPath);
  if (!pathIsInside(realPath, realBase)) {
    throw new Error(`Identity instruction source path escapes export directory for ${sourceId}: ${sourcePath.path}`);
  }
  return readFileSync(realPath, "utf-8");
}

function resolveIdentitySourcePath(path: string, baseDir: string, sourceId: string): string {
  const cleaned = cleanSessionPathInput(path);
  if (!cleaned) throw new Error(`Identity instruction source path cannot be empty for ${sourceId}.`);
  if (cleaned.includes("\\")) throw new Error(`Identity instruction source path must use POSIX separators for ${sourceId}: ${path}`);
  const resolvedPath = isAbsolute(cleaned) ? resolve(cleaned) : resolve(baseDir, cleaned);
  if (!pathIsInside(resolvedPath, resolve(baseDir))) {
    throw new Error(`Identity instruction source path escapes export directory for ${sourceId}: ${path}`);
  }
  return resolvedPath;
}

function pathIsInside(path: string, baseDir: string): boolean {
  const rel = relative(baseDir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function providerTargetsTool(targets: string[], tool: SessionRenderTool): boolean {
  return targets.map((target) => target.toLowerCase()).some((target) => target === tool || target === "all" || target === "generic");
}

function normalizeIdentityRules(value: unknown): SessionInstructionRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Identity instruction source rules must be an array.");
  return value.map((item) => {
    const record = asRecord(item, "identity instruction rule");
    const id = requireString(record["id"], "identity instruction rule id");
    return {
      id,
      label: maybeString(record["label"]) ?? id,
      path: maybeString(record["path"]),
      content: maybeString(record["content"]) ?? "",
      globs: asStringArray(record["globs"]),
      hash: maybeString(record["hash"]),
      metadata: asOptionalRecord(record["metadata"]) ?? null,
    };
  });
}

function normalizeIdentityOwner(value: unknown): SessionInstructionOwner | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, "identity instruction owner");
  return {
    kind: requireString(record["kind"], "identity instruction owner kind"),
    id: requireString(record["id"], "identity instruction owner id"),
  };
}

function normalizeSourcePaths(value: unknown): SessionInstructionSourcePath[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Identity instruction source paths must be an array.");
  return value.map((item) => {
    const record = asRecord(item, "identity instruction source path");
    return {
      path: requireString(record["path"], "identity instruction source path"),
      editable: record["editable"] === true,
      required: record["required"] === true,
      hash: maybeString(record["hash"]),
    };
  });
}

function requireLayer(value: unknown): SessionInstructionLayer {
  return normalizeSessionInstructionLayer(value);
}

function requireMerge(value: unknown): SessionInstructionMerge {
  if (value === "append" || value === "replace") return value;
  throw new Error(`Invalid session instruction merge policy: ${String(value)}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return asRecord(value, "record");
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}.`);
  return value;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
