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
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
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
        const report = await applyConfigsWithReport([{
          ...c,
          content: rendered,
          is_template: false,
        }], {
          dryRun: opts.dryRun,
          store: resolveConfigStore(),
        });
        if (report.failures.length > 0) {
          throw new Error(report.failures.map((failure) => failure.message).join("; "));
        }
        for (const result of report.results) {
          const status = opts.dryRun ? chalk.yellow("[dry-run]") : chalk.green("✓");
          console.log(`${status} Rendered ${opts.dryRun ? "preview for" : "and applied to"} ${result.path}`);
          if (opts.dryRun) console.log(result.new_content);
        }
        for (const skipped of report.skipped) {
          console.log(`${chalk.dim("[owned]")} ${skipped.path} ${chalk.dim(skipped.owner)}`);
        }
      } else {
        console.log(rendered);
      }
    } catch (e) {
      console.error(chalk.red(formatCliError(e)));
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
        console.error(chalk.red(`✗ Failed to install into ${target}: ${formatCliError(e)}`));
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

