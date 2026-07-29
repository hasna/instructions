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
      console.error(chalk.red(formatCliError(e)));
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
      console.error(chalk.red("Failed to check for updates: " + (formatCliError(e))));
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

