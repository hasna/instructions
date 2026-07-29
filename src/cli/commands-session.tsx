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
      console.error(chalk.red(formatCliError(e)));
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
      console.error(chalk.red(formatCliError(e)));
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
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
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
  } catch (e) { console.error(chalk.red(formatCliError(e))); process.exit(1); }
});

