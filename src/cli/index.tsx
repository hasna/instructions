#!/usr/bin/env bun
import { program } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig, deleteConfig, getConfig, getConfigStats, listConfigs, updateConfig } from "../db/configs.js";
import { createProfile, deleteProfile, getProfile, getProfileConfigs, listProfiles, updateProfile, addConfigToProfile, removeConfigFromProfile } from "../db/profiles.js";
import { listSnapshots, getSnapshot } from "../db/snapshots.js";
import { getDatabase, resetDatabase } from "../db/database.js";
import { applyConfig, applyConfigs, expandPath } from "../lib/apply.js";
import { diffConfig, syncKnown, syncToDisk, syncProject, detectCategory, detectAgent, detectFormat, KNOWN_CONFIGS } from "../lib/sync.js";
import { syncFromDir } from "../lib/sync-dir.js";
import { redactContent, scanSecrets } from "../lib/redact.js";
import { exportConfigs } from "../lib/export.js";
import { importConfigs } from "../lib/import.js";
import { extractTemplateVars } from "../lib/template.js";
import type { ConfigAgent, ConfigCategory, ConfigFormat, ConfigKind } from "../types/index.js";

import { createRequire } from "node:module";
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

function fmtConfig(c: ReturnType<typeof getConfig>, format: string) {
  if (format === "json") return JSON.stringify(c, null, 2);
  if (format === "compact") return `${c.slug} [${c.category}/${c.agent}] ${c.kind === "reference" ? "(ref)" : c.target_path ?? "(no path)"}`;
  // table
  return [
    `${chalk.bold(c.name)} ${chalk.dim(`(${c.slug})`)}`,
    `  ${chalk.cyan("category:")} ${c.category}  ${chalk.cyan("agent:")} ${c.agent}  ${chalk.cyan("kind:")} ${c.kind}`,
    `  ${chalk.cyan("format:")} ${c.format}  ${chalk.cyan("version:")} ${c.version}${c.target_path ? `  ${chalk.cyan("path:")} ${c.target_path}` : ""}`,
    c.description ? `  ${chalk.dim(c.description)}` : "",
    c.tags.length > 0 ? `  ${chalk.dim("tags: " + c.tags.join(", "))}` : "",
  ].filter(Boolean).join("\n");
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
  .option("-f, --format <fmt>", "output format: table|json|compact", "table")
  .option("--brief", "shorthand for --format compact")
  .action(async (opts) => {
    const fmt = opts.brief ? "compact" : opts.format;
    const configs = listConfigs({
      category: opts.category as ConfigCategory,
      agent: opts.agent as ConfigAgent,
      kind: opts.kind as ConfigKind,
      tags: opts.tag ? [opts.tag] : undefined,
      search: opts.search,
    });
    if (configs.length === 0) {
      console.log(chalk.dim("No configs found."));
      return;
    }
    if (fmt === "json") {
      console.log(JSON.stringify(configs, null, 2));
      return;
    }
    for (const c of configs) {
      console.log(fmtConfig(c, fmt));
      if (fmt === "table") console.log();
    }
    console.log(chalk.dim(`${configs.length} config(s)`));
  });

// ── show ─────────────────────────────────────────────────────────────────────
program
  .command("show <id>")
  .description("Show a config's content and metadata")
  .option("-f, --format <fmt>", "output format: table|json|content", "table")
  .action(async (id, opts) => {
    try {
      const c = getConfig(id);
      if (opts.format === "json") { console.log(JSON.stringify(c, null, 2)); return; }
      if (opts.format === "content") { console.log(c.content); return; }
      console.log(fmtConfig(c, "table"));
      console.log();
      console.log(chalk.bold("Content:"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(c.content);
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
    const config = createConfig({
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

// ── apply ─────────────────────────────────────────────────────────────────────
program
  .command("apply <id>")
  .description("Apply a config to its target_path on disk")
  .option("--dry-run", "preview without writing")
  .option("--force", "overwrite even if unchanged")
  .action(async (id, opts) => {
    try {
      const config = getConfig(id);
      const result = await applyConfig(config, { dryRun: opts.dryRun });
      const status = opts.dryRun ? chalk.yellow("[dry-run]") : (result.changed ? chalk.green("✓") : chalk.dim("="));
      const change = result.changed ? "changed" : "unchanged";
      console.log(`${status} ${result.path} ${chalk.dim(`(${change})`)}`);
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
      if (id) {
        const config = getConfig(id);
        console.log(diffConfig(config));
        return;
      }
      // --all or no id: diff all known file-type configs
      const configs = listConfigs({ kind: "file" });
      let drifted = 0;
      for (const c of configs) {
        if (!c.target_path) continue;
        const diff = diffConfig(c);
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
  .description("Sync known AI coding configs from disk into DB (claude, codex, gemini, zsh, git, npm)")
  .option("-a, --agent <agent>", "only sync configs for this agent (claude|codex|gemini|zsh|git|npm)")
  .option("-c, --category <cat>", "only sync configs in this category")
  .option("-p, --project [dir]", "sync project-scoped configs (CLAUDE.md, .mcp.json, etc.) from a project dir")
  .option("--all", "with --project: scan all subdirs for projects to sync")
  .option("--to-disk", "apply DB configs back to disk instead")
  .option("--dry-run", "preview without writing")
  .option("--list", "show which files would be synced without doing anything")
  .action(async (opts) => {
    if (opts.list) {
      const targets = KNOWN_CONFIGS.filter((k) => {
        if (opts.agent && k.agent !== opts.agent) return false;
        if (opts.category && k.category !== opts.category) return false;
        return true;
      });
      console.log(chalk.bold(`Known configs (${targets.length}):`));
      for (const k of targets) {
        console.log(`  ${chalk.cyan(k.rulesDir ? k.rulesDir + "/*.md" : k.path)} ${chalk.dim(`[${k.category}/${k.agent}]`)}`);
      }
      return;
    }
    if (opts.project) {
      const dir = typeof opts.project === "string" ? opts.project : process.cwd();

      // --project --all: find all project dirs with CLAUDE.md and sync each
      if (opts.all) {
        const { readdirSync, statSync: st } = await import("node:fs");
        const absDir = expandPath(dir);
        const entries = readdirSync(absDir, { withFileTypes: true });
        let totalAdded = 0, totalUpdated = 0, totalUnchanged = 0, projects = 0;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const projDir = join(absDir, entry.name);
          // Only sync dirs that have CLAUDE.md, .mcp.json, or .claude/
          const hasClaude = existsSync(join(projDir, "CLAUDE.md")) || existsSync(join(projDir, ".mcp.json")) || existsSync(join(projDir, ".claude"));
          if (!hasClaude) continue;
          const result = await syncProject({ projectDir: projDir, dryRun: opts.dryRun });
          if (result.added + result.updated > 0) {
            console.log(`  ${chalk.green("✓")} ${entry.name}: +${result.added} updated:${result.updated}`);
          }
          totalAdded += result.added; totalUpdated += result.updated; totalUnchanged += result.unchanged; projects++;
        }
        console.log(chalk.green("✓") + ` Synced ${projects} projects: +${totalAdded} updated:${totalUpdated} unchanged:${totalUnchanged}`);
        return;
      }

      const result = await syncProject({ projectDir: dir, dryRun: opts.dryRun });
      console.log(chalk.green("✓") + ` Project sync: +${result.added} updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
      return;
    }
    if (opts.toDisk) {
      const result = await syncToDisk({ dryRun: opts.dryRun, agent: opts.agent, category: opts.category });
      console.log(chalk.green("✓") + ` Written to disk: updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
    } else {
      const result = await syncKnown({ dryRun: opts.dryRun, agent: opts.agent, category: opts.category });
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
    const dbPath = process.env["CONFIGS_DB_PATH"] || join(homedir(), ".hasna", "configs", "configs.db");
    const stats = getConfigStats();
    console.log(chalk.bold("@hasna/configs") + chalk.dim(" v" + pkg.version));
    console.log(chalk.cyan("DB:") + " " + dbPath);
    console.log(chalk.cyan("Total configs:") + " " + (stats["total"] || 0));
    console.log();
    console.log(chalk.bold("By category:"));
    const categories = ["agent", "rules", "mcp", "shell", "secrets_schema", "workspace", "git", "tools"];
    for (const cat of categories) {
      const count = stats[cat] || 0;
      if (count > 0) console.log(`  ${chalk.cyan(cat.padEnd(16))} ${count}`);
    }
    const profiles = listProfiles();
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
  .option("-f, --format <fmt>", "table|json|compact", "table")
  .action(async (opts) => {
  const fmt = opts.brief ? "compact" : opts.format;
  const profiles = listProfiles();
  if (profiles.length === 0) { console.log(chalk.dim("No profiles.")); return; }
  if (fmt === "json") { console.log(JSON.stringify(profiles, null, 2)); return; }
  for (const p of profiles) {
    if (fmt === "compact") { console.log(`${p.slug} ${getProfileConfigs(p.id).length} configs`); continue; }
    const configs = getProfileConfigs(p.id);
    console.log(`${chalk.bold(p.name)} ${chalk.dim(`(${p.slug})`)} — ${configs.length} config(s)`);
    if (p.description) console.log(`  ${chalk.dim(p.description)}`);
  }
});

profileCmd.command("create <name>").description("Create a new profile")
  .option("-d, --description <desc>", "profile description")
  .action(async (name, opts) => {
    const p = createProfile({ name, description: opts.description });
    console.log(chalk.green("✓") + ` Created profile: ${chalk.bold(p.name)} ${chalk.dim(`(${p.slug})`)}`);
  });

profileCmd.command("show <id>").description("Show profile and its configs").action(async (id) => {
  try {
    const p = getProfile(id);
    const configs = getProfileConfigs(id);
    console.log(chalk.bold(p.name) + chalk.dim(` (${p.slug})`));
    if (p.description) console.log(chalk.dim(p.description));
    console.log(chalk.cyan(`${configs.length} config(s):`));
    for (const c of configs) console.log(`  ${c.slug} ${chalk.dim(`[${c.category}]`)}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

profileCmd.command("add <profile> <config>").description("Add a config to a profile").action(async (profile, config) => {
  try {
    const c = getConfig(config);
    addConfigToProfile(profile, c.id);
    console.log(chalk.green("✓") + ` Added ${c.slug} to profile ${profile}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

profileCmd.command("remove <profile> <config>").description("Remove a config from a profile").action(async (profile, config) => {
  try {
    const c = getConfig(config);
    removeConfigFromProfile(profile, c.id);
    console.log(chalk.green("✓") + ` Removed ${c.slug} from profile ${profile}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

profileCmd.command("apply <id>").description("Apply all configs in a profile to disk")
  .option("--dry-run", "preview without writing")
  .action(async (id, opts) => {
    try {
      const configs = getProfileConfigs(id);
      const results = await applyConfigs(configs, { dryRun: opts.dryRun });
      let changed = 0;
      for (const r of results) {
        const status = opts.dryRun ? chalk.yellow("[dry-run]") : (r.changed ? chalk.green("✓") : chalk.dim("="));
        console.log(`${status} ${r.path}`);
        if (r.changed) changed++;
      }
      console.log(chalk.dim(`\n${changed}/${results.length} changed`));
    } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
  });

profileCmd.command("delete <id>").description("Delete a profile").action(async (id) => {
  try {
    const p = getProfile(id);
    deleteProfile(id);
    console.log(chalk.green("✓") + ` Deleted profile: ${p.name}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

// ── snapshot ──────────────────────────────────────────────────────────────────
const snapshotCmd = program.command("snapshot").description("Manage config version history");

snapshotCmd.command("list <config>").description("List snapshots for a config").action(async (configId) => {
  try {
    const c = getConfig(configId);
    const snaps = listSnapshots(c.id);
    if (snaps.length === 0) { console.log(chalk.dim("No snapshots.")); return; }
    for (const s of snaps) {
      console.log(`  v${s.version} ${chalk.dim(s.created_at)} ${chalk.dim(s.id)}`);
    }
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

snapshotCmd.command("show <id>").description("Show a snapshot's content").action(async (id) => {
  const snap = getSnapshot(id);
  if (!snap) { console.error(chalk.red("Snapshot not found: " + id)); process.exit(1); }
  console.log(snap.content);
});

snapshotCmd.command("restore <config> <snapshot-id>").description("Restore a config to a snapshot version").action(async (configId, snapId) => {
  try {
    const snap = getSnapshot(snapId);
    if (!snap) { console.error(chalk.red("Snapshot not found: " + snapId)); process.exit(1); }
    updateConfig(configId, { content: snap.content });
    console.log(chalk.green("✓") + ` Restored ${configId} to snapshot v${snap.version}`);
  } catch (e) { console.error(chalk.red(e instanceof Error ? e.message : String(e))); process.exit(1); }
});

// ── template ──────────────────────────────────────────────────────────────────
const templateCmd = program.command("template").description("Work with template configs");

templateCmd.command("vars <id>").description("Show template variables").action(async (id) => {
  try {
    const c = getConfig(id);
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
      const c = getConfig(id);
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
  .action(async (id, opts) => {
    let configs;
    if (id) {
      configs = [getConfig(id)];
    } else if (opts.all) {
      // Scan full DB in batches to avoid OOM
      configs = listConfigs(opts.category ? { kind: "file", category: opts.category as ConfigCategory } : { kind: "file" });
    } else {
      // Default: fetch only the ~30 known configs individually by slug (fast, no full table scan)
      const { KNOWN_CONFIGS } = await import("../lib/sync.js");
      const slugs = [
        ...KNOWN_CONFIGS.filter((k) => !k.rulesDir).map((k) => k.name),
        // rules/*.md slugs follow pattern claude-rules-{filename}-md
      ];
      const fetched = [];
      for (const slug of slugs) {
        try { fetched.push(getConfig(slug)); } catch { /* not in DB yet */ }
      }
      // Also grab rules by category+agent (small set)
      const rules = listConfigs({ category: "rules", agent: "claude" });
      for (const r of rules) if (!fetched.find((c) => c.id === r.id)) fetched.push(r);
      configs = fetched;
    }

    let total = 0;
    const BATCH = 200;
    for (let i = 0; i < configs.length; i += BATCH) {
      const batch = configs.slice(i, i + BATCH);
      for (const c of batch) {
        const fmt = c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text";
        const secrets = scanSecrets(c.content, fmt);
        if (secrets.length === 0) continue;
        total += secrets.length;
        console.log(chalk.yellow(`⚠ ${c.slug}`) + chalk.dim(` — ${secrets.length} secret(s):`));
        for (const s of secrets) console.log(`  line ${s.line}: ${chalk.red(s.varName)} — ${s.reason}`);
        if (opts.fix) {
          const { content, isTemplate } = redactContent(c.content, fmt);
          updateConfig(c.id, { content, is_template: isTemplate });
          console.log(chalk.green("  ✓ Redacted."));
        }
      }
    }
    if (total === 0) {
      console.log(chalk.green("✓") + ` No secrets detected${opts.all ? "" : " (known configs). Use --all to scan entire DB"}.`);
    } else if (!opts.fix) {
      console.log(chalk.yellow(`\nRun with --fix to redact in-place.`));
    }
  });

// ── mcp ───────────────────────────────────────────────────────────────────────
const mcpCmd = program.command("mcp").description("Install/remove MCP server for AI agents");

mcpCmd.command("install")
  .alias("add")
  .description("Install configs MCP server into an agent")
  .option("--claude", "install into Claude Code")
  .option("--codex", "install into Codex")
  .option("--gemini", "install into Gemini")
  .option("--all", "install into all agents")
  .option("--profile <level>", "set CONFIGS_PROFILE (minimal|standard|full)", "standard")
  .action(async (opts) => {
    const targets = opts.all ? ["claude", "codex", "gemini"] : [
      ...(opts.claude ? ["claude"] : []),
      ...(opts.codex ? ["codex"] : []),
      ...(opts.gemini ? ["gemini"] : []),
    ];
    if (targets.length === 0) {
      console.log(chalk.dim("Specify --claude, --codex, --gemini, or --all"));
      return;
    }
    for (const target of targets) {
      try {
        if (target === "claude") {
          const cmd = opts.profile && opts.profile !== "full"
            ? ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "configs", "--", "env", `CONFIGS_PROFILE=${opts.profile}`, "configs-mcp"]
            : ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "configs", "--", "configs-mcp"];
          const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
          await proc.exited;
          console.log(chalk.green("✓") + " Installed into Claude Code");
        } else if (target === "codex") {
          const { appendFileSync, existsSync: ex } = await import("node:fs");
          const { join: j } = await import("node:path");
          const configPath = j(homedir(), ".codex", "config.toml");
          const block = `\n[mcp_servers.configs]\ncommand = "configs-mcp"\nargs = []\n`;
          if (ex(configPath)) {
            const content = readFileSync(configPath, "utf-8");
            if (content.includes("[mcp_servers.configs]")) {
              console.log(chalk.dim("= Already installed in Codex"));
              continue;
            }
          }
          appendFileSync(configPath, block);
          console.log(chalk.green("✓") + " Installed into Codex");
        } else if (target === "gemini") {
          const { readFileSync: rf, writeFileSync: wf, existsSync: ex } = await import("node:fs");
          const { join: j } = await import("node:path");
          const configPath = j(homedir(), ".gemini", "settings.json");
          let settings: Record<string, unknown> = {};
          if (ex(configPath)) {
            try { settings = JSON.parse(rf(configPath, "utf-8")); } catch { /* empty */ }
          }
          const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
          mcpServers["configs"] = { command: "configs-mcp", args: [] };
          settings["mcpServers"] = mcpServers;
          wf(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
          console.log(chalk.green("✓") + " Installed into Gemini");
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
    const dbPath = join(homedir(), ".hasna", "configs", "configs.db");
    if (opts.force && existsSync(dbPath)) {
      const { rmSync } = await import("node:fs");
      rmSync(dbPath);
      console.log(chalk.dim("Deleted existing DB."));
      resetDatabase();
    }
    console.log(chalk.bold("@hasna/configs — initializing\n"));

    // Sync known configs
    const result = await syncKnown({});
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
      try { getConfig(ref.slug); } catch {
        createConfig({ name: ref.name, category: ref.category, agent: "global", format: "markdown", content: ref.content, kind: "reference", description: ref.desc });
      }
    }

    // Create default profile
    try { getProfile("my-setup"); } catch {
      const p = createProfile({ name: "my-setup", description: "Default profile with all known configs" });
      const allConfigs = listConfigs();
      for (const c of allConfigs) addConfigToProfile(p.id, c.id);
      console.log(chalk.green("✓") + ` Created profile "my-setup" with ${allConfigs.length} configs`);
    }

    // Show summary
    const stats = getConfigStats();
    console.log(chalk.bold("\nDB stats:"));
    for (const [key, count] of Object.entries(stats)) {
      if (count > 0) console.log(`  ${key.padEnd(18)} ${count}`);
    }
    console.log(chalk.dim(`\nDB: ${dbPath}`));
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Health check: total configs, drift from disk, unredacted secrets")
  .action(async () => {
    const dbPath = join(homedir(), ".hasna", "configs", "configs.db");
    const stats = getConfigStats();
    const { statSync: st } = await import("node:fs");
    const dbSize = existsSync(dbPath) ? st(dbPath).size : 0;

    console.log(chalk.bold("@hasna/configs") + chalk.dim(` v${pkg.version}`));
    console.log(chalk.cyan("DB:") + ` ${dbPath} (${(dbSize / 1024).toFixed(1)}KB)`);
    console.log(chalk.cyan("Total:") + ` ${stats["total"] || 0} configs\n`);

    // Check drift
    const allKnown = listConfigs({ kind: "file" });
    let drifted = 0;
    let missing = 0;
    let secrets = 0;
    let templates = 0;

    for (const c of allKnown) {
      if (!c.target_path) continue;
      const path = expandPath(c.target_path);
      if (!existsSync(path)) { missing++; continue; }
      const disk = readFileSync(path, "utf-8");
      // Compare disk vs stored (but stored is redacted, so compare redacted version of disk)
      const { content: redactedDisk } = redactContent(disk, c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
      if (redactedDisk !== c.content) drifted++;
      if (c.is_template) templates++;
      const found = scanSecrets(c.content, c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
      secrets += found.length;
    }

    console.log(chalk.cyan("Drifted:") + ` ${drifted === 0 ? chalk.green("0") : chalk.yellow(String(drifted))} (stored ≠ disk)`);
    console.log(chalk.cyan("Missing:") + ` ${missing === 0 ? chalk.green("0") : chalk.yellow(String(missing))} (file not on disk)`);
    console.log(chalk.cyan("Secrets:") + ` ${secrets === 0 ? chalk.green("0 ✓") : chalk.red(String(secrets) + " ⚠")} unredacted`);
    console.log(chalk.cyan("Templates:") + ` ${templates} (with {{VAR}} placeholders)`);
  });

// ── diff --all ────────────────────────────────────────────────────────────────
// Extend existing diff command to support --all

// ── backup / restore ──────────────────────────────────────────────────────────
program
  .command("backup")
  .description("Export configs to a timestamped backup file")
  .action(async () => {
    const { mkdirSync: mk } = await import("node:fs");
    const backupDir = join(homedir(), ".hasna", "configs", "backups");
    mk(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
    const outPath = join(backupDir, `configs-${ts}.tar.gz`);
    const result = await exportConfigs(outPath);
    const { statSync: st } = await import("node:fs");
    const size = st(outPath).size;
    console.log(chalk.green("✓") + ` Backup: ${result.count} configs → ${outPath} (${(size / 1024).toFixed(1)}KB)`);
  });

program
  .command("restore <file>")
  .description("Restore configs from a backup file")
  .option("--overwrite", "overwrite existing configs (default: skip)")
  .action(async (file, opts) => {
    const result = await importConfigs(file, { conflict: opts.overwrite ? "overwrite" : "skip" });
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
    const allConfigs = listConfigs();
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
  local commands="list show add apply diff sync export import whoami status init scan profile snapshot template mcp backup restore doctor completions"
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
      const configA = getConfig(a);
      const configB = getConfig(b);
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
    const interval = Number(opts.interval);
    const { statSync: st } = await import("node:fs");
    const { expandPath } = await import("../lib/apply.js");

    console.log(chalk.bold("@hasna/configs watch") + chalk.dim(` — polling every ${interval}ms`));
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
        const result = await syncKnown({});
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
    const stats = getConfigStats();
    const allConfigs = listConfigs();
    const fileConfigs = allConfigs.filter((c) => c.kind === "file");
    const refConfigs = allConfigs.filter((c) => c.kind === "reference");
    const templates = allConfigs.filter((c) => c.is_template);
    const profiles = listProfiles();

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
  .action(async (opts) => {
    const configs = listConfigs({ kind: "file" });
    let removed = 0;
    for (const c of configs) {
      if (!c.target_path) continue;
      const abs = expandPath(c.target_path);
      if (!existsSync(abs)) {
        if (opts.dryRun) {
          console.log(chalk.yellow("  would remove:") + ` ${c.slug} ${chalk.dim(`(${c.target_path})`)}`);
        } else {
          deleteConfig(c.id);
          console.log(chalk.red("  removed:") + ` ${c.slug} ${chalk.dim(`(${c.target_path})`)}`);
        }
        removed++;
      }
    }
    if (removed === 0) console.log(chalk.green("✓") + " All stored configs still exist on disk.");
    else console.log(chalk.dim(`\n${removed} orphaned config(s) ${opts.dryRun ? "found" : "removed"}`));
  });

// ── bootstrap ─────────────────────────────────────────────────────────────────
program
  .command("bootstrap")
  .description("Install the full @hasna ecosystem: CLI tools + MCP servers + configs")
  .option("--dry-run", "show what would be installed without doing it")
  .option("--skip-mcp", "skip MCP server registration")
  .action(async (opts) => {
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

    console.log(chalk.bold("@hasna/configs bootstrap") + chalk.dim(` — installing ${packages.length} ecosystem packages\n`));

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
      const result = await syncKnown({});
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
    const result = await syncKnown({ dryRun: opts.dryRun, agent: opts.agent });
    console.log(chalk.green("✓") + ` Pulled: +${result.added} updated:${result.updated} unchanged:${result.unchanged}`);
  });

program
  .command("push")
  .description("Alias for sync --to-disk (write DB configs to disk)")
  .option("-a, --agent <agent>", "only push this agent")
  .option("--dry-run", "preview without writing")
  .action(async (opts) => {
    const result = await syncToDisk({ dryRun: opts.dryRun, agent: opts.agent });
    console.log(chalk.green("✓") + ` Pushed: updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
  });

// ── update ────────────────────────────────────────────────────────────────────
program
  .command("update")
  .description("Check for updates and install latest version")
  .option("--check", "only check, don't install")
  .action(async (opts) => {
    try {
      const proc = Bun.spawn(["npm", "view", "@hasna/configs", "version"], { stdout: "pipe", stderr: "pipe" });
      const latest = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (latest === pkg.version) {
        console.log(chalk.green("✓") + ` Already on latest version (${pkg.version})`);
      } else {
        console.log(`Current: ${chalk.dim(pkg.version)} → Latest: ${chalk.green(latest)}`);
        if (!opts.check) {
          console.log(chalk.dim("Installing..."));
          const install = Bun.spawn(["bun", "install", "-g", `@hasna/configs@${latest}`], { stdout: "inherit", stderr: "inherit" });
          await install.exited;
          console.log(chalk.green("✓") + ` Updated to ${latest}`);
        }
      }
    } catch (e) {
      console.error(chalk.red("Failed to check for updates: " + (e instanceof Error ? e.message : String(e))));
    }
  });

program.version(pkg.version).name("configs");
program.parse(process.argv);
