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
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
});

profileCmd.command("add <profile> <config>").description("Add a config to a profile").action(async (profile, config) => {
  try {
    const store = resolveConfigStore();
    const c = await store.getConfig(config);
    await store.addConfigToProfile(profile, c.id);
    console.log(chalk.green("✓") + ` Added ${c.slug} to profile ${profile}`);
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
});

profileCmd.command("remove <profile> <config>").description("Remove a config from a profile").action(async (profile, config) => {
  try {
    const store = resolveConfigStore();
    const c = await store.getConfig(config);
    await store.removeConfigFromProfile(profile, c.id);
    console.log(chalk.green("✓") + ` Removed ${c.slug} from profile ${profile}`);
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
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
      const report = await applyConfigsWithReport(configs, {
        dryRun: opts.dryRun,
        vars,
        store,
      });
      const results = report.results;
      let changed = 0;
      for (const r of results) {
        const status = opts.dryRun ? chalk.yellow("[dry-run]") : (r.changed ? chalk.green("✓") : chalk.dim("="));
        console.log(`${status} ${r.path}`);
        if (r.changed) changed++;
      }
      for (const skipped of report.skipped) {
        console.log(`${chalk.dim("[owned]")} ${skipped.path} ${chalk.dim(skipped.owner)}`);
      }
      if (opts.dryRun) {
        const unresolved = [...new Set(results.flatMap((result) => result.unresolved_template_vars ?? []))];
        if (unresolved.length > 0) {
          console.log(chalk.yellow(`Unresolved secret/runtime template references preserved in preview: ${unresolved.join(", ")}`));
        }
      }
      for (const failure of report.failures) {
        console.error(chalk.red(`[failed] ${failure.config_slug}: ${failure.message}`));
      }
      if (report.failures.length > 0) process.exitCode = 1;
      console.log(chalk.dim(`\n${changed}/${results.length} changed (${selected.slug} on ${machine.hostname} ${machine.os_family}/${machine.arch})`));
    } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
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
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
});

