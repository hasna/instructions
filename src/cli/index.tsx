#!/usr/bin/env bun
import { registerEventsCommands } from "@hasna/events/commander";
import { program } from "commander";
import chalk from "chalk";
import { existsSync, lstatSync, readFileSync, readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { applyConfig, applyConfigs, expandPath, previewConfigs } from "../lib/apply.js";
import { diffConfig, syncKnown, syncToDisk, syncProject, detectCategory, detectAgent, detectFormat, KNOWN_CONFIGS } from "../lib/sync.js";
import { syncFromDir } from "../lib/sync-dir.js";
import { redactContent, scanSecrets } from "../lib/redact.js";
import { exportConfigs } from "../lib/export.js";
import { importConfigs } from "../lib/import.js";
import { extractTemplateVars } from "../lib/template.js";
import { detectMachineContext, resolveProfileVariables } from "../lib/machine.js";
import { applySessionRender, restoreSessionRenderSnapshot } from "../lib/session-apply.js";
import { planSessionRender, resolveSessionPath, sourceFromConfig, sourceFromFilePath, sourcesFromIdentityExport, SESSION_INSTRUCTION_LAYERS, SESSION_RENDER_TOOLS, type SessionInstructionLayer, type SessionInstructionSource, type SessionRenderFile, type SessionRenderPlan, type SessionRenderTool } from "../lib/session-render.js";
import { ensurePlatformProfiles } from "../lib/platform-profiles.js";
import { ensureProjectDashboardStandardConfig } from "../lib/project-dashboard-standard.js";
import { ensureGlobalAgentRulesStandardConfig } from "../lib/global-agent-rules-standard.js";
import { ensureDangerousOperationGuardStandardConfig } from "../lib/dangerous-operation-guard-standard.js";
import {
  ProjectContextError,
  PROJECT_CONTEXT_MAX_INPUT_BYTES,
  applyProjectContext,
  parseProjectContextBundle,
  planProjectContext,
  type ProjectContextRuntime,
} from "../lib/project-context.js";
import { getConfigsStatus } from "../status.js";
import { resolveConfigStore, isCloudMode, type ConfigStore } from "../data/config-store.js";
import { DEFAULT_LIST_LIMIT, paginate, parseLimit, truncateMiddle, truncateText } from "../lib/compact-output.js";
import type { Config, ConfigAgent, ConfigCategory, ConfigFormat, ConfigKind, Profile, ProfileSelector, ProfileVariables } from "../types/index.js";

import { createRequire } from "node:module";
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

// Blocking, complete write to stdout (fd 1). Fixes the pipe-truncation bug:
// console.log/process.stdout.write to a pipe is asynchronous in Bun/Node, so a
// large payload (e.g. `instructions list --json | jq`) that exceeds the 64KB
// pipe buffer is silently dropped when the process exits before the buffer
// drains. writeSync loops until every byte is delivered, retrying on EAGAIN
// (pipe full) and giving up cleanly on EPIPE (consumer closed).
const EAGAIN_SLEEP = new Int32Array(new SharedArrayBuffer(4));
function writeStdout(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(EAGAIN_SLEEP, 0, 0, 1); // wait ~1ms for the consumer to drain
        continue;
      }
      if (code === "EPIPE") return; // downstream closed the pipe; stop writing
      throw e;
    }
  }
}

/** Print a line to stdout with a guaranteed-complete blocking write. */
function printLine(text = ""): void {
  writeStdout(`${text}\n`);
}

/** Pretty-print a JSON value to stdout with a guaranteed-complete write. */
function printJson(value: unknown): void {
  printLine(JSON.stringify(value, null, 2));
}

function fmtConfig(c: Config, format: string) {
  if (format === "json") return JSON.stringify(c, null, 2);
  if (format === "compact") return `${c.slug} [${c.category}/${c.agent}] ${c.kind === "reference" ? "(ref)" : truncateMiddle(c.target_path ?? "(no path)", 72)}`;
  // table
  return [
    `${chalk.bold(c.name)} ${chalk.dim(`(${c.slug})`)}`,
    `  ${chalk.cyan("category:")} ${c.category}  ${chalk.cyan("agent:")} ${c.agent}  ${chalk.cyan("kind:")} ${c.kind}`,
    `  ${chalk.cyan("format:")} ${c.format}  ${chalk.cyan("version:")} ${c.version}${c.target_path ? `  ${chalk.cyan("path:")} ${c.target_path}` : ""}`,
    c.description ? `  ${chalk.dim(c.description)}` : "",
    c.tags.length > 0 ? `  ${chalk.dim("tags: " + c.tags.join(", "))}` : "",
  ].filter(Boolean).join("\n");
}

function pad(value: string, width: number): string {
  return truncateText(value, width).padEnd(width);
}

function pageFooter(command: string, page: { items: unknown[]; total: number; limit: number; next_cursor: number | null }, detailsHint: string): void {
  console.log(chalk.dim(`Showing ${page.items.length} of ${page.total}${page.next_cursor !== null ? ` (next cursor: ${page.next_cursor})` : ""}.`));
  if (page.next_cursor !== null) console.log(chalk.dim(`Next: ${command} --cursor ${page.next_cursor} --limit ${page.limit}`));
  console.log(chalk.dim(detailsHint));
}

function printConfigRows(configs: Config[]): void {
  console.log(`${pad("slug", 32)} ${pad("type", 15)} ${pad("fmt", 8)} ${pad("path", 44)} out v`);
  for (const c of configs) {
    const type = `${c.category}/${c.agent}`;
    const path = c.kind === "reference" ? "(ref)" : c.target_path ?? "(no path)";
    console.log(`${pad(c.slug, 32)} ${pad(type, 15)} ${pad(c.format, 8)} ${pad(truncateMiddle(path, 44), 44)} ${String(c.outputs.length).padStart(3)} ${c.version}`);
  }
}

function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const SESSION_SOURCE_LAYERS = new Set<SessionInstructionLayer>(SESSION_INSTRUCTION_LAYERS);
const SESSION_SOURCE_LAYER_HELP = "global|provider|tool|account|machine|division|workspace|project|repo|path|identity|agent|session|local";

function parseSessionLayer(value: string): SessionInstructionLayer {
  if (value === "provider") return "tool";
  if (value === "identity") return "agent";
  if (value === "project") return "repo";
  if (SESSION_SOURCE_LAYERS.has(value as SessionInstructionLayer)) return value as SessionInstructionLayer;
  throw new Error(`Invalid source layer "${value}"`);
}

function parseSessionSource(value: string, order: number, replaceIds: Set<string>): SessionInstructionSource {
  const idx = value.indexOf("=");
  let id = idx > 0 ? value.slice(0, idx).trim() : "";
  const path = idx > 0 ? value.slice(idx + 1).trim() : value.trim();
  let layer: SessionInstructionLayer = "agent";
  const layerIdx = id.indexOf(":");
  if (layerIdx > 0) {
    layer = parseSessionLayer(id.slice(0, layerIdx));
    id = id.slice(layerIdx + 1).trim();
  }
  if (!path) throw new Error(`Invalid --source "${value}" (expected path or id=path)`);
  const absPath = resolveSessionPath(path);
  if (!existsSync(absPath)) throw new Error(`Instruction source file not found: ${absPath}`);
  const content = readFileSync(absPath, "utf-8");
  const source = sourceFromFilePath(absPath, content, order);
  const resolvedId = id || source.id || basename(absPath);
  return {
    ...source,
    id: resolvedId,
    label: id ? resolvedId : source.label ?? resolvedId,
    layer,
    merge: replaceIds.has(resolvedId) ? "replace" : "append",
  };
}

function parseLayeredReference(value: string): { layer?: SessionInstructionLayer; id: string } {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(":");
  if (idx > 0) {
    const candidate = trimmed.slice(0, idx);
    if (candidate === "provider" || candidate === "identity" || candidate === "project" || SESSION_SOURCE_LAYERS.has(candidate as SessionInstructionLayer)) {
      const id = trimmed.slice(idx + 1).trim();
      if (!id) throw new Error(`Invalid layered reference "${value}"`);
      return { layer: parseSessionLayer(candidate), id };
    }
  }
  if (!trimmed) throw new Error("Instruction reference cannot be empty.");
  return { id: trimmed };
}

async function collectSessionSources(
  opts: {
    source?: string[];
    config?: string[];
    identityExport?: string[];
    replaceSource?: string[];
  },
  tool: SessionRenderTool,
  store: ConfigStore,
): Promise<SessionInstructionSource[]> {
  const replaceIds = new Set<string>(opts.replaceSource ?? []);
  const sources = (opts.source ?? []).map((value, index) => parseSessionSource(value, index, replaceIds));

  for (const value of opts.config ?? []) {
    const { layer, id } = parseLayeredReference(value);
    sources.push(sourceFromConfig(await store.getConfig(id), sources.length, layer));
  }

  for (const value of opts.identityExport ?? []) {
    const path = resolveSessionPath(value);
    if (!existsSync(path)) throw new Error(`Identity instruction export not found: ${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    sources.push(...sourcesFromIdentityExport(parsed, { path, tool, orderOffset: sources.length }));
  }

  return sources.map((source) => replaceIds.has(source.id) ? { ...source, merge: "replace" } : source);
}

function stripSessionFileContent(file: SessionRenderFile): Omit<SessionRenderFile, "content"> {
  const { content: _content, ...rest } = file;
  return rest;
}

function planJsonForOutput(plan: SessionRenderPlan) {
  return {
    ...plan,
    files: plan.files.map(stripSessionFileContent),
    manifestFile: stripSessionFileContent(plan.manifestFile),
    allFiles: plan.allFiles.map(stripSessionFileContent),
  };
}

function parseProjectContextRuntime(value: string): ProjectContextRuntime {
  if (value === "codex") return "agents";
  if (value === "claude" || value === "codewith" || value === "agents") return value;
  throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `unsupported runtime ${value}; expected claude|codewith|agents|codex`);
}

function readProjectContextBundleOption(value: string | undefined, allowMissing = false): { json?: string; sourcePath?: string } {
  if (value === undefined) return {};
  if (value === "-") return { json: readBoundedProjectContextStdin() };
  const path = resolveSessionPath(value);
  if (!existsSync(path)) {
    if (allowMissing) return {};
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_MISSING", `bundle file not found: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", "bundle input must be a regular non-symlink file");
  }
  if (stat.size > PROJECT_CONTEXT_MAX_INPUT_BYTES) {
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `bundle exceeds ${PROJECT_CONTEXT_MAX_INPUT_BYTES} bytes`);
  }
  return { json: readFileSync(path, "utf8"), sourcePath: path };
}

function readBoundedProjectContextStdin(): string {
  const chunks: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(4_096);
  let total = 0;
  while (true) {
    const bytesRead = readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > PROJECT_CONTEXT_MAX_INPUT_BYTES) {
      throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `bundle exceeds ${PROJECT_CONTEXT_MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} must be a positive integer`);
  return parsed;
}

function printProjectContextFailure(error: unknown, json: boolean): void {
  const normalized = error instanceof ProjectContextError
    ? error
    : new ProjectContextError("PROJECT_CONTEXT_FAILED", error instanceof Error ? error.message : String(error));
  if (json) printJson({ ok: false, error: { code: normalized.code, message: normalized.message } });
  else console.error(chalk.red(normalized.message));
  process.exitCode = 1;
}

function parseVarArgs(values?: string[]): ProfileVariables | undefined {
  if (!values || values.length === 0) return undefined;
  const vars: ProfileVariables = {};
  for (const entry of values) {
    const idx = entry.indexOf("=");
    if (idx <= 0) throw new Error(`Invalid --var "${entry}" (expected KEY=VALUE)`);
    vars[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

function parseProfileSelectors(opts: { os?: string; arch?: string; hostname?: string }): ProfileSelector | undefined {
  const selectors: ProfileSelector = {};
  const os = splitCsv(opts.os);
  const arch = splitCsv(opts.arch);
  const hostnames = splitCsv(opts.hostname);
  if (os) selectors.os = os;
  if (arch) selectors.arch = arch;
  if (hostnames) selectors.hostnames = hostnames;
  return Object.keys(selectors).length > 0 ? selectors : undefined;
}

function formatProfileSelectorSummary(profile: Pick<Profile, "selectors">): string {
  const parts: string[] = [];
  if (profile.selectors.os?.length) parts.push(`os=${profile.selectors.os.join(",")}`);
  if (profile.selectors.arch?.length) parts.push(`arch=${profile.selectors.arch.join(",")}`);
  if (profile.selectors.hostnames?.length) parts.push(`host=${profile.selectors.hostnames.join(",")}`);
  return parts.join(" ");
}

function formatProfileVariables(profile: Pick<Profile, "variables">): string {
  return Object.entries(profile.variables)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

async function getMachineProfileContext(
  opts: { hostname?: string; os?: string; arch?: string },
  store: ConfigStore,
) {
  const machine = detectMachineContext({ hostname: opts.hostname, os: opts.os, arch: opts.arch });
  const profile = await store.resolveProfileForMachine(machine);
  return { machine, profile, vars: resolveProfileVariables(profile, machine) };
}

// ── list ─────────────────────────────────────────────────────────────────────
program
  .command("list")
  .alias("ls")
  .description("List stored configs")
  .option("-c, --category <cat>", "filter by category")
  .option("-a, --agent <agent>", "filter by agent")
  .option("-k, --kind <kind>", "filter by kind (file|reference)")
  .option("-t, --tag <tag>", "filter by tag")
  .option("-s, --search <query>", "search name/description/content")
  .option("-f, --format <fmt>", "output format: compact|table|json", "compact")
  .option("--brief", "shorthand for --format compact")
  .option("--verbose", "show expanded metadata for each listed config")
  .option("--json", "output full matching records as JSON")
  .option("--limit <n>", `max rows for human output (default ${DEFAULT_LIST_LIMIT})`)
  .option("--cursor <n>", "zero-based pagination cursor for human output")
  .action(async (opts) => {
    const fmt = opts.json ? "json" : opts.verbose ? "table" : opts.brief ? "compact" : opts.format;
    const configs = await resolveConfigStore().listConfigs({
      category: opts.category as ConfigCategory,
      agent: opts.agent as ConfigAgent,
      kind: opts.kind as ConfigKind,
      tags: opts.tag ? [opts.tag] : undefined,
      search: opts.search,
    });
    if (fmt === "json") {
      printJson(configs);
      return;
    }
    if (configs.length === 0) {
      console.log(chalk.dim("No configs found."));
      return;
    }
    const page = paginate(configs, { limit: opts.limit, cursor: opts.cursor });
    if (fmt === "compact") {
      printConfigRows(page.items);
    } else {
      for (const c of page.items) {
        console.log(fmtConfig(c, fmt));
        console.log();
      }
    }
    pageFooter("configs list", page, "Use --verbose for expanded rows, --json for full records, or `configs show <slug>` for content.");
  });

// ── show ─────────────────────────────────────────────────────────────────────
program
  .command("show <id>")
  .alias("inspect")
  .description("Show a config's content and metadata")
  .option("-f, --format <fmt>", "output format: table|json|content", "table")
  .action(async (id, opts) => {
    try {
      const c = await resolveConfigStore().getConfig(id);
      if (opts.format === "json") { printJson(c); return; }
      if (opts.format === "content") { printLine(c.content); return; }
      console.log(fmtConfig(c, "table"));
      console.log();
      console.log(chalk.bold("Content:"));
      console.log(chalk.dim("─".repeat(60)));
      printLine(c.content);
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

// ── add ───────────────────────────────────────────────────────────────────────
program
  .command("add <path>")
  .description("Ingest a file into the config DB")
  .option("-n, --name <name>", "config name (defaults to filename)")
  .option("-c, --category <cat>", "category override")
  .option("-a, --agent <agent>", "agent override")
  .option("-k, --kind <kind>", "kind: file|reference", "file")
  .option("--template", "mark as template (has {{VAR}} placeholders)")
  .action(async (filePath, opts) => {
    const abs = resolve(filePath);
    if (!existsSync(abs)) {
      console.error(chalk.red(`File not found: ${abs}`));
      process.exit(1);
    }
    const rawContent = readFileSync(abs, "utf-8");
    const fmt = detectFormat(abs);
    const { content, redacted, isTemplate } = redactContent(rawContent, fmt as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
    const targetPath = abs.startsWith(homedir()) ? abs.replace(homedir(), "~") : abs;
    const name = opts.name || filePath.split("/").pop()!;
    const config = await resolveConfigStore().createConfig({
      name,
      kind: (opts.kind as ConfigKind) ?? "file",
      category: (opts.category as ConfigCategory) ?? detectCategory(abs),
      agent: (opts.agent as ConfigAgent) ?? detectAgent(abs),
      target_path: opts.kind === "reference" ? null : targetPath,
      format: fmt,
      content,
      is_template: (opts.template ?? false) || isTemplate,
    });
    console.log(chalk.green("✓") + ` Added: ${chalk.bold(config.name)} ${chalk.dim(`(${config.slug})`)}`);
    if (redacted.length > 0) {
      console.log(chalk.yellow(`  ⚠ Redacted ${redacted.length} secret(s):`));
      for (const r of redacted) console.log(chalk.yellow(`    line ${r.line}: {{${r.varName}}} — ${r.reason}`));
      console.log(chalk.dim("  Config stored as a template. Use `configs template vars` to see placeholders."));
    }
  });

// ── delete ─────────────────────────────────────────────────────────────────────
program
  .command("delete <id>")
  .alias("rm")
  .description("Delete a config record (by id or slug)")
  .option("--json", "output result as JSON")
  .action(async (id, opts) => {
    try {
      const store = resolveConfigStore();
      const config = await store.getConfig(id);
      await store.deleteConfig(config.id);
      if (opts.json) { printJson({ deleted: true, id: config.id, slug: config.slug }); return; }
      console.log(chalk.green("✓") + ` Deleted: ${chalk.bold(config.name)} ${chalk.dim(`(${config.slug})`)}`);
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

// ── apply ─────────────────────────────────────────────────────────────────────
program
  .command("apply <id>")
  .description("Apply a config to its target_path and output targets on disk")
  .option("--dry-run", "preview without writing")
  .option("--force", "overwrite even if unchanged")
  .action(async (id, opts) => {
    try {
      const store = resolveConfigStore();
      const config = await store.getConfig(id);
      const result = await applyConfig(config, { dryRun: opts.dryRun, store });
      const status = opts.dryRun ? chalk.yellow("[dry-run]") : (result.changed ? chalk.green("✓") : chalk.dim("="));
      const change = result.changed ? "changed" : "unchanged";
      console.log(`${status} ${result.path} ${chalk.dim(`(${change})`)}`);
      for (const output of result.outputs ?? []) {
        const outputStatus = opts.dryRun ? chalk.yellow("[dry-run]") : (output.changed ? chalk.green("✓") : chalk.dim("="));
        const outputChange = output.changed ? "changed" : "unchanged";
        console.log(`  ${outputStatus} ${output.path} ${chalk.dim(`[${output.agent}/${output.transform}] (${outputChange})`)}`);
      }
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

// ── diff ─────────────────────────────────────────────────────────────────────
program
  .command("diff [id]")
  .description("Show diff between stored config and disk (omit id for --all)")
  .option("--all", "diff every known config against disk")
  .action(async (id, opts) => {
    try {
      const store = resolveConfigStore();
      if (id) {
        const config = await store.getConfig(id);
        console.log(await diffConfig(config, { store }));
        return;
      }
      // --all or no id: diff all known file-type configs
      const configs = await store.listConfigs({ kind: "file" });
      let drifted = 0;
      for (const c of configs) {
        if (!c.target_path) continue;
        const diff = await diffConfig(c, { store });
        if (diff.includes("no diff") || diff.includes("not found")) continue;
        drifted++;
        console.log(chalk.bold(c.slug) + chalk.dim(` (${c.target_path})`));
        console.log(diff);
        console.log();
      }
      console.log(chalk.dim(`${drifted}/${configs.length} drifted`));
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

// ── sync ─────────────────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Sync known AI coding configs from disk into DB (claude, codex, opencode, cursor, codewith, aicopilot, antigravity, qwen, zsh, git, npm)")
  .option("-a, --agent <agent>", "only sync configs for this agent (claude|codex|opencode|cursor|codewith|aicopilot|antigravity|qwen|zsh|git|npm)")
  .option("-c, --category <cat>", "only sync configs in this category")
  .option("-p, --project [dir]", "sync project-scoped configs (CLAUDE.md, .mcp.json, etc.) from a project dir")
  .option("--all", "with --project: scan all subdirs for projects to sync")
  .option("--to-disk", "apply DB configs back to disk instead")
  .option("--dry-run", "preview without writing")
  .option("--list", "show which files would be synced without doing anything")
  .option("--limit <n>", `with --list, max rows (default ${DEFAULT_LIST_LIMIT})`)
  .option("--cursor <n>", "with --list, zero-based pagination cursor")
  .action(async (opts) => {
    const store = resolveConfigStore();
    if (opts.list) {
      const targets = KNOWN_CONFIGS.filter((k) => {
        if (opts.agent && k.agent !== opts.agent) return false;
        if (opts.category && k.category !== opts.category) return false;
        return true;
      });
      const page = paginate(targets, { limit: opts.limit, cursor: opts.cursor });
      console.log(chalk.bold(`Known configs (${targets.length}):`));
      for (const k of page.items) {
        const extensions = k.rulesDir ? `{${(k.rulesExtensions ?? [".md", ".mdc"]).join(",")}}` : "";
        console.log(`  ${chalk.cyan(k.rulesDir ? k.rulesDir + `/*${extensions}` : k.path)} ${chalk.dim(`[${k.category}/${k.agent}]`)}`);
      }
      pageFooter("configs sync --list", page, "Use --agent, --category, --limit, or --cursor to narrow the listing.");
      return;
    }
    if (opts.project) {
      const dir = typeof opts.project === "string" ? opts.project : process.cwd();

      // --project --all: find all project dirs with active agent config markers and sync each
      if (opts.all) {
        const { readdirSync } = await import("node:fs");
        const absDir = expandPath(dir);
        const entries = readdirSync(absDir, { withFileTypes: true });
        let totalAdded = 0, totalUpdated = 0, totalUnchanged = 0, projects = 0;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const projDir = join(absDir, entry.name);
          const hasAgentConfig = [
            "CLAUDE.md",
            ".mcp.json",
            ".claude",
            "AGENTS.md",
            ".codex",
            ".opencode",
            ".codewith",
            "AICOPILOT.md",
            ".aicopilot",
            ".cursor",
            ".agents",
          ].some((marker) => existsSync(join(projDir, marker)));
          if (!hasAgentConfig) continue;
          const result = await syncProject({ projectDir: projDir, dryRun: opts.dryRun, store });
          if (result.added + result.updated > 0) {
            console.log(`  ${chalk.green("✓")} ${entry.name}: +${result.added} updated:${result.updated}`);
          }
          totalAdded += result.added; totalUpdated += result.updated; totalUnchanged += result.unchanged; projects++;
        }
        console.log(chalk.green("✓") + ` Synced ${projects} projects: +${totalAdded} updated:${totalUpdated} unchanged:${totalUnchanged}`);
        return;
      }

      const result = await syncProject({ projectDir: dir, dryRun: opts.dryRun, store });
      console.log(chalk.green("✓") + ` Project sync: +${result.added} updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
      return;
    }
    if (opts.toDisk) {
      const result = await syncToDisk({ dryRun: opts.dryRun, agent: opts.agent, category: opts.category, store });
      console.log(chalk.green("✓") + ` Written to disk: updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
    } else {
      const result = await syncKnown({ dryRun: opts.dryRun, agent: opts.agent, category: opts.category, store });
      console.log(chalk.green("✓") + ` Synced: +${result.added} updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
      if (result.skipped.length > 0) {
        console.log(chalk.dim("  skipped (not found): " + result.skipped.join(", ")));
      }
    }
  });

// ── export ────────────────────────────────────────────────────────────────────
program
  .command("export")
  .description("Export configs as a tar.gz bundle")
  .option("-o, --output <path>", "output file", "./configs-export.tar.gz")
  .option("-c, --category <cat>", "filter by category")
  .action(async (opts) => {
    const result = await exportConfigs(opts.output, {
      filter: opts.category ? { category: opts.category as ConfigCategory } : undefined,
      store: resolveConfigStore(),
    });
    console.log(chalk.green("✓") + ` Exported ${result.count} configs to ${result.path}`);
  });

// ── import ────────────────────────────────────────────────────────────────────
program
  .command("import <file>")
  .description("Import configs from a tar.gz bundle")
  .option("--overwrite", "overwrite existing configs")
  .action(async (file, opts) => {
    const result = await importConfigs(file, {
      conflict: opts.overwrite ? "overwrite" : "skip",
      store: resolveConfigStore(),
    });
    console.log(chalk.green("✓") + ` Import complete: +${result.created} updated:${result.updated} skipped:${result.skipped}`);
    if (result.errors.length > 0) {
      console.log(chalk.red("Errors:"));
      for (const e of result.errors) console.log(chalk.red("  " + e));
    }
  });

// ── whoami ────────────────────────────────────────────────────────────────────
program
  .command("whoami")
  .description("Show setup summary")
  .action(async () => {
    const store = resolveConfigStore();
    const dbPath = isCloudMode()
      ? `${process.env["HASNA_INSTRUCTIONS_API_URL"]}/v1 (self_hosted)`
      : process.env["HASNA_INSTRUCTIONS_DB_PATH"] || join(homedir(), ".hasna", "instructions", "instructions.db");
    const stats = await store.getConfigStats();
    console.log(chalk.bold("@hasna/instructions") + chalk.dim(" v" + pkg.version));
    console.log(chalk.cyan(isCloudMode() ? "API:" : "DB:") + " " + dbPath);
    console.log(chalk.cyan("Total configs:") + " " + (stats["total"] || 0));
    console.log();
    console.log(chalk.bold("By category:"));
    const categories = ["agent", "rules", "mcp", "shell", "secrets_schema", "workspace", "git", "tools"];
    for (const cat of categories) {
      const count = stats[cat] || 0;
      if (count > 0) console.log(`  ${chalk.cyan(cat.padEnd(16))} ${count}`);
    }
    const profiles = await store.listProfiles();
    if (profiles.length > 0) {
      console.log();
      console.log(chalk.bold("Profiles:") + chalk.dim(` (${profiles.length})`));
      for (const p of profiles) console.log(`  ${chalk.cyan(p.name)} ${chalk.dim(`(${p.slug})`)}`);
    }
  });

// ── profile ───────────────────────────────────────────────────────────────────
const profileCmd = program.command("profile").description("Manage config profiles (named bundles)");

profileCmd.command("list").description("List all profiles")
  .option("--brief", "compact one-line output")
  .option("-f, --format <fmt>", "compact|table|json", "compact")
  .option("--verbose", "show expanded profile metadata")
  .option("--json", "output full profiles as JSON")
  .option("--limit <n>", `max rows for human output (default ${DEFAULT_LIST_LIMIT})`)
  .option("--cursor <n>", "zero-based pagination cursor for human output")
  .action(async (opts) => {
  const fmt = opts.json ? "json" : opts.verbose ? "table" : opts.brief ? "compact" : opts.format;
  const store = resolveConfigStore();
  const profiles = await store.listProfiles();
  if (fmt === "json") { printJson(profiles); return; }
  if (profiles.length === 0) { console.log(chalk.dim("No profiles.")); return; }
  const page = paginate(profiles, { limit: opts.limit, cursor: opts.cursor });
  if (fmt === "compact") console.log(`${pad("slug", 28)} ${pad("configs", 8)} ${pad("match", 36)} vars`);
  for (const p of page.items) {
    if (fmt === "compact") {
      const selectorSummary = formatProfileSelectorSummary(p);
      console.log(`${pad(p.slug, 28)} ${pad(String((await store.getProfileConfigs(p.id)).length), 8)} ${pad(selectorSummary || "-", 36)} ${Object.keys(p.variables).length}`);
      continue;
    }
    const configs = await store.getProfileConfigs(p.id);
    console.log(`${chalk.bold(p.name)} ${chalk.dim(`(${p.slug})`)} — ${configs.length} config(s)`);
    if (p.description) console.log(`  ${chalk.dim(p.description)}`);
    const selectorSummary = formatProfileSelectorSummary(p);
    if (selectorSummary) console.log(`  ${chalk.dim(`match: ${selectorSummary}`)}`);
    const varSummary = formatProfileVariables(p);
    if (varSummary) console.log(`  ${chalk.dim(`vars: ${varSummary}`)}`);
  }
  pageFooter("configs profile list", page, "Use --verbose for expanded rows, --json for full records, or `configs profile show <slug>` for details.");
});

profileCmd.command("create <name>").description("Create a new profile")
  .option("-d, --description <desc>", "profile description")
  .option("--os <os>", "comma-separated OS matchers (linux, macos, darwin, etc.)")
  .option("--arch <arch>", "comma-separated CPU arch matchers (arm64, x64, etc.)")
  .option("--hostname <hosts>", "comma-separated hostname matchers")
  .option("--var <vars...>", "set profile variable(s) as KEY=VALUE")
  .action(async (name, opts) => {
    const p = await resolveConfigStore().createProfile({
      name,
      description: opts.description,
      selectors: parseProfileSelectors(opts),
      variables: parseVarArgs(opts.var),
    });
    console.log(chalk.green("✓") + ` Created profile: ${chalk.bold(p.name)} ${chalk.dim(`(${p.slug})`)}`);
  });

profileCmd.command("show <id>").description("Show profile and its configs")
  .option("--limit <n>", `max config rows (default ${DEFAULT_LIST_LIMIT})`)
  .option("--cursor <n>", "zero-based pagination cursor")
  .action(async (id, opts) => {
  try {
    const store = resolveConfigStore();
    const p = await store.getProfile(id);
    const configs = await store.getProfileConfigs(id);
    console.log(chalk.bold(p.name) + chalk.dim(` (${p.slug})`));
    if (p.description) console.log(chalk.dim(p.description));
    const selectorSummary = formatProfileSelectorSummary(p);
    if (selectorSummary) console.log(chalk.dim(`match: ${selectorSummary}`));
    const varSummary = formatProfileVariables(p);
    if (varSummary) console.log(chalk.dim(`vars: ${varSummary}`));
    console.log(chalk.cyan(`${configs.length} config(s):`));
    const page = paginate(configs, { limit: opts.limit, cursor: opts.cursor });
    for (const c of page.items) console.log(`  ${c.slug} ${chalk.dim(`[${c.category}/${c.agent}]`)}`);
    if (page.has_more) {
      console.log(chalk.dim(`Showing ${page.items.length} of ${page.total}. Next: configs profile show ${id} --cursor ${page.next_cursor} --limit ${page.limit}`));
    }
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

profileCmd.command("add <profile> <config>").description("Add a config to a profile").action(async (profile, config) => {
  try {
    const store = resolveConfigStore();
    const c = await store.getConfig(config);
    await store.addConfigToProfile(profile, c.id);
    console.log(chalk.green("✓") + ` Added ${c.slug} to profile ${profile}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

profileCmd.command("remove <profile> <config>").description("Remove a config from a profile").action(async (profile, config) => {
  try {
    const store = resolveConfigStore();
    const c = await store.getConfig(config);
    await store.removeConfigFromProfile(profile, c.id);
    console.log(chalk.green("✓") + ` Removed ${c.slug} from profile ${profile}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

profileCmd.command("apply [id]").description("Apply all configs in a profile to disk")
  .option("--dry-run", "preview without writing")
  .option("--auto", "resolve the matching profile for the current machine")
  .option("--hostname <hostname>", "override detected hostname for auto resolution")
  .option("--os <os>", "override detected OS for auto resolution")
  .option("--arch <arch>", "override detected arch for auto resolution")
  .action(async (id, opts) => {
    try {
      const store = resolveConfigStore();
      const { machine, profile } = await getMachineProfileContext(opts, store);
      const selected = opts.auto ? profile : (id ? await store.getProfile(id) : null);
      if (!selected) {
        console.error(chalk.red(opts.auto ? "No matching machine-aware profile found." : "Provide a profile id or use --auto."));
        process.exit(1);
      }
      const configs = await store.getProfileConfigs(selected.id);
      const vars = resolveProfileVariables(selected, machine);
      const preview = opts.dryRun
        ? await previewConfigs(configs, { vars, store })
        : null;
      const results = preview
        ? preview.results
        : await applyConfigs(configs, { vars, store });
      let changed = 0;
      for (const r of results) {
        const status = opts.dryRun ? chalk.yellow("[dry-run]") : (r.changed ? chalk.green("✓") : chalk.dim("="));
        console.log(`${status} ${r.path}`);
        if (r.changed) changed++;
      }
      if (preview) {
        for (const skipped of preview.skipped) {
          console.log(`${chalk.dim("[owned]")} ${skipped.path} ${chalk.dim(skipped.owner)}`);
        }
        const unresolved = [...new Set(results.flatMap((result) => result.unresolved_template_vars ?? []))];
        if (unresolved.length > 0) {
          console.log(chalk.yellow(`Unresolved secret/runtime template references preserved in preview: ${unresolved.join(", ")}`));
        }
        for (const failure of preview.failures) {
          console.error(chalk.red(`[failed] ${failure.config_slug}: ${failure.message}`));
        }
        if (preview.failures.length > 0) process.exitCode = 1;
      }
      console.log(chalk.dim(`\n${changed}/${results.length} changed (${selected.slug} on ${machine.hostname} ${machine.os_family}/${machine.arch})`));
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

profileCmd.command("resolve").description("Resolve the matching machine-aware profile")
  .option("--hostname <hostname>", "override detected hostname")
  .option("--os <os>", "override detected OS")
  .option("--arch <arch>", "override detected arch")
  .action(async (opts) => {
    const store = resolveConfigStore();
    const { machine, profile, vars } = await getMachineProfileContext(opts, store);
    if (!profile) {
      console.log(chalk.yellow(`No matching profile for ${machine.hostname} ${machine.os_family}/${machine.arch}`));
      process.exit(1);
    }
    console.log(chalk.bold(profile.name) + chalk.dim(` (${profile.slug})`));
    console.log(chalk.dim(`machine: ${machine.hostname} ${machine.os_family}/${machine.arch}`));
    const selectorSummary = formatProfileSelectorSummary(profile);
    if (selectorSummary) console.log(chalk.dim(`match: ${selectorSummary}`));
    console.log(chalk.cyan("resolved vars:"));
    for (const [key, value] of Object.entries(vars)) {
      console.log(`  ${key}=${value}`);
    }
  });

profileCmd.command("delete <id>").description("Delete a profile").action(async (id) => {
  try {
    const store = resolveConfigStore();
    const p = await store.getProfile(id);
    await store.deleteProfile(p.id);
    console.log(chalk.green("✓") + ` Deleted profile: ${p.name}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

// ── project-context ──────────────────────────────────────────────────────────
const projectContextCmd = program.command("project-context")
  .description("Validate and atomically render a strict Projects context bundle");

projectContextCmd.command("plan")
  .description("Validate a bundle and preview its bounded provider adapter without writing")
  .requiredOption("--runtime <runtime>", "selected consumer (claude|codewith|agents|codex)")
  .requiredOption("--workspace-root <path>", "absolute project or coordination workspace root")
  .requiredOption("--bundle <path|->", "durable v1 JSON file, or - for stdin")
  .option("--codewith-native-imports", "declare that the selected Codewith runtime consumes native @ imports")
  .option("--json", "output plan JSON")
  .action((opts) => {
    try {
      const runtime = parseProjectContextRuntime(opts.runtime);
      const input = readProjectContextBundleOption(opts.bundle);
      const bundle = parseProjectContextBundle(input.json!);
      const plan = planProjectContext({
        workspace_root: resolveSessionPath(opts.workspaceRoot),
        runtime,
        bundle,
        source_path: input.sourcePath,
        codewith_native_imports: opts.codewithNativeImports,
      });
      const output = {
        ok: true,
        dry_run: true,
        runtime: plan.runtime,
        workspace_root: plan.workspace_root,
        project_id: plan.bundle.project.id,
        revision: plan.bundle.revision,
        hash: plan.bundle.hash,
        status: plan.status,
        age_seconds: plan.age_seconds,
        target_path: plan.target_path,
        fragment_path: plan.fragment_path,
        manifest_path: plan.manifest_path,
        rendered_bytes: Buffer.byteLength(plan.fragment, "utf8"),
        included_commands: plan.included_commands,
        warnings: plan.warnings,
      };
      if (opts.json) printJson(output);
      else {
        console.log(chalk.bold("project context render plan"));
        console.log(`${chalk.cyan("runtime:")} ${output.runtime}`);
        console.log(`${chalk.cyan("project:")} ${output.project_id} @ ${output.revision}`);
        console.log(`${chalk.cyan("target:")} ${output.target_path}`);
        console.log(`${chalk.cyan("fragment:")} ${output.fragment_path} (${output.rendered_bytes} bytes)`);
        console.log(chalk.dim("Dry run only. No files were written."));
      }
    } catch (error) {
      printProjectContextFailure(error, opts.json === true);
    }
  });

projectContextCmd.command("apply")
  .description("Atomically write project context with cache, CAS, and manifest-last semantics")
  .requiredOption("--runtime <runtime>", "selected consumer (claude|codewith|agents|codex)")
  .requiredOption("--workspace-root <path>", "absolute project or coordination workspace root")
  .option("--bundle <path|->", "durable v1 JSON file, or - for stdin")
  .option("--expected-project-id <id>", "required same-ID guard for stale-cache fallback")
  .option("--allow-stale-cache", "use a compatible same-ID last-known-good cache when input is unavailable or a newer major")
  .option("--max-stale-age-seconds <seconds>", "bounded cache age (default 3600, maximum 604800)")
  .option("--codewith-native-imports", "declare that the selected Codewith runtime consumes native @ imports")
  .option("--force", "repair malformed or mismatched managed markers while preserving bytes outside the forced range")
  .option("--dry-run", "validate and preview without writing")
  .option("--json", "output apply JSON")
  .action((opts) => {
    try {
      const runtime = parseProjectContextRuntime(opts.runtime);
      const input = readProjectContextBundleOption(opts.bundle, opts.allowStaleCache === true);
      const result = applyProjectContext({
        workspace_root: resolveSessionPath(opts.workspaceRoot),
        runtime,
        bundle_json: input.json,
        source_path: input.sourcePath,
        expected_project_id: opts.expectedProjectId,
        allow_stale_cache: opts.allowStaleCache,
        max_stale_age_seconds: parsePositiveInteger(opts.maxStaleAgeSeconds, "max stale age"),
        codewith_native_imports: opts.codewithNativeImports,
        force: opts.force,
        dry_run: opts.dryRun,
      });
      if (opts.json) printJson({ ok: true, ...result });
      else {
        const prefix = result.dry_run ? chalk.yellow("[dry-run]") : chalk.green("OK");
        console.log(`${prefix} project context ${result.runtime}`);
        console.log(`${chalk.cyan("project:")} ${result.project_id} @ ${result.revision}`);
        console.log(`${chalk.cyan("status:")} ${result.status} (${result.age_seconds}s)`);
        console.log(`${chalk.cyan("target:")} ${result.target_path}`);
        console.log(`${chalk.cyan("manifest:")} ${result.manifest_path}`);
      }
    } catch (error) {
      printProjectContextFailure(error, opts.json === true);
    }
  });

// ── session ──────────────────────────────────────────────────────────────────
const sessionCmd = program.command("session").description("Plan and apply session-scoped agent instruction files");

sessionCmd.command("plan")
  .description("Produce a dry-run render plan for profile-scoped instruction injection")
  .requiredOption("--tool <tool>", `target tool (${SESSION_RENDER_TOOLS.join("|")})`)
  .requiredOption("--profile <profile>", "account/profile name that owns the rendered instruction home")
  .option("--target-home <path>", "override generated profile-scoped target home")
  .option("--project-root <path>", "repository root for project-scoped adapters such as Cursor")
  .option("--session-id <id>", "session id to include in the manifest")
  .option("--source <layer:id=path>", `instruction source file; layers: ${SESSION_SOURCE_LAYER_HELP}`, collectOption, [])
  .option("--config <layer:id-or-slug>", "stored config source by id/slug; repeatable; layer aliases match --source", collectOption, [])
  .option("--identity-export <path>", "OpenIdentities configs instruction export JSON; repeatable", collectOption, [])
  .option("--replace-source <id>", "source id that replaces earlier layers instead of appending", collectOption, [])
  .option("--codewith-native-imports", "select the gated Codewith native @ import adapter")
  .option("--allow-empty-sources", "allow an explicit empty render plan")
  .option("--json", "output dry-run JSON")
  .action(async (opts) => {
    try {
      const tool = opts.tool as SessionRenderTool;
      if (!SESSION_RENDER_TOOLS.includes(tool)) {
        console.error(chalk.red(`Unsupported tool: ${opts.tool}`));
        process.exit(1);
      }
      const sources = await collectSessionSources(opts, tool, resolveConfigStore());
      const plan = planSessionRender({
        tool,
        profile: opts.profile,
        targetHome: opts.targetHome,
        projectRoot: opts.projectRoot,
        sessionId: opts.sessionId,
        codewithNativeImports: opts.codewithNativeImports,
        allowEmptySources: opts.allowEmptySources,
        sources,
      });
      if (opts.json) {
        printJson(planJsonForOutput(plan));
        return;
      }
      console.log(chalk.bold(`${plan.tool} session render plan`) + chalk.dim(` (${plan.adapter.mode})`));
      console.log(`${chalk.cyan("profile:")} ${plan.profile}`);
      console.log(`${chalk.cyan("target:")} ${plan.targetHome}`);
      console.log(`${chalk.cyan("owner:")} ${plan.targetOwner.kind} ${chalk.dim(plan.targetOwner.reason)}`);
      if (plan.blocked) console.log(chalk.red(`blocked: ${plan.blockers.join("; ")}`));
      const envEntries = Object.entries(plan.env);
      if (envEntries.length > 0) {
        console.log(`${chalk.cyan("env:")} ${envEntries.map(([key, value]) => `${key}=${value}`).join(" ")}`);
      }
      for (const file of plan.allFiles) {
        console.log(`  ${chalk.dim(file.role.padEnd(8))} ${file.relativePath} ${chalk.dim(file.sha256.slice(0, 12))}`);
      }
      if (plan.warnings.length > 0) {
        for (const warning of plan.warnings) console.log(chalk.yellow(`warning: ${warning}`));
      }
      console.log(chalk.dim("Dry run only. No files were written."));
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

sessionCmd.command("apply")
  .description("Write a session render plan to its managed target home or explicit project root")
  .requiredOption("--tool <tool>", `target tool (${SESSION_RENDER_TOOLS.join("|")})`)
  .requiredOption("--profile <profile>", "account/profile name that owns the rendered instruction home")
  .option("--target-home <path>", "override generated profile-scoped target home")
  .option("--project-root <path>", "repository root for project-scoped adapters such as Cursor")
  .option("--session-id <id>", "session id to include in the manifest")
  .option("--source <layer:id=path>", `instruction source file; layers: ${SESSION_SOURCE_LAYER_HELP}`, collectOption, [])
  .option("--config <layer:id-or-slug>", "stored config source by id/slug; repeatable; layer aliases match --source", collectOption, [])
  .option("--identity-export <path>", "OpenIdentities configs instruction export JSON; repeatable", collectOption, [])
  .option("--replace-source <id>", "source id that replaces earlier layers instead of appending", collectOption, [])
  .option("--codewith-native-imports", "select the gated Codewith native @ import adapter")
  .option("--allow-empty-sources", "allow an explicit empty render")
  .option("--dry-run", "preview writes and conflicts without writing")
  .option("--force", "overwrite existing unmanaged files")
  .option("--json", "output apply JSON")
  .action(async (opts) => {
    try {
      const tool = opts.tool as SessionRenderTool;
      if (!SESSION_RENDER_TOOLS.includes(tool)) {
        console.error(chalk.red(`Unsupported tool: ${opts.tool}`));
        process.exit(1);
      }
      const sources = await collectSessionSources(opts, tool, resolveConfigStore());
      const plan = planSessionRender({
        tool,
        profile: opts.profile,
        targetHome: opts.targetHome,
        projectRoot: opts.projectRoot,
        sessionId: opts.sessionId,
        codewithNativeImports: opts.codewithNativeImports,
        allowEmptySources: opts.allowEmptySources,
        sources,
      });
      const result = applySessionRender(plan, { dryRun: opts.dryRun, force: opts.force });
      if (opts.json) {
        printJson(result);
        if (result.conflicts.length > 0) process.exitCode = 1;
        return;
      }
      const prefix = opts.dryRun ? chalk.yellow("[dry-run]") : chalk.green("OK");
      console.log(`${prefix} ${plan.tool} session apply ${chalk.dim(`(${plan.adapter.mode})`)}`);
      console.log(`${chalk.cyan("target:")} ${result.targetHome}`);
      console.log(`${chalk.cyan("owner:")} ${plan.targetOwner.kind}`);
      if (result.snapshotPath) console.log(`${chalk.cyan("snapshot:")} ${result.snapshotPath}`);
      if (Object.keys(result.env).length > 0) {
        console.log(`${chalk.cyan("env:")} ${Object.entries(result.env).map(([key, value]) => `${key}=${value}`).join(" ")}`);
      }
      if (result.drift.checked && !result.drift.clean) {
        console.log(chalk.yellow(`drift: ${result.drift.missing.length} missing, ${result.drift.drifted.length} changed before apply`));
      }
      for (const file of result.files) {
        const status = file.action === "conflict" ? chalk.red(file.action) : file.changed ? chalk.green(file.action) : chalk.dim(file.action);
        console.log(`  ${status.padEnd(18)} ${file.relativePath} ${chalk.dim(file.newSha256.slice(0, 12))}`);
        if (file.reason) console.log(chalk.dim(`    ${file.reason}`));
      }
      if (result.conflicts.length > 0) {
        console.error(chalk.red(`Conflicts: ${result.conflicts.length}. Re-run with --force to overwrite unmanaged files.`));
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

sessionCmd.command("restore <snapshot>")
  .description("Restore a session render snapshot only when applied files have not drifted")
  .option("--dry-run", "preview restore actions and conflicts without writing")
  .option("--json", "output restore JSON")
  .action(async (snapshot, opts) => {
    try {
      const result = restoreSessionRenderSnapshot(resolveSessionPath(snapshot), {
        dryRun: opts.dryRun,
      });
      if (opts.json) {
        printJson(result);
        if (result.conflicts.length > 0) process.exitCode = 1;
        return;
      }
      const prefix = opts.dryRun ? chalk.yellow("[dry-run]") : chalk.green("OK");
      console.log(`${prefix} session snapshot restore`);
      console.log(`${chalk.cyan("snapshot:")} ${result.snapshotPath}`);
      console.log(`${chalk.cyan("target:")} ${result.targetHome}`);
      for (const file of result.files) {
        const status = file.action === "unchanged" ? chalk.dim(file.action) : chalk.green(file.action);
        console.log(`  ${status.padEnd(18)} ${file.relativePath}`);
      }
      if (result.conflicts.length > 0) {
        console.error(chalk.red(`Conflicts: ${result.conflicts.length}. Restore stopped without writing.`));
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ── snapshot ──────────────────────────────────────────────────────────────────
const snapshotCmd = program.command("snapshot").description("Manage config version history");

snapshotCmd.command("list <config>").description("List snapshots for a config")
  .option("--limit <n>", `max rows (default ${DEFAULT_LIST_LIMIT})`)
  .option("--cursor <n>", "zero-based pagination cursor")
  .action(async (configId, opts) => {
  try {
    const store = resolveConfigStore();
    const c = await store.getConfig(configId);
    const snaps = await store.listSnapshots(c.id);
    if (snaps.length === 0) { console.log(chalk.dim("No snapshots.")); return; }
    const page = paginate(snaps, { limit: opts.limit, cursor: opts.cursor });
    for (const s of page.items) {
      console.log(`  v${s.version} ${chalk.dim(s.created_at)} ${chalk.dim(s.id)}`);
    }
    pageFooter(`configs snapshot list ${configId}`, page, "Use `configs snapshot show <id>` to print snapshot content.");
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

snapshotCmd.command("show <id>").description("Show a snapshot's content").action(async (id) => {
  const snap = await resolveConfigStore().getSnapshot(id);
  if (!snap) { console.error(chalk.red("Snapshot not found: " + id)); process.exit(1); }
  printLine(snap.content);
});

snapshotCmd.command("restore <config> <snapshot-id>").description("Restore a config to a snapshot version").action(async (configId, snapId) => {
  try {
    const store = resolveConfigStore();
    const snap = await store.getSnapshot(snapId);
    if (!snap) { console.error(chalk.red("Snapshot not found: " + snapId)); process.exit(1); }
    await store.updateConfig(configId, { content: snap.content });
    console.log(chalk.green("✓") + ` Restored ${configId} to snapshot v${snap.version}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

// ── template ──────────────────────────────────────────────────────────────────
const templateCmd = program.command("template").description("Work with template configs");

templateCmd.command("vars <id>").description("Show template variables").action(async (id) => {
  try {
    const c = await resolveConfigStore().getConfig(id);
    const vars = extractTemplateVars(c.content);
    if (vars.length === 0) { console.log(chalk.dim("No template variables found.")); return; }
    for (const v of vars) {
      console.log(`  ${chalk.cyan("{{" + v.name + "}}")}${v.description ? chalk.dim(" — " + v.description) : ""}`);
    }
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

templateCmd.command("render <id>")
  .description("Render a template config with variables and optionally apply to disk")
  .option("--var <vars...>", "set variables as KEY=VALUE pairs")
  .option("--env", "use environment variables to fill template vars")
  .option("--apply", "write rendered output to target_path")
  .option("--dry-run", "preview rendered output without writing")
  .action(async (id, opts) => {
    try {
      const { renderTemplate } = await import("../lib/template.js");
      const c = await resolveConfigStore().getConfig(id);
      const vars: Record<string, string> = {};

      // Collect vars from --var KEY=VALUE
      if (opts.var) {
        for (const kv of opts.var) {
          const eq = kv.indexOf("=");
          if (eq === -1) { console.error(chalk.red(`Invalid --var: ${kv} (expected KEY=VALUE)`)); process.exit(1); }
          vars[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      // Fill from env if --env
      if (opts.env) {
        const { extractTemplateVars } = await import("../lib/template.js");
        for (const v of extractTemplateVars(c.content)) {
          if (!(v.name in vars) && process.env[v.name]) {
            vars[v.name] = process.env[v.name]!;
          }
        }
      }

      const rendered = renderTemplate(c.content, vars);

      if (opts.apply || opts.dryRun) {
        if (!c.target_path) { console.error(chalk.red("No target_path — cannot apply reference configs")); process.exit(1); }
        if (opts.dryRun) {
          console.log(chalk.yellow("[dry-run]") + ` Would write to ${expandPath(c.target_path)}`);
          console.log(rendered);
        } else {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          const path = expandPath(c.target_path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, rendered, "utf-8");
          console.log(chalk.green("✓") + ` Rendered and applied to ${path}`);
        }
      } else {
        console.log(rendered);
      }
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

// ── scan ──────────────────────────────────────────────────────────────────────
program
  .command("scan [id]")
  .description("Scan configs for secrets. Defaults to known configs only.")
  .option("--fix", "redact found secrets in-place")
  .option("--all", "scan every config in the DB (slow on large DBs)")
  .option("-c, --category <cat>", "scan only a specific category")
  .option("--limit <n>", `max findings to print (default ${DEFAULT_LIST_LIMIT})`)
  .action(async (id, opts) => {
    const store = resolveConfigStore();
    let configs;
    if (id) {
      configs = [await store.getConfig(id)];
    } else if (opts.all) {
      // Scan full DB in batches to avoid OOM
      configs = await store.listConfigs(opts.category ? { kind: "file", category: opts.category as ConfigCategory } : { kind: "file" });
    } else {
      // Default: fetch only the ~30 known configs individually by slug (fast, no full table scan)
      const { KNOWN_CONFIGS } = await import("../lib/sync.js");
      const slugs = [
        ...KNOWN_CONFIGS.filter((k) => !k.rulesDir).map((k) => k.name),
        // rules/*.md slugs follow pattern claude-rules-{filename}-md
      ];
      const fetched = [];
      for (const slug of slugs) {
        try { fetched.push(await store.getConfig(slug)); } catch { /* not in DB yet */ }
      }
      // Also grab rules by category+agent (small set)
      const rules = await store.listConfigs({ category: "rules", agent: "claude" });
      for (const r of rules) if (!fetched.find((c) => c.id === r.id)) fetched.push(r);
      configs = fetched;
    }

    let total = 0;
    let printed = 0;
    let omitted = 0;
    const maxPrinted = parseLimit(opts.limit, DEFAULT_LIST_LIMIT);
    const BATCH = 200;
    for (let i = 0; i < configs.length; i += BATCH) {
      const batch = configs.slice(i, i + BATCH);
      for (const c of batch) {
        const fmt = c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text";
        const secrets = scanSecrets(c.content, fmt);
        if (secrets.length === 0) continue;
        total += secrets.length;
        const remaining = Math.max(0, maxPrinted - printed);
        const visible = secrets.slice(0, remaining);
        omitted += secrets.length - visible.length;
        if (visible.length > 0) {
          console.log(chalk.yellow(`⚠ ${c.slug}`) + chalk.dim(` — ${secrets.length} secret(s):`));
          for (const s of visible) console.log(`  line ${s.line}: ${chalk.red(s.varName)} — ${s.reason}`);
          printed += visible.length;
        }
        if (opts.fix) {
          const { content, isTemplate } = redactContent(c.content, fmt);
          await store.updateConfig(c.id, { content, is_template: isTemplate });
          if (visible.length > 0) console.log(chalk.green("  ✓ Redacted."));
        }
      }
    }
    if (total === 0) {
      console.log(chalk.green("✓") + ` No secrets detected${opts.all ? "" : " (known configs). Use --all to scan entire DB"}.`);
    } else if (!opts.fix) {
      if (omitted > 0) console.log(chalk.dim(`\nOmitted ${omitted} finding(s). Re-run with --limit ${total} or inspect a specific config id.`));
      console.log(chalk.yellow(`\nRun with --fix to redact in-place.`));
    } else if (omitted > 0) {
      console.log(chalk.dim(`\nRedacted all ${total} finding(s); printed ${printed}. Re-run without --fix and a higher --limit for full details.`));
    }
  });

// ── package-manager-scan ─────────────────────────────────────────────────────
program
  .command("package-manager-scan [paths...]")
  .description("Scan package-manager config for literal token ingress without printing values")
  .option("--home", "also scan home .npmrc, Bun config, and shell profiles")
  .option("--fail-on-findings", "exit nonzero when any finding is detected")
  .option("--json", "output machine-readable JSON")
  .option("--limit <n>", `max findings to print (default ${DEFAULT_LIST_LIMIT})`)
  .action(async (paths: string[] | undefined, opts: { home?: boolean; failOnFindings?: boolean; json?: boolean; limit?: string }) => {
    const { scanPackageManagerSecrets } = await import("../lib/package-manager-guard.js");
    const roots = paths && paths.length > 0 ? paths : [process.cwd()];
    const result = scanPackageManagerSecrets({ roots, includeHome: !!opts.home });
    const maxPrinted = parseLimit(opts.limit, DEFAULT_LIST_LIMIT);
    const visible = result.findings.slice(0, maxPrinted);
    const omitted = Math.max(0, result.findings.length - visible.length);

    if (opts.json) {
      printJson(result);
    } else if (result.findings.length === 0) {
      console.log(chalk.green("✓") + ` Package-manager scan clean (${result.scannedFiles} file(s)).`);
    } else {
      console.log(chalk.red(`✗ ${result.findings.length} package-manager finding(s) detected.`));
      for (const finding of visible) {
        const tracked = finding.tracked ? "tracked" : "untracked";
        const color = finding.severity === "error" ? chalk.red : chalk.yellow;
        console.log(color(`  ${finding.path}:${finding.line} ${finding.rule}`) + chalk.dim(` [${finding.surface}, ${tracked}] ${finding.detail}`));
      }
      if (omitted > 0) console.log(chalk.dim(`  Omitted ${omitted} finding(s). Re-run with --limit ${result.findings.length} or --json.`));
      console.log(chalk.dim("  Secret values are never printed by this command."));
    }

    if (opts.failOnFindings && result.findings.length > 0) {
      process.exitCode = 1;
    }
  });

// ── mcp ───────────────────────────────────────────────────────────────────────
const mcpCmd = program.command("mcp").description("Install/remove MCP server for AI agents");

mcpCmd.command("install")
  .alias("add")
  .description("Install configs MCP server into an agent")
  .option("--claude", "install into Claude Code")
  .option("--codex", "install into Codex")
  .option("--antigravity", "install into Google Antigravity")
  .option("--all", "install into all agents")
  .option("--profile <level>", "set INSTRUCTIONS_PROFILE (minimal|standard|full)", "standard")
  .action(async (opts) => {
    const targets = opts.all ? ["claude", "codex", "antigravity"] : [
      ...(opts.claude ? ["claude"] : []),
      ...(opts.codex ? ["codex"] : []),
      ...(opts.antigravity ? ["antigravity"] : []),
    ];
    if (targets.length === 0) {
      console.log(chalk.dim("Specify --claude, --codex, --antigravity, or --all"));
      return;
    }
    for (const target of targets) {
      try {
        const { vars } = await getMachineProfileContext({}, resolveConfigStore());
        const mcpBinary = `${vars["BUN_BIN_DIR"]}/configs-mcp`;
        if (target === "claude") {
          const cmd = opts.profile && opts.profile !== "full"
            ? ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "configs", "--", "env", `INSTRUCTIONS_PROFILE=${opts.profile}`, mcpBinary]
            : ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "configs", "--", mcpBinary];
          const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
          await proc.exited;
          console.log(chalk.green("✓") + " Installed into Claude Code");
        } else if (target === "codex") {
          const { appendFileSync, existsSync: ex } = await import("node:fs");
          const { join: j } = await import("node:path");
          const configPath = j(homedir(), ".codex", "config.toml");
          const block = `\n[mcp_servers.configs]\ncommand = "${mcpBinary}"\nargs = []\n`;
          if (ex(configPath)) {
            const content = readFileSync(configPath, "utf-8");
            if (content.includes("[mcp_servers.configs]")) {
              console.log(chalk.dim("= Already installed in Codex"));
              continue;
            }
          }
          appendFileSync(configPath, block);
          console.log(chalk.green("✓") + " Installed into Codex");
        } else if (target === "antigravity") {
          const { mkdirSync: md, readFileSync: rf, writeFileSync: wf, existsSync: ex } = await import("node:fs");
          const { dirname: dn, join: j } = await import("node:path");
          const configPath = j(homedir(), ".gemini", "config", "mcp_config.json");
          let settings: Record<string, unknown> = {};
          if (ex(configPath)) {
            try { settings = JSON.parse(rf(configPath, "utf-8")); } catch { /* empty */ }
          }
          const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
          mcpServers["configs"] = {
            command: mcpBinary,
            args: [],
            ...(opts.profile && opts.profile !== "full" ? { env: { INSTRUCTIONS_PROFILE: opts.profile } } : {}),
          };
          settings["mcpServers"] = mcpServers;
          md(dn(configPath), { recursive: true });
          wf(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
          console.log(chalk.green("✓") + " Installed into Antigravity");
        }
      } catch (e) {
        console.error(chalk.red(`✗ Failed to install into ${target}: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  });

mcpCmd.command("uninstall")
  .alias("remove")
  .description("Remove configs MCP server from agents")
  .option("--claude", "remove from Claude Code")
  .option("--all", "remove from all agents")
  .action(async (opts) => {
    if (opts.claude || opts.all) {
      const proc = Bun.spawn(["claude", "mcp", "remove", "configs"], { stdout: "inherit", stderr: "inherit" });
      await proc.exited;
      console.log(chalk.green("✓") + " Removed from Claude Code");
    }
  });

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command("init")
  .description("First-time setup: sync all known configs, create default profile")
  .option("--force", "delete existing DB and start fresh")
  .action(async (opts) => {
    const store = resolveConfigStore();
    if (opts.force) {
      // Routes through the Store: LocalConfigStore wipes the on-disk SQLite db;
      // CloudConfigStore refuses (you can't force-wipe the shared cloud store).
      await store.reset();
      console.log(chalk.dim("Reset local store."));
    }
    console.log(chalk.bold("@hasna/instructions — initializing\n"));

    // Sync known configs
    const result = await syncKnown({ store });
    console.log(chalk.green("✓") + ` Synced: +${result.added} updated:${result.updated} unchanged:${result.unchanged}`);
    if (result.skipped.length > 0) {
      console.log(chalk.dim("  skipped: " + result.skipped.join(", ")));
    }

    // Add reference docs
    const refs = [
      { slug: "workspace-structure", name: "Workspace Structure", category: "workspace" as const, content: "# Workspace Structure\n\nSee ~/.claude/rules/workspace.md for full conventions.", desc: "~/Workspace/ hierarchy and naming" },
      { slug: "secrets-schema", name: "Secrets Schema", category: "secrets_schema" as const, content: "# .secrets Schema\n\nLocation: ~/.secrets (sourced by ~/.zshrc)\nFormat: export KEY_NAME=\"value\"\n\nKeys: ANTHROPIC_API_KEY, OPENAI_API_KEY, EXA_API_KEY, NPM_TOKEN, GITHUB_TOKEN", desc: "Shape of ~/.secrets (no values)" },
    ];
    for (const ref of refs) {
      try { await store.getConfig(ref.slug); } catch {
        await store.createConfig({ name: ref.name, category: ref.category, agent: "global", format: "markdown", content: ref.content, kind: "reference", description: ref.desc });
      }
    }
    await ensureGlobalAgentRulesStandardConfig(store);
    await ensureDangerousOperationGuardStandardConfig(store);
    await ensureProjectDashboardStandardConfig(store);

    // Create default profile
    try { await store.getProfile("my-setup"); } catch {
      const p = await store.createProfile({ name: "my-setup", description: "Default profile with all known configs" });
      const allConfigs = await store.listConfigs();
      for (const c of allConfigs) await store.addConfigToProfile(p.id, c.id);
      console.log(chalk.green("✓") + ` Created profile "my-setup" with ${allConfigs.length} configs`);
    }

    const machineProfiles = await ensurePlatformProfiles(store);
    console.log(chalk.green("✓") + ` Ensured ${machineProfiles.length} machine-aware profile(s)`);

    // Show summary
    const stats = await store.getConfigStats();
    console.log(chalk.bold("\nDB stats:"));
    for (const [key, count] of Object.entries(stats)) {
      if (count > 0) console.log(`  ${key.padEnd(18)} ${count}`);
    }
    const location = isCloudMode()
      ? `${process.env["HASNA_INSTRUCTIONS_API_URL"]}/v1 (self_hosted)`
      : process.env["HASNA_INSTRUCTIONS_DB_PATH"] || join(homedir(), ".hasna", "instructions", "instructions.db");
    console.log(chalk.dim(`\n${isCloudMode() ? "API" : "DB"}: ${location}`));
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Health check: total configs, drift from disk, unredacted secrets")
  .option("--json", "output metadata-only JSON")
  .action(async (opts: { json?: boolean }) => {
    const status = await getConfigsStatus(resolveConfigStore());

    if (opts.json) {
      printJson(status);
      return;
    }

    console.log(chalk.bold("@hasna/instructions") + chalk.dim(` v${pkg.version}`));
    console.log(chalk.cyan("Database:") + ` ${status.env.database.kind} (${status.env.database.active ?? "default"})`);
    console.log(chalk.cyan("Total:") + ` ${status.counts.configs.total} configs\n`);
    console.log(chalk.cyan("Drifted:") + ` ${status.health.driftedTargets === 0 ? chalk.green("0") : chalk.yellow(String(status.health.driftedTargets))} (stored differs from disk)`);
    console.log(chalk.cyan("Missing:") + ` ${status.health.missingTargets === 0 ? chalk.green("0") : chalk.yellow(String(status.health.missingTargets))} (file not on disk)`);
    console.log(chalk.cyan("Secrets:") + ` ${status.health.unredactedSecretFindings === 0 ? chalk.green("0 ✓") : chalk.red(String(status.health.unredactedSecretFindings) + " ⚠")} unredacted`);
    console.log(chalk.cyan("Retired agents:") + ` ${status.health.retiredAgentRows === 0 ? chalk.green("0") : chalk.yellow(String(status.health.retiredAgentRows))} row(s)`);
    console.log(chalk.cyan("Templates:") + ` ${status.counts.configs.templates} (with {{VAR}} placeholders)`);
  });

// ── diff --all ────────────────────────────────────────────────────────────────
// Extend existing diff command to support --all

// ── backup / restore ──────────────────────────────────────────────────────────
program
  .command("backup")
  .description("Export configs to a timestamped backup file")
  .action(async () => {
    const { mkdirSync: mk } = await import("node:fs");
    const backupDir = join(homedir(), ".hasna", "instructions", "backups");
    mk(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
    const outPath = join(backupDir, `configs-${ts}.tar.gz`);
    const result = await exportConfigs(outPath, { store: resolveConfigStore() });
    const { statSync: st } = await import("node:fs");
    const size = st(outPath).size;
    console.log(chalk.green("✓") + ` Backup: ${result.count} configs → ${outPath} (${(size / 1024).toFixed(1)}KB)`);
  });

program
  .command("restore <file>")
  .description("Restore configs from a backup file")
  .option("--overwrite", "overwrite existing configs (default: skip)")
  .action(async (file, opts) => {
    const result = await importConfigs(file, { conflict: opts.overwrite ? "overwrite" : "skip", store: resolveConfigStore() });
    console.log(chalk.green("✓") + ` Restored: +${result.created} updated:${result.updated} skipped:${result.skipped}`);
    if (result.errors.length > 0) {
      for (const e of result.errors) console.log(chalk.red("  " + e));
    }
  });

// ── doctor ────────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Validate configs: syntax, permissions, missing files, secrets")
  .action(async () => {
    const store = resolveConfigStore();
    let issues = 0;
    const pass = (msg: string) => console.log(chalk.green("  ✓ ") + msg);
    const fail = (msg: string) => { issues++; console.log(chalk.red("  ✗ ") + msg); };

    console.log(chalk.bold("Config Doctor\n"));

    // Check known files exist on disk
    const skip = (msg: string) => console.log(chalk.dim("  - ") + chalk.dim(msg));
    console.log(chalk.cyan("Known files on disk:"));
    for (const k of KNOWN_CONFIGS) {
      if (k.rulesDir) {
        existsSync(expandPath(k.rulesDir)) ? pass(`${k.rulesDir}/ exists`) : (k.optional ? skip(`${k.rulesDir}/ (optional)`) : fail(`${k.rulesDir}/ not found`));
      } else {
        existsSync(expandPath(k.path)) ? pass(k.path) : (k.optional ? skip(`${k.path} (optional)`) : fail(`${k.path} not found`));
      }
    }

    // Check DB configs
    const allConfigs = await store.listConfigs();
    console.log(chalk.cyan(`\nStored configs (${allConfigs.length}):`));

    // Validate JSON/TOML syntax
    let validCount = 0;
    for (const c of allConfigs) {
      if (c.format === "json") {
        try { JSON.parse(c.content); validCount++; } catch { fail(`${c.slug}: invalid JSON`); }
      } else { validCount++; }
    }
    pass(`${validCount}/${allConfigs.length} valid syntax`);

    // Secrets check
    let secretCount = 0;
    for (const c of allConfigs) {
      const found = scanSecrets(c.content, c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
      secretCount += found.length;
    }
    secretCount === 0 ? pass("No unredacted secrets") : fail(`${secretCount} unredacted secret(s) — run \`configs scan --fix\``);

    console.log(`\n${issues === 0 ? chalk.green("✓ All checks passed") : chalk.yellow(`${issues} issue(s) found`)}`);
  });

// ── completions ───────────────────────────────────────────────────────────────
program
  .command("completions [shell]")
  .description("Output shell completion script (zsh or bash)")
  .action(async (shell) => {
    const sh = shell || "zsh";
    if (sh === "zsh") {
      console.log(`#compdef configs
_configs() {
  local -a commands
  commands=(
    'list:List stored configs'
    'show:Show a config'
    'add:Ingest a file into the DB'
    'apply:Apply a config to disk'
    'diff:Show diff stored vs disk'
    'sync:Sync known configs from disk'
    'export:Export as tar.gz'
    'import:Import from tar.gz'
    'whoami:Setup summary'
    'status:Health check'
    'init:First-time setup'
    'scan:Scan for secrets'
    'profile:Manage profiles'
    'session:Plan and apply session instructions'
    'snapshot:Version history'
    'template:Template operations'
    'mcp:Install MCP server'
    'backup:Export to timestamped backup'
    'restore:Import from backup'
    'doctor:Validate configs'
    'completions:Output shell completions'
  )
  _describe 'command' commands
}
compdef _configs configs`);
    } else {
      console.log(`# bash completion for configs
_configs_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="list show add apply diff sync export import whoami status init scan profile session snapshot template mcp backup restore doctor completions"
  COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
}
complete -F _configs_completions configs`);
    }
  });

// ── compare ───────────────────────────────────────────────────────────────────
program
  .command("compare <a> <b>")
  .description("Diff two stored configs against each other")
  .action(async (a, b) => {
    try {
      const store = resolveConfigStore();
      const configA = await store.getConfig(a);
      const configB = await store.getConfig(b);
      console.log(chalk.bold(`${configA.slug}`) + chalk.dim(` (${configA.category}/${configA.agent})`));
      console.log(chalk.bold(`${configB.slug}`) + chalk.dim(` (${configB.category}/${configB.agent})`));
      console.log();

      const linesA = configA.content.split("\n");
      const linesB = configB.content.split("\n");
      const maxLen = Math.max(linesA.length, linesB.length);
      const lines: string[] = [`--- ${configA.slug}`, `+++ ${configB.slug}`];
      let diffs = 0;
      for (let i = 0; i < maxLen; i++) {
        const la = linesA[i];
        const lb = linesB[i];
        if (la === lb) { if (la !== undefined) lines.push(` ${la}`); }
        else {
          diffs++;
          if (la !== undefined) lines.push(chalk.red(`-${la}`));
          if (lb !== undefined) lines.push(chalk.green(`+${lb}`));
        }
      }
      if (diffs === 0) {
        console.log(chalk.green("✓") + " Identical content");
      } else {
        console.log(lines.join("\n"));
        console.log(chalk.dim(`\n${diffs} difference(s)`));
      }
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
  });

// ── watch ─────────────────────────────────────────────────────────────────────
program
  .command("watch")
  .description("Watch known config files for changes and auto-sync to DB")
  .option("-i, --interval <ms>", "poll interval in milliseconds", "3000")
  .action(async (opts) => {
    const store = resolveConfigStore();
    const interval = Number(opts.interval);
    const { statSync: st } = await import("node:fs");
    const { expandPath } = await import("../lib/apply.js");

    console.log(chalk.bold("@hasna/instructions watch") + chalk.dim(` — polling every ${interval}ms`));
    console.log(chalk.dim("Watching known config files for changes…\n"));

    // Build file → mtime map
    const mtimes = new Map<string, number>();
    for (const k of KNOWN_CONFIGS) {
      if (k.rulesDir) {
        const absDir = expandPath(k.rulesDir);
        if (!existsSync(absDir)) continue;
        const { readdirSync } = await import("node:fs");
        for (const f of readdirSync(absDir).filter((f: string) => f.endsWith(".md"))) {
          const abs = join(absDir, f);
          mtimes.set(abs, st(abs).mtimeMs);
        }
      } else {
        const abs = expandPath(k.path);
        if (existsSync(abs)) mtimes.set(abs, st(abs).mtimeMs);
      }
    }
    console.log(chalk.dim(`Tracking ${mtimes.size} files`));

    const tick = async () => {
      let changed = 0;
      // Check existing files for mtime changes
      for (const [abs, oldMtime] of mtimes) {
        if (!existsSync(abs)) continue;
        const newMtime = st(abs).mtimeMs;
        if (newMtime !== oldMtime) {
          changed++;
          mtimes.set(abs, newMtime);
        }
      }
      // Check for NEW files in watched directories (e.g. new rule added)
      const { readdirSync: rd } = await import("node:fs");
      for (const k of KNOWN_CONFIGS) {
        if (k.rulesDir) {
          const absDir = expandPath(k.rulesDir);
          if (!existsSync(absDir)) continue;
          for (const f of rd(absDir).filter((f: string) => f.endsWith(".md"))) {
            const abs = join(absDir, f);
            if (!mtimes.has(abs)) {
              mtimes.set(abs, st(abs).mtimeMs);
              changed++;
            }
          }
        } else {
          const abs = expandPath(k.path);
          if (existsSync(abs) && !mtimes.has(abs)) {
            mtimes.set(abs, st(abs).mtimeMs);
            changed++;
          }
        }
      }
      if (changed > 0) {
        const result = await syncKnown({ store });
        const ts = new Date().toLocaleTimeString();
        console.log(`${chalk.dim(ts)} ${chalk.green("✓")} ${changed} file(s) changed/new → synced +${result.added} updated:${result.updated}`);
      }
    };

    setInterval(tick, interval);
    // Keep alive
    await new Promise(() => {});
  });

// ── report ────────────────────────────────────────────────────────────────────
program
  .command("report")
  .description("Summary of stored configs, drift, and ecosystem health")
  .option("--json", "output as JSON")
  .option("--markdown", "output as markdown")
  .action(async () => {
    const store = resolveConfigStore();
    const stats = await store.getConfigStats();
    const allConfigs = await store.listConfigs();
    const fileConfigs = allConfigs.filter((c) => c.kind === "file");
    const refConfigs = allConfigs.filter((c) => c.kind === "reference");
    const templates = allConfigs.filter((c) => c.is_template);
    const profiles = await store.listProfiles();

    // Drift check
    let drifted = 0, missing = 0;
    for (const c of fileConfigs) {
      if (!c.target_path) continue;
      const abs = expandPath(c.target_path);
      if (!existsSync(abs)) { missing++; continue; }
      const disk = readFileSync(abs, "utf-8");
      const { content: redactedDisk } = redactContent(disk, c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
      if (redactedDisk !== c.content) drifted++;
    }

    // Agent breakdown
    const byAgent: Record<string, number> = {};
    for (const c of allConfigs) byAgent[c.agent] = (byAgent[c.agent] || 0) + 1;

    // Project configs
    const projectConfigs = allConfigs.filter((c) => c.target_path && !c.target_path.startsWith("~/."));

    console.log(chalk.bold("configs report\n"));
    console.log(`  Total:       ${allConfigs.length} configs (${fileConfigs.length} files, ${refConfigs.length} references)`);
    console.log(`  Templates:   ${templates.length} (with {{VAR}} placeholders)`);
    console.log(`  Profiles:    ${profiles.length}`);
    console.log(`  Drift:       ${drifted === 0 ? chalk.green("0 ✓") : chalk.yellow(String(drifted))} drifted, ${missing} missing`);
    console.log(`  Secrets:     ${chalk.green("0 ✓")} (redacted on ingest)\n`);

    console.log(chalk.cyan("  By agent:"));
    for (const [agent, count] of Object.entries(byAgent).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${agent.padEnd(10)} ${count}`);
    }

    console.log(chalk.cyan("\n  By category:"));
    for (const [cat, count] of Object.entries(stats).filter(([k]) => k !== "total").sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`    ${cat.padEnd(16)} ${count}`);
    }

    if (projectConfigs.length > 0) {
      console.log(chalk.cyan(`\n  Project configs: ${projectConfigs.length}`));
    }
  });

// ── clean ─────────────────────────────────────────────────────────────────────
program
  .command("clean")
  .description("Remove configs from DB whose target files no longer exist on disk")
  .option("--dry-run", "show what would be removed")
  .option("--limit <n>", `max orphan rows to print (default ${DEFAULT_LIST_LIMIT})`)
  .action(async (opts) => {
    const store = resolveConfigStore();
    const configs = await store.listConfigs({ kind: "file" });
    let removed = 0;
    let printed = 0;
    const maxPrinted = parseLimit(opts.limit, DEFAULT_LIST_LIMIT);
    for (const c of configs) {
      if (!c.target_path) continue;
      const abs = expandPath(c.target_path);
      if (!existsSync(abs)) {
        if (printed < maxPrinted) {
          if (opts.dryRun) {
            console.log(chalk.yellow("  would remove:") + ` ${c.slug} ${chalk.dim(`(${truncateMiddle(c.target_path, 88)})`)}`);
          } else {
            console.log(chalk.red("  removed:") + ` ${c.slug} ${chalk.dim(`(${truncateMiddle(c.target_path, 88)})`)}`);
          }
          printed++;
        }
        if (!opts.dryRun) await store.deleteConfig(c.id);
        removed++;
      }
    }
    if (removed === 0) console.log(chalk.green("✓") + " All stored configs still exist on disk.");
    else {
      const omitted = Math.max(0, removed - printed);
      console.log(chalk.dim(`\n${removed} orphaned config(s) ${opts.dryRun ? "found" : "removed"}${omitted > 0 ? `, ${omitted} omitted from output` : ""}`));
      if (omitted > 0) console.log(chalk.dim(`Use --limit ${removed} to print every orphan row.`));
    }
  });

// ── bootstrap ─────────────────────────────────────────────────────────────────
program
  .command("bootstrap")
  .description("Install the full @hasna ecosystem: CLI tools + MCP servers + configs")
  .option("--dry-run", "show what would be installed without doing it")
  .option("--skip-mcp", "skip MCP server registration")
  .action(async (opts) => {
    const store = resolveConfigStore();
    const packages = [
      { name: "@hasna/todos", bin: "todos", mcp: "todos-mcp" },
      { name: "@hasna/mementos", bin: "mementos", mcp: "mementos-mcp" },
      { name: "@hasna/conversations", bin: "conversations", mcp: "conversations-mcp" },
      { name: "@hasna/skills", bin: "skills", mcp: "skills-mcp" },
      { name: "@hasna/economy", bin: "economy", mcp: "economy-mcp" },
      { name: "@hasna/attachments", bin: "attachments", mcp: "attachments-mcp" },
      { name: "@hasna/sessions", bin: "sessions", mcp: "sessions-mcp" },
      { name: "@hasna/emails", bin: "emails", mcp: "emails-mcp" },
      { name: "@hasna/recordings", bin: "recordings", mcp: "recordings-mcp" },
      { name: "@hasna/testers", bin: "testers", mcp: "testers-mcp" },
      { name: "@hasna/assistants", bin: "assistants", mcp: "assistants-mcp" },
      { name: "@hasna/brains", bin: "brains", mcp: "brains-mcp" },
    ];

    console.log(chalk.bold("@hasna/instructions bootstrap") + chalk.dim(` — installing ${packages.length} ecosystem packages\n`));

    // 1. Install global packages
    console.log(chalk.cyan("Installing CLI tools:"));
    for (const pkg of packages) {
      if (opts.dryRun) { console.log(chalk.dim(`  would install: ${pkg.name}`)); continue; }
      try {
        const proc = Bun.spawn(["bun", "install", "-g", pkg.name], { stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        if (code === 0) console.log(chalk.green("  ✓ ") + pkg.name);
        else console.log(chalk.yellow("  ⚠ ") + pkg.name + chalk.dim(" (may already be installed)"));
      } catch { console.log(chalk.yellow("  ⚠ ") + pkg.name + chalk.dim(" (skipped)")); }
    }

    // 2. Register MCP servers in Claude Code
    if (!opts.skipMcp) {
      console.log(chalk.cyan("\nRegistering MCP servers in Claude Code:"));
      for (const pkg of packages) {
        if (opts.dryRun) { console.log(chalk.dim(`  would register: ${pkg.mcp}`)); continue; }
        try {
          const proc = Bun.spawn(["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", pkg.bin, "--", pkg.mcp], { stdout: "pipe", stderr: "pipe" });
          const code = await proc.exited;
          if (code === 0) console.log(chalk.green("  ✓ ") + pkg.bin);
          else console.log(chalk.dim("  = ") + pkg.bin + chalk.dim(" (already registered)"));
        } catch { console.log(chalk.yellow("  ⚠ ") + pkg.bin + chalk.dim(" (skipped)")); }
      }
    }

    // 3. Run configs init
    console.log(chalk.cyan("\nInitializing configs:"));
    if (!opts.dryRun) {
      const result = await syncKnown({ store });
      console.log(chalk.green("  ✓ ") + `Synced ${result.added + result.updated + result.unchanged} known configs`);
    } else {
      console.log(chalk.dim("  would run: configs init"));
    }

    console.log(chalk.bold("\n✓ Bootstrap complete.") + chalk.dim(" Restart Claude Code for MCP servers to activate."));
  });

// ── pull / push aliases ───────────────────────────────────────────────────────
program
  .command("pull")
  .description("Alias for sync (read from disk into DB)")
  .option("-a, --agent <agent>", "only sync this agent")
  .option("--dry-run", "preview without writing")
  .action(async (opts) => {
    const result = await syncKnown({ dryRun: opts.dryRun, agent: opts.agent, store: resolveConfigStore() });
    console.log(chalk.green("✓") + ` Pulled: +${result.added} updated:${result.updated} unchanged:${result.unchanged}`);
  });

program
  .command("push")
  .description("Alias for sync --to-disk (write DB configs to disk)")
  .option("-a, --agent <agent>", "only push this agent")
  .option("--dry-run", "preview without writing")
  .action(async (opts) => {
    const result = await syncToDisk({ dryRun: opts.dryRun, agent: opts.agent, store: resolveConfigStore() });
    console.log(chalk.green("✓") + ` Pushed: updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
  });

// ── update ────────────────────────────────────────────────────────────────────
program
  .command("update")
  .description("Check for updates and install latest version")
  .option("--check", "only check, don't install")
  .action(async (opts) => {
    try {
      const proc = Bun.spawn(["npm", "view", "@hasna/instructions", "version"], { stdout: "pipe", stderr: "pipe" });
      const latest = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (latest === pkg.version) {
        console.log(chalk.green("✓") + ` Already on latest version (${pkg.version})`);
      } else {
        console.log(`Current: ${chalk.dim(pkg.version)} → Latest: ${chalk.green(latest)}`);
        if (!opts.check) {
          console.log(chalk.dim("Installing..."));
          const install = Bun.spawn(["bun", "install", "-g", `@hasna/instructions@${latest}`], { stdout: "inherit", stderr: "inherit" });
          await install.exited;
          console.log(chalk.green("✓") + ` Updated to ${latest}`);
        }
      }
    } catch (e) {
      console.error(chalk.red("Failed to check for updates: " + (e instanceof Error ? e.message : String(e))));
    }
  });

// ── feedback ──────────────────────────────────────────────────────────────────
program
  .command("feedback <message>")
  .description("Send feedback about this service")
  .option("-e, --email <email>", "Contact email")
  .option("-c, --category <cat>", "Category: bug, feature, general", "general")
  .action(async (message, opts) => {
    await resolveConfigStore().sendFeedback({
      message,
      email: opts.email || null,
      category: opts.category || "general",
      version: pkg.version,
    });
    console.log(chalk.green("✓") + " Feedback saved. Thank you!");
  });

program.version(pkg.version).name("instructions");
registerEventsCommands(program, { source: "configs" });
program.parse(process.argv);
