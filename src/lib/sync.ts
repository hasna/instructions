import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Config, ConfigAgent, ConfigCategory, ConfigFormat, ConfigOutput, SyncResult } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";
import { applyConfig, expandPath, getConfigHome, normalizeTargetPath } from "./apply.js";
import { isRetiredOrUnsupportedConfigAgent, retiredOrUnsupportedAgentReason } from "./config-agents.js";
import { redactContent } from "./redact.js";
import { detectMachineContext, templateizeMachineContent } from "./machine.js";
import { applyTransform } from "./transforms.js";

// ── Known config map ──────────────────────────────────────────────────────────
// These are the ONLY files `configs sync` will ingest by default.
// Explicit, curated — no directory walking.

export interface KnownConfig {
  path: string; // ~ prefixed
  name: string;
  category: ConfigCategory;
  agent: ConfigAgent;
  format?: ConfigFormat;
  kind?: "file" | "reference";
  description?: string;
  optional?: boolean; // if true, missing file is not an issue in doctor
  // If set, read all *.md files from this dir instead of a single file
  rulesDir?: string;
  rulesExtensions?: string[];
  outputs?: ConfigOutput[];
}

export const CLAUDE_PROMPT_OUTPUTS: ConfigOutput[] = [
  { agent: "codex", target_path: "~/.codex/AGENTS.md", transform: "codex-flat" },
  { agent: "codewith", target_path: "~/.codewith/CODEWITH.md", transform: "codex-flat" },
  { agent: "opencode", target_path: "~/.config/opencode/AGENTS.md", transform: "opencode-flat" },
  { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
  { agent: "antigravity", target_path: "~/.gemini/GEMINI.md", transform: "codex-flat" },
  { agent: "cursor", target_path: "~/.cursor/rules/claude.mdc", transform: "cursor-mdc" },
];

function claudeRuleOutputs(fileName: string): ConfigOutput[] {
  const stem = basename(fileName, extname(fileName));
  return [
    { agent: "cursor", target_path: `~/.cursor/rules/${stem}.mdc`, transform: "cursor-mdc" },
  ];
}

function normalizeOutputs(outputs: ConfigOutput[] | undefined): ConfigOutput[] {
  return outputs ?? [];
}

function outputsEqual(a: ConfigOutput[] | undefined, b: ConfigOutput[] | undefined): boolean {
  return JSON.stringify(normalizeOutputs(a)) === JSON.stringify(normalizeOutputs(b));
}

function outputOwnerIdsByTarget(configs: Config[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const config of configs) {
    for (const output of config.outputs) {
      const targetPath = normalizeTargetPath(output.target_path);
      const existing = owners.get(targetPath) ?? new Set<string>();
      existing.add(config.id);
      owners.set(targetPath, existing);
    }
  }
  return owners;
}

function isGeneratedOutputTarget(config: Config, owners: Map<string, Set<string>>): boolean {
  if (!config.target_path) return false;
  const ownerIds = owners.get(normalizeTargetPath(config.target_path));
  return !!ownerIds && !ownerIds.has(config.id);
}

function hasClaudePromptSource(): boolean {
  return existsSync(expandPath("~/.claude/CLAUDE.md"));
}

function hasClaudeRuleSourceForCursorTarget(targetPath: string): boolean {
  const absoluteTargetPath = expandPath(targetPath);
  const absolutePrefix = expandPath("~/.cursor/rules");
  if (!absoluteTargetPath.startsWith(`${absolutePrefix}/`) || !absoluteTargetPath.endsWith(".mdc")) return false;
  const stem = basename(absoluteTargetPath, ".mdc");
  return existsSync(expandPath(`~/.claude/rules/${stem}.md`)) ||
    existsSync(expandPath(`~/.claude/rules/${stem}.mdc`));
}

function isKnownGeneratedTargetPath(targetPath: string): boolean {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const promptTargets = new Set(CLAUDE_PROMPT_OUTPUTS.map((output) => normalizeTargetPath(output.target_path)));
  if (promptTargets.has(normalizedTargetPath)) return hasClaudePromptSource();
  return hasClaudeRuleSourceForCursorTarget(targetPath);
}

export const KNOWN_CONFIGS: KnownConfig[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  { path: "~/.claude/CLAUDE.md",         name: "claude-claude-md",         category: "rules",  agent: "claude", format: "markdown", outputs: CLAUDE_PROMPT_OUTPUTS },
  { path: "~/.claude/settings.json",     name: "claude-settings",          category: "agent",  agent: "claude", format: "json" },
  { path: "~/.claude/settings.local.json", name: "claude-settings-local",  category: "agent",  agent: "claude", format: "json" },
  { path: "~/.claude/keybindings.json",  name: "claude-keybindings",       category: "agent",  agent: "claude", format: "json", optional: true },
  // rules/*.md — handled specially via rulesDir
  { path: "~/.claude/rules",             name: "claude-rules",             category: "rules",  agent: "claude", rulesDir: "~/.claude/rules", rulesExtensions: [".md", ".mdc"] },

  // ── Codex ──────────────────────────────────────────────────────────────────
  { path: "~/.codex/config.toml",        name: "codex-config",             category: "agent",  agent: "codex",  format: "toml" },
  { path: "~/.codex/AGENTS.md",          name: "codex-agents-md",          category: "rules",  agent: "codex",  format: "markdown" },

  // ── OpenCode ───────────────────────────────────────────────────────────────
  { path: "~/.config/opencode/AGENTS.md",    name: "opencode-agents-md",    category: "rules", agent: "opencode", format: "markdown", optional: true },
  { path: "~/.config/opencode/opencode.json", name: "opencode-config",      category: "mcp",   agent: "opencode", format: "json", optional: true, description: "OpenCode config (includes Skills MCP server entries)" },

  // ── Cursor ─────────────────────────────────────────────────────────────────
  { path: "~/.cursor/rules",             name: "cursor-rules",             category: "rules",  agent: "cursor", rulesDir: "~/.cursor/rules", rulesExtensions: [".md", ".mdc"] },
  { path: "~/.cursor/mcp.json",          name: "cursor-mcp",               category: "mcp",    agent: "cursor", format: "json", optional: true, description: "Cursor MCP config (includes Skills MCP server entries)" },

  // ── codewith ───────────────────────────────────────────────────────────────
  { path: "~/.codewith/CODEWITH.md",      name: "codewith-codewith-md",      category: "rules", agent: "codewith", format: "markdown", optional: true },
  { path: "~/.codewith/config.toml",      name: "codewith-config",           category: "mcp",   agent: "codewith", format: "toml", optional: true, description: "codewith config (Codex fork, includes Skills MCP server entries)" },

  // ── aicopilot ──────────────────────────────────────────────────────────────
  { path: "~/.config/aicopilot/AICOPILOT.md", name: "aicopilot-aicopilot-md", category: "rules", agent: "aicopilot", format: "markdown", optional: true },
  { path: "~/.config/aicopilot/aicopilot.json", name: "aicopilot-config",    category: "mcp",   agent: "aicopilot", format: "json", optional: true, description: "AI Copilot config (includes instructions and MCP server entries)" },

  // ── Antigravity ────────────────────────────────────────────────────────────
  // Google Antigravity's current docs keep the global rules/MCP files under
  // legacy-named ~/.gemini paths. These entries belong to the antigravity
  // agent target; they do not re-enable a retired gemini target.
  { path: "~/.gemini/GEMINI.md",          name: "antigravity-global-rules", category: "rules",  agent: "antigravity", format: "markdown", optional: true, description: "Google Antigravity global rules file" },
  { path: "~/.gemini/config/mcp_config.json", name: "antigravity-global-mcp", category: "mcp", agent: "antigravity", format: "json", optional: true, description: "Google Antigravity global MCP server entries" },

  // ── MCP ────────────────────────────────────────────────────────────────────
  { path: "~/.claude.json",              name: "claude-json",              category: "mcp",    agent: "claude", format: "json", description: "Claude Code global config (includes MCP server entries)" },

  // ── Shell ──────────────────────────────────────────────────────────────────
  { path: "~/.zshrc",                    name: "zshrc",                    category: "shell",  agent: "zsh" },
  { path: "~/.zprofile",                 name: "zprofile",                 category: "shell",  agent: "zsh", optional: true },
  { path: "~/.bashrc",                   name: "bashrc",                   category: "shell",  agent: "zsh", optional: true },
  { path: "~/.bash_profile",             name: "bash-profile",             category: "shell",  agent: "zsh", optional: true },

  // ── Git ────────────────────────────────────────────────────────────────────
  { path: "~/.gitconfig",                name: "gitconfig",                category: "git",    agent: "git",    format: "ini" },
  { path: "~/.gitignore_global",         name: "gitignore-global",         category: "git",    agent: "git", optional: true },

  // ── Tools ──────────────────────────────────────────────────────────────────
  { path: "~/.npmrc",                    name: "npmrc",                    category: "tools",  agent: "npm",    format: "ini" },
  { path: "~/.bunfig.toml",              name: "bunfig",                   category: "tools",  agent: "global", format: "toml", optional: true },
];

// ── Project-scoped config files ───────────────────────────────────────────────
// These are files that live inside a project root, not in ~.
export const PROJECT_CONFIG_FILES = [
  { file: "CLAUDE.md",                 category: "rules" as ConfigCategory,  agent: "claude" as ConfigAgent, format: "markdown" as ConfigFormat },
  { file: ".claude/settings.json",     category: "agent" as ConfigCategory,  agent: "claude" as ConfigAgent, format: "json" as ConfigFormat },
  { file: ".claude/settings.local.json", category: "agent" as ConfigCategory, agent: "claude" as ConfigAgent, format: "json" as ConfigFormat },
  { file: ".mcp.json",                 category: "mcp" as ConfigCategory,    agent: "claude" as ConfigAgent, format: "json" as ConfigFormat },
  { file: "AGENTS.md",                 category: "rules" as ConfigCategory,  agent: "codex" as ConfigAgent,  format: "markdown" as ConfigFormat },
  { file: ".codex/AGENTS.md",          category: "rules" as ConfigCategory,  agent: "codex" as ConfigAgent,  format: "markdown" as ConfigFormat },
  { file: ".opencode/AGENTS.md",       category: "rules" as ConfigCategory,  agent: "opencode" as ConfigAgent, format: "markdown" as ConfigFormat },
  { file: ".codewith/CODEWITH.md",      category: "rules" as ConfigCategory,  agent: "codewith" as ConfigAgent, format: "markdown" as ConfigFormat },
  { file: ".aicopilot/AICOPILOT.md",    category: "rules" as ConfigCategory,  agent: "aicopilot" as ConfigAgent, format: "markdown" as ConfigFormat },
  { file: "AICOPILOT.md",               category: "rules" as ConfigCategory,  agent: "aicopilot" as ConfigAgent, format: "markdown" as ConfigFormat },
  { file: ".cursor/mcp.json",          category: "mcp" as ConfigCategory,    agent: "cursor" as ConfigAgent, format: "json" as ConfigFormat },
  { file: ".agents/mcp_config.json",    category: "mcp" as ConfigCategory,    agent: "antigravity" as ConfigAgent, format: "json" as ConfigFormat },
];

export interface SyncProjectOptions {
  store?: ConfigStore;
  dryRun?: boolean;
  projectDir: string;
}

export async function syncProject(opts: SyncProjectOptions): Promise<SyncResult> {
  const store = opts.store ?? resolveConfigStore();
  const absDir = expandPath(opts.projectDir);
  const projectName = absDir.split("/").pop() || "project";
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, skipped: [] };
  const allConfigs = await store.listConfigs();
  const machine = detectMachineContext();

  // Sync project config files
  for (const pf of PROJECT_CONFIG_FILES) {
    const abs = join(absDir, pf.file);
    if (!existsSync(abs)) continue;
    try {
      const rawContent = readFileSync(abs, "utf-8");
      if (rawContent.length > 500_000) { result.skipped.push(pf.file); continue; }
      const redacted = redactContent(rawContent, pf.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
      const machineAware = templateizeMachineContent(redacted.content, machine);
      const content = machineAware.content;
      const isTemplate = redacted.isTemplate || machineAware.changed;
      const name = `${projectName}/${pf.file}`;
      const targetPath = abs.startsWith(getConfigHome()) ? abs.replace(getConfigHome(), "~") : abs;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === slug);

      if (!existing) {
        if (!opts.dryRun) await store.createConfig({ name, category: pf.category, agent: pf.agent, format: pf.format, content, target_path: targetPath, is_template: isTemplate });
        result.added++;
      } else if (existing.content !== content) {
        if (!opts.dryRun) await store.updateConfig(existing.id, { content, is_template: isTemplate });
        result.updated++;
      } else {
        result.unchanged++;
      }
    } catch { result.skipped.push(pf.file); }
  }

  for (const ruleDir of [
    { dir: join(absDir, ".claude", "rules"), agent: "claude" as ConfigAgent, namePrefix: "rules" },
    { dir: join(absDir, ".agents", "rules"), agent: "antigravity" as ConfigAgent, namePrefix: "antigravity-rules" },
  ]) {
    if (!existsSync(ruleDir.dir)) continue;
    const mdFiles = readdirSync(ruleDir.dir).filter((f) => f.endsWith(".md") || f.endsWith(".mdc"));
    for (const f of mdFiles) {
      const abs = join(ruleDir.dir, f);
      const raw = readFileSync(abs, "utf-8");
      const redacted = redactContent(raw, "markdown");
      const machineAware = templateizeMachineContent(redacted.content, machine);
      const content = machineAware.content;
      const isTemplate = redacted.isTemplate || machineAware.changed;
      const name = `${projectName}/${ruleDir.namePrefix}/${f}`;
      const targetPath = abs.startsWith(getConfigHome()) ? abs.replace(getConfigHome(), "~") : abs;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === slug);
      if (!existing) {
        if (!opts.dryRun) await store.createConfig({ name, category: "rules", agent: ruleDir.agent, format: "markdown", content, target_path: targetPath, is_template: isTemplate });
        result.added++;
      } else if (existing.content !== content) {
        if (!opts.dryRun) await store.updateConfig(existing.id, { content, is_template: isTemplate });
        result.updated++;
      } else { result.unchanged++; }
    }
  }

  return result;
}

export interface SyncKnownOptions {
  store?: ConfigStore;
  dryRun?: boolean;
  agent?: ConfigAgent;
  category?: ConfigCategory;
}

export async function syncKnown(opts: SyncKnownOptions = {}): Promise<SyncResult> {
  const store = opts.store ?? resolveConfigStore();
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, skipped: [] };
  const home = getConfigHome();
  const machine = detectMachineContext();

  let targets = KNOWN_CONFIGS;
  if (opts.agent) targets = targets.filter((k) => k.agent === opts.agent);
  if (opts.category) targets = targets.filter((k) => k.category === opts.category);

  const allConfigs = await store.listConfigs();
  const existingOutputOwners = outputOwnerIdsByTarget(allConfigs);

  for (const known of targets) {
    // rulesDir: ingest each *.md file individually
    if (known.rulesDir) {
      const absDir = expandPath(known.rulesDir);
      if (!existsSync(absDir)) { result.skipped.push(known.rulesDir); continue; }
      const extensions = known.rulesExtensions ?? [".md", ".mdc"];
      const ruleFiles = readdirSync(absDir).filter((f) => extensions.some((ext) => f.endsWith(ext)));
      for (const f of ruleFiles) {
        const abs = join(absDir, f);
        const targetPath = abs.replace(home, "~");
        if (existingOutputOwners.has(normalizeTargetPath(targetPath)) || isKnownGeneratedTargetPath(targetPath)) {
          result.skipped.push(`${targetPath} (generated output)`);
          continue;
        }
        const raw = readFileSync(abs, "utf-8");
        const redacted = redactContent(raw, "markdown");
        const machineAware = templateizeMachineContent(redacted.content, machine);
        const content = machineAware.content;
        const isTemplate = redacted.isTemplate || machineAware.changed;
        const name = `${known.name}-${f}`;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === slug);
        const outputs = known.agent === "claude" ? claudeRuleOutputs(f) : known.outputs;
        if (!existing) {
          if (!opts.dryRun) await store.createConfig({ name, category: known.category, agent: known.agent, format: "markdown", content, target_path: targetPath, is_template: isTemplate, outputs });
          result.added++;
        } else if (existing.content !== content) {
          if (!opts.dryRun) await store.updateConfig(existing.id, { content, is_template: isTemplate, outputs });
          result.updated++;
        } else if (!outputsEqual(existing.outputs, outputs)) {
          if (!opts.dryRun) await store.updateConfig(existing.id, { outputs });
          result.updated++;
        } else {
          result.unchanged++;
        }
      }
      continue;
    }

    const abs = expandPath(known.path);
    if (!existsSync(abs)) { result.skipped.push(known.path); continue; }

    try {
      const rawContent = readFileSync(abs, "utf-8");
      if (rawContent.length > 500_000) { result.skipped.push(known.path + " (too large)"); continue; }
      const fmt = known.format ?? detectFormat(abs);
      // Always redact before storing
      const redacted = redactContent(rawContent, fmt as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
      const machineAware = templateizeMachineContent(redacted.content, machine);
      const content = machineAware.content;
      const isTemplate = redacted.isTemplate || machineAware.changed;
      const targetPath = abs.replace(home, "~");
      if (existingOutputOwners.has(normalizeTargetPath(targetPath)) || isKnownGeneratedTargetPath(targetPath)) {
        result.skipped.push(`${targetPath} (generated output)`);
        continue;
      }
      const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === known.name);

      if (!existing) {
        if (!opts.dryRun) {
          await store.createConfig({
            name: known.name,
            category: known.category,
            agent: known.agent,
            format: fmt,
            content,
            target_path: known.kind === "reference" ? null : targetPath,
            kind: known.kind ?? "file",
            description: known.description,
            is_template: isTemplate,
            outputs: known.outputs,
          });
        }
        result.added++;
      } else if (existing.content !== content) {
        if (!opts.dryRun) await store.updateConfig(existing.id, { content, is_template: isTemplate, outputs: known.outputs });
        result.updated++;
      } else if (!outputsEqual(existing.outputs, known.outputs)) {
        if (!opts.dryRun) await store.updateConfig(existing.id, { outputs: known.outputs });
        result.updated++;
      } else {
        result.unchanged++;
      }
    } catch {
      result.skipped.push(known.path);
    }
  }
  return result;
}

// ── Apply configs back to disk ────────────────────────────────────────────────
export interface SyncToDiskOptions {
  store?: ConfigStore;
  dryRun?: boolean;
  agent?: ConfigAgent;
  category?: ConfigCategory;
}

export async function syncToDisk(opts: SyncToDiskOptions = {}): Promise<SyncResult> {
  const store = opts.store ?? resolveConfigStore();
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, skipped: [] };

  const allFileConfigs = await store.listConfigs({ kind: "file", ...opts.category ? { category: opts.category } : {} });
  const outputOwners = outputOwnerIdsByTarget(allFileConfigs);
  let configs = allFileConfigs.filter((config) => {
    return !isGeneratedOutputTarget(config, outputOwners);
  }).filter((config) => {
    if (!opts.agent) return true;
    return config.agent === opts.agent || config.outputs.some((output) => output.agent === opts.agent);
  });

  for (const config of configs) {
    if (!config.target_path && config.outputs.length === 0) continue;
    if (isRetiredOrUnsupportedConfigAgent(config.agent)) {
      result.skipped.push(`${config.slug} (${retiredOrUnsupportedAgentReason(config.agent)})`);
      continue;
    }
    try {
      const r = await applyConfig(config, { dryRun: opts.dryRun, store, outputAgent: opts.agent });
      r.changed ? result.updated++ : result.unchanged++;
    } catch {
      result.skipped.push(config.target_path ?? config.id);
    }
  }
  return result;
}

// ── Diff a config against disk ────────────────────────────────────────────────
export interface DiffConfigOptions {
  store?: ConfigStore;
}

function buildDiff(expectedContent: string, targetPath: string): string {
  const path = expandPath(targetPath);
  if (!existsSync(path)) return `(file not found on disk: ${path})`;
  const diskContent = readFileSync(path, "utf-8");
  if (diskContent === expectedContent) return "(no diff — identical)";

  const stored = expectedContent.split("\n");
  const disk = diskContent.split("\n");
  const lines: string[] = [`--- stored (DB)`, `+++ disk (${path})`];
  const maxLen = Math.max(stored.length, disk.length);
  for (let i = 0; i < maxLen; i++) {
    const s = stored[i];
    const dk = disk[i];
    if (s === dk) { if (s !== undefined) lines.push(` ${s}`); }
    else {
      if (s !== undefined) lines.push(`-${s}`);
      if (dk !== undefined) lines.push(`+${dk}`);
    }
  }
  return lines.join("\n");
}

export async function diffConfig(config: Config, opts: DiffConfigOptions = {}): Promise<string> {
  if (!config.target_path && config.outputs.length === 0) return "(reference — no target path)";

  const diffs: string[] = [];
  const store = opts.store ?? resolveConfigStore();
  const contextConfigs = config.outputs.length > 0 || config.target_path
    ? await store.listConfigs()
    : [config];

  if (isGeneratedOutputTarget(config, outputOwnerIdsByTarget(contextConfigs))) {
    return "(generated output — managed by fan-out)";
  }

  if (config.target_path) {
    const diff = buildDiff(config.content, config.target_path);
    if (!diff.includes("no diff")) diffs.push(diff);
  }

  if (config.outputs.length > 0) {
    for (const output of config.outputs) {
      const expected = applyTransform(config, output, { configs: contextConfigs });
      const diff = buildDiff(expected, output.target_path);
      if (!diff.includes("no diff")) diffs.push(diff);
    }
  }

  return diffs.length > 0 ? diffs.join("\n\n") : "(no diff — identical)";
}

// ── Helpers (kept for tests + add command) ────────────────────────────────────
export function detectCategory(filePath: string): ConfigCategory {
  const p = filePath.toLowerCase().replace(getConfigHome(), "~");
  if (p.includes("/.claude/rules/") || p.includes("/.cursor/rules/") || p.includes("/.agents/rules/") || p.endsWith("claude.md") || p.endsWith("agents.md") || p.endsWith("codewith.md") || p.endsWith("aicopilot.md") || p.endsWith("/.gemini/gemini.md") || p.endsWith(".mdc")) return "rules";
  if (p.includes(".mcp.json") || p.includes("mcp")) return "mcp";
  if (p.includes("/.claude/") || p.includes("/.codex/") || p.includes("/.antigravity/") || p.includes("/.agents/") || p.includes("/.cursor/") || p.includes("/.config/opencode/") || p.includes("/.codewith/") || p.includes("/.config/aicopilot/")) return "agent";
  if (p.includes(".zshrc") || p.includes(".zprofile") || p.includes(".bashrc") || p.includes(".bash_profile")) return "shell";
  if (p.includes(".gitconfig") || p.includes(".gitignore")) return "git";
  if (p.includes(".npmrc") || p.includes("tsconfig") || p.includes("bunfig")) return "tools";
  if (p.includes(".secrets")) return "secrets_schema";
  return "tools";
}

export function detectAgent(filePath: string): ConfigAgent {
  const p = filePath.toLowerCase().replace(getConfigHome(), "~");
  if (p.endsWith("/.gemini/gemini.md") || p.endsWith("/.gemini/config/mcp_config.json")) return "antigravity";
  if (p.includes("/.agents/rules/") || p.endsWith("/.agents/mcp_config.json")) return "antigravity";
  if (p.includes("/.claude/") || p.endsWith("claude.md")) return "claude";
  if (p.includes("/.config/opencode/")) return "opencode";
  if (p.includes("/.cursor/") || p.endsWith(".mdc")) return "cursor";
  if (p.includes("/.codewith/") || p.endsWith("codewith.md")) return "codewith";
  if (p.includes("/.config/aicopilot/")) return "aicopilot";
  if (p.includes("/.antigravity/")) return "antigravity";
  if (p.includes("/.codex/") || p.endsWith("agents.md")) return "codex";
  if (p.includes(".zshrc") || p.includes(".zprofile") || p.includes(".bashrc")) return "zsh";
  if (p.includes(".gitconfig") || p.includes(".gitignore")) return "git";
  if (p.includes(".npmrc")) return "npm";
  return "global";
}

export function detectFormat(filePath: string): ConfigFormat {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".toml") return "toml";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".md" || ext === ".mdc" || ext === ".markdown") return "markdown";
  if (ext === ".ini" || ext === ".cfg") return "ini";
  return "text";
}

// Legacy: kept for explicit directory sync (e.g. custom dirs the user adds manually)
export { Config };
export type { SyncFromDirOptions } from "./sync-dir.js";
export { syncFromDir, syncToDir } from "./sync-dir.js";
