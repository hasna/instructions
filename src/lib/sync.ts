import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import type { Config, ConfigAgent, ConfigCategory, ConfigFormat, SyncResult } from "../types/index.js";
import { getDatabase } from "../db/database.js";
import { createConfig, listConfigs, updateConfig } from "../db/configs.js";
import { applyConfig, expandPath } from "./apply.js";
import { redactContent } from "./redact.js";
import { detectMachineContext, templateizeMachineContent } from "./machine.js";

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
}

export const KNOWN_CONFIGS: KnownConfig[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  { path: "~/.claude/CLAUDE.md",         name: "claude-claude-md",         category: "rules",  agent: "claude", format: "markdown" },
  { path: "~/.claude/settings.json",     name: "claude-settings",          category: "agent",  agent: "claude", format: "json" },
  { path: "~/.claude/settings.local.json", name: "claude-settings-local",  category: "agent",  agent: "claude", format: "json" },
  { path: "~/.claude/keybindings.json",  name: "claude-keybindings",       category: "agent",  agent: "claude", format: "json", optional: true },
  // rules/*.md — handled specially via rulesDir
  { path: "~/.claude/rules",             name: "claude-rules",             category: "rules",  agent: "claude", rulesDir: "~/.claude/rules" },

  // ── Codex ──────────────────────────────────────────────────────────────────
  { path: "~/.codex/config.toml",        name: "codex-config",             category: "agent",  agent: "codex",  format: "toml" },
  { path: "~/.codex/AGENTS.md",          name: "codex-agents-md",          category: "rules",  agent: "codex",  format: "markdown" },

  // ── Gemini ─────────────────────────────────────────────────────────────────
  { path: "~/.gemini/settings.json",     name: "gemini-settings",          category: "agent",  agent: "gemini", format: "json" },
  { path: "~/.gemini/GEMINI.md",         name: "gemini-gemini-md",         category: "rules",  agent: "gemini", format: "markdown", optional: true },

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
  { file: "GEMINI.md",                 category: "rules" as ConfigCategory,  agent: "gemini" as ConfigAgent, format: "markdown" as ConfigFormat },
];

export interface SyncProjectOptions {
  db?: ReturnType<typeof getDatabase>;
  dryRun?: boolean;
  projectDir: string;
}

export async function syncProject(opts: SyncProjectOptions): Promise<SyncResult> {
  const d = opts.db || getDatabase();
  const absDir = expandPath(opts.projectDir);
  const projectName = absDir.split("/").pop() || "project";
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, skipped: [] };
  const allConfigs = listConfigs(undefined, d);
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
      const targetPath = abs.replace(homedir(), "~");
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === slug);

      if (!existing) {
        if (!opts.dryRun) createConfig({ name, category: pf.category, agent: pf.agent, format: pf.format, content, target_path: targetPath, is_template: isTemplate }, d);
        result.added++;
      } else if (existing.content !== content) {
        if (!opts.dryRun) updateConfig(existing.id, { content, is_template: isTemplate }, d);
        result.updated++;
      } else {
        result.unchanged++;
      }
    } catch { result.skipped.push(pf.file); }
  }

  // Also sync .claude/rules/*.md if exists
  const rulesDir = join(absDir, ".claude", "rules");
  if (existsSync(rulesDir)) {
    const mdFiles = readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
    for (const f of mdFiles) {
      const abs = join(rulesDir, f);
      const raw = readFileSync(abs, "utf-8");
      const redacted = redactContent(raw, "markdown");
      const machineAware = templateizeMachineContent(redacted.content, machine);
      const content = machineAware.content;
      const isTemplate = redacted.isTemplate || machineAware.changed;
      const name = `${projectName}/rules/${f}`;
      const targetPath = abs.replace(homedir(), "~");
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === slug);
      if (!existing) {
        if (!opts.dryRun) createConfig({ name, category: "rules", agent: "claude", format: "markdown", content, target_path: targetPath, is_template: isTemplate }, d);
        result.added++;
      } else if (existing.content !== content) {
        if (!opts.dryRun) updateConfig(existing.id, { content, is_template: isTemplate }, d);
        result.updated++;
      } else { result.unchanged++; }
    }
  }

  return result;
}

export interface SyncKnownOptions {
  db?: ReturnType<typeof getDatabase>;
  dryRun?: boolean;
  agent?: ConfigAgent;
  category?: ConfigCategory;
}

export async function syncKnown(opts: SyncKnownOptions = {}): Promise<SyncResult> {
  const d = opts.db || getDatabase();
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, skipped: [] };
  const home = homedir();
  const machine = detectMachineContext();

  let targets = KNOWN_CONFIGS;
  if (opts.agent) targets = targets.filter((k) => k.agent === opts.agent);
  if (opts.category) targets = targets.filter((k) => k.category === opts.category);

  const allConfigs = listConfigs(undefined, d);

  for (const known of targets) {
    // rulesDir: ingest each *.md file individually
    if (known.rulesDir) {
      const absDir = expandPath(known.rulesDir);
      if (!existsSync(absDir)) { result.skipped.push(known.rulesDir); continue; }
      const mdFiles = readdirSync(absDir).filter((f) => f.endsWith(".md"));
      for (const f of mdFiles) {
        const abs = join(absDir, f);
        const targetPath = abs.replace(home, "~");
        const raw = readFileSync(abs, "utf-8");
        const redacted = redactContent(raw, "markdown");
        const machineAware = templateizeMachineContent(redacted.content, machine);
        const content = machineAware.content;
        const isTemplate = redacted.isTemplate || machineAware.changed;
        const name = `claude-rules-${f}`;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === slug);
        if (!existing) {
          if (!opts.dryRun) createConfig({ name, category: "rules", agent: "claude", format: "markdown", content, target_path: targetPath, is_template: isTemplate }, d);
          result.added++;
        } else if (existing.content !== content) {
          if (!opts.dryRun) updateConfig(existing.id, { content, is_template: isTemplate }, d);
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
      const existing = allConfigs.find((c) => c.target_path === targetPath || c.slug === known.name);

      if (!existing) {
        if (!opts.dryRun) {
          createConfig({
            name: known.name,
            category: known.category,
            agent: known.agent,
            format: fmt,
            content,
            target_path: known.kind === "reference" ? null : targetPath,
            kind: known.kind ?? "file",
            description: known.description,
            is_template: isTemplate,
          }, d);
        }
        result.added++;
      } else if (existing.content !== content) {
        if (!opts.dryRun) updateConfig(existing.id, { content, is_template: isTemplate }, d);
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
  db?: ReturnType<typeof getDatabase>;
  dryRun?: boolean;
  agent?: ConfigAgent;
  category?: ConfigCategory;
}

export async function syncToDisk(opts: SyncToDiskOptions = {}): Promise<SyncResult> {
  const d = opts.db || getDatabase();
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, skipped: [] };

  let configs = listConfigs({ kind: "file", ...opts.agent ? { agent: opts.agent } : {}, ...opts.category ? { category: opts.category } : {} }, d);

  for (const config of configs) {
    if (!config.target_path) continue;
    try {
      const r = await applyConfig(config, { dryRun: opts.dryRun, db: d });
      r.changed ? result.updated++ : result.unchanged++;
    } catch {
      result.skipped.push(config.target_path);
    }
  }
  return result;
}

// ── Diff a config against disk ────────────────────────────────────────────────
export function diffConfig(config: Config): string {
  if (!config.target_path) return "(reference — no target path)";
  const path = expandPath(config.target_path);
  if (!existsSync(path)) return `(file not found on disk: ${path})`;
  const diskContent = readFileSync(path, "utf-8");
  if (diskContent === config.content) return "(no diff — identical)";

  const stored = config.content.split("\n");
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

// ── Helpers (kept for tests + add command) ────────────────────────────────────
export function detectCategory(filePath: string): ConfigCategory {
  const p = filePath.toLowerCase().replace(homedir(), "~");
  if (p.includes("/.claude/rules/") || p.endsWith("claude.md") || p.endsWith("agents.md") || p.endsWith("gemini.md")) return "rules";
  if (p.includes("/.claude/") || p.includes("/.codex/") || p.includes("/.gemini/") || p.includes("/.cursor/")) return "agent";
  if (p.includes(".mcp.json") || p.includes("mcp")) return "mcp";
  if (p.includes(".zshrc") || p.includes(".zprofile") || p.includes(".bashrc") || p.includes(".bash_profile")) return "shell";
  if (p.includes(".gitconfig") || p.includes(".gitignore")) return "git";
  if (p.includes(".npmrc") || p.includes("tsconfig") || p.includes("bunfig")) return "tools";
  if (p.includes(".secrets")) return "secrets_schema";
  return "tools";
}

export function detectAgent(filePath: string): ConfigAgent {
  const p = filePath.toLowerCase().replace(homedir(), "~");
  if (p.includes("/.claude/") || p.endsWith("claude.md")) return "claude";
  if (p.includes("/.codex/") || p.endsWith("agents.md")) return "codex";
  if (p.includes("/.gemini/") || p.endsWith("gemini.md")) return "gemini";
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
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".ini" || ext === ".cfg") return "ini";
  return "text";
}

// Legacy: kept for explicit directory sync (e.g. custom dirs the user adds manually)
export { Config };
export type { SyncFromDirOptions } from "./sync-dir.js";
export { syncFromDir, syncToDir } from "./sync-dir.js";
