import { registerEventsCommands } from "@hasna/events/commander";
import { program } from "commander";
import chalk from "chalk";
import { existsSync, lstatSync, readFileSync, readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { applyConfigsWithReport, expandPath } from "../lib/apply.js";
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
import { resolveConfigStore, isCloudMode, formatCliError, type ConfigStore } from "../data/config-store.js";
import { DEFAULT_LIST_LIMIT, paginate, parseLimit, truncateMiddle, truncateText } from "../lib/compact-output.js";
import type { Config, ConfigAgent, ConfigCategory, ConfigFormat, ConfigKind, Profile, ProfileSelector, ProfileVariables } from "../types/index.js";
import {
  collectOption, collectSessionSources, fmtConfig, formatProfileSelectorSummary,
  formatProfileVariables, getMachineProfileContext, pad, pageFooter, parsePositiveInteger,
  parseProfileSelectors, parseProjectContextRuntime, parseVarArgs, pkg, planJsonForOutput,
  printConfigRows, printJson, printLine, printProjectContextFailure,
  readProjectContextBundleOption, SESSION_SOURCE_LAYER_HELP, splitCsv,
} from "./shared.js";

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
      console.error(chalk.red(formatCliError(e)));
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
      console.error(chalk.red(formatCliError(e)));
      process.exit(1);
    }
  });

// ── apply ─────────────────────────────────────────────────────────────────────
program
  .command("apply <id>")
  .description("Apply a config to its target_path and output targets on disk")
  .option("--dry-run", "preview without writing")
  .option("--force", "overwrite even if unchanged")
  .option(
    "--allow-renderer-owned",
    "write even when the target is owned by the Instructions session renderer (opt-in; normally use `instructions session apply`)",
  )
  .action(async (id, opts) => {
    try {
      const store = resolveConfigStore();
      const config = await store.getConfig(id);
      const report = await applyConfigsWithReport([config], {
        dryRun: opts.dryRun,
        store,
        allowSessionRendererOwned: opts.allowRendererOwned,
      });
      if (report.failures.length > 0) {
        throw new Error(report.failures.map((failure) => failure.message).join("; "));
      }
      for (const result of report.results) {
        const status = opts.dryRun ? chalk.yellow("[dry-run]") : (result.changed ? chalk.green("✓") : chalk.dim("="));
        const change = result.changed ? "changed" : "unchanged";
        console.log(`${status} ${result.path} ${chalk.dim(`(${change})`)}`);
        for (const output of result.outputs ?? []) {
          const outputStatus = opts.dryRun ? chalk.yellow("[dry-run]") : (output.changed ? chalk.green("✓") : chalk.dim("="));
          const outputChange = output.changed ? "changed" : "unchanged";
          console.log(`  ${outputStatus} ${output.path} ${chalk.dim(`[${output.agent}/${output.transform}] (${outputChange})`)}`);
        }
      }
      for (const skipped of report.skipped) {
        console.log(`${chalk.dim("[owned]")} ${skipped.path} ${chalk.dim(skipped.owner)}`);
      }
    } catch (e) {
      console.error(chalk.red(formatCliError(e)));
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
      console.error(chalk.red(formatCliError(e)));
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

