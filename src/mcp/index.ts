#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createConfig, getConfig, getConfigStats, listConfigs, updateConfig } from "../db/configs.js";
import { applyConfig } from "../lib/apply.js";
import { syncFromDir, syncToDir } from "../lib/sync.js";
import { listProfiles, getProfileConfigs } from "../db/profiles.js";
import { applyConfigs } from "../lib/apply.js";
import { listSnapshots, getSnapshotByVersion } from "../db/snapshots.js";
import type { ConfigAgent, ConfigCategory, ConfigFormat, ConfigKind } from "../types/index.js";

// ── Tool descriptions (full, for describe_tools) ─────────────────────────────
const TOOL_DOCS: Record<string, string> = {
  list_configs: "List configs. Params: category?, agent?, kind?, search?. Returns array of config objects.",
  get_config: "Get a config by id or slug. Returns full config including content.",
  create_config: "Create a new config. Required: name, content, category. Optional: agent, target_path, kind, format, tags, description, is_template.",
  update_config: "Update a config by id or slug. Optional: content, name, tags, description, category, agent, target_path.",
  apply_config: "Apply a config to its target_path on disk. Params: id_or_slug, dry_run?. Returns apply result.",
  sync_directory: "Sync a directory with the DB. Params: dir, direction ('from_disk'|'to_disk'). Returns sync result.",
  list_profiles: "List all profiles. Returns array of profile objects.",
  apply_profile: "Apply all configs in a profile to disk. Params: id_or_slug, dry_run?. Returns array of apply results.",
  get_snapshot: "Get snapshot(s) for a config. Params: config_id_or_slug, version?. Returns latest snapshot or specific version.",
  get_status: "Single-call orientation. Returns: total configs, counts by category, templates, DB path.",
  render_template: "Render a template config with variable substitution. Params: id_or_slug, vars? (object of KEY:VALUE), use_env? (fill from env vars). Returns rendered content.",
  scan_secrets: "Scan configs for unredacted secrets. Params: id_or_slug? (omit for all known), fix? (true to redact in-place). Returns findings.",
  sync_known: "Sync all known config files from disk into DB. Params: agent?, category?. Replaces sync_directory for standard use.",
  sync_project: "Sync project-scoped configs (CLAUDE.md, .mcp.json, AGENTS.md, rules/*.md) from a project dir. Params: project_dir (default: cwd).",
  search_tools: "Search tool descriptions. Params: query. Returns matching tool names and descriptions.",
  describe_tools: "Get full descriptions for tools. Params: names? (array). Returns tool docs.",
};

// ── Agent profiles — CONFIGS_PROFILE env var controls which tools are exposed ─
const PROFILES: Record<string, string[]> = {
  minimal: ["get_status", "get_config", "sync_known"],
  standard: ["list_configs", "get_config", "create_config", "update_config", "apply_config", "sync_known", "get_status", "render_template", "scan_secrets", "list_profiles", "apply_profile", "search_tools", "describe_tools"],
  full: [], // empty = all tools
};

const activeProfile = process.env["CONFIGS_PROFILE"] || "full";
const profileFilter = PROFILES[activeProfile];

// ── Lean stubs (minimal schema, no descriptions) ─────────────────────────────
const ALL_LEAN_TOOLS = [
  { name: "list_configs", inputSchema: { type: "object", properties: { category: { type: "string" }, agent: { type: "string" }, kind: { type: "string" }, search: { type: "string" } } } },
  { name: "get_config", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" } }, required: ["id_or_slug"] } },
  { name: "create_config", inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, category: { type: "string" }, agent: { type: "string" }, target_path: { type: "string" }, kind: { type: "string" }, format: { type: "string" }, tags: { type: "array", items: { type: "string" } }, description: { type: "string" }, is_template: { type: "boolean" } }, required: ["name", "content", "category"] } },
  { name: "update_config", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" }, content: { type: "string" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } }, description: { type: "string" }, category: { type: "string" }, agent: { type: "string" }, target_path: { type: "string" } }, required: ["id_or_slug"] } },
  { name: "delete_config", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" } }, required: ["id_or_slug"] } },
  { name: "apply_config", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" }, dry_run: { type: "boolean" } }, required: ["id_or_slug"] } },
  { name: "sync_directory", inputSchema: { type: "object", properties: { dir: { type: "string" }, direction: { type: "string" } }, required: ["dir"] } },
  { name: "list_profiles", inputSchema: { type: "object", properties: {} } },
  { name: "apply_profile", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" }, dry_run: { type: "boolean" } }, required: ["id_or_slug"] } },
  { name: "get_snapshot", inputSchema: { type: "object", properties: { config_id_or_slug: { type: "string" }, version: { type: "number" } }, required: ["config_id_or_slug"] } },
  { name: "get_status", inputSchema: { type: "object", properties: {} } },
  { name: "sync_known", inputSchema: { type: "object", properties: { agent: { type: "string" }, category: { type: "string" } } } },
  { name: "sync_project", inputSchema: { type: "object", properties: { project_dir: { type: "string" } } } },
  { name: "render_template", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" }, vars: { type: "object" }, use_env: { type: "boolean" } }, required: ["id_or_slug"] } },
  { name: "scan_secrets", inputSchema: { type: "object", properties: { id_or_slug: { type: "string" }, fix: { type: "boolean" } } } },
  { name: "search_tools", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "describe_tools", inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } } } },
  { name: "register_agent", description: "Register agent session.", inputSchema: { type: "object", properties: { name: { type: "string" }, session_id: { type: "string" } }, required: ["name"] } },
  { name: "heartbeat", description: "Update last_seen_at.", inputSchema: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] } },
  { name: "set_focus", description: "Set active project context.", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, project_id: { type: "string" } }, required: ["agent_id"] } },
  { name: "list_agents", description: "List all registered agents.", inputSchema: { type: "object", properties: {} } },
  { name: "send_feedback", description: "Send feedback about this service", inputSchema: { type: "object", properties: { message: { type: "string" }, email: { type: "string" }, category: { type: "string", enum: ["bug", "feature", "general"] } }, required: ["message"] } },
];

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
}

const _cfgAgents = new Map<string, { id: string; name: string; last_seen_at: string }>();

const server = new Server(
  { name: "configs", version: require("../../package.json").version },
  { capabilities: { tools: {} } }
);

const LEAN_TOOLS = profileFilter && profileFilter.length > 0
  ? ALL_LEAN_TOOLS.filter((t) => profileFilter.includes(t.name))
  : ALL_LEAN_TOOLS;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LEAN_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "list_configs": {
        const configs = listConfigs({
          category: (args["category"] as ConfigCategory) || undefined,
          agent: (args["agent"] as ConfigAgent) || undefined,
          kind: (args["kind"] as ConfigKind) || undefined,
          search: (args["search"] as string) || undefined,
        });
        return ok(configs.map((c) => ({ id: c.id, slug: c.slug, name: c.name, category: c.category, agent: c.agent, kind: c.kind, target_path: c.target_path, version: c.version })));
      }
      case "get_config": {
        const c = getConfig(args["id_or_slug"] as string);
        return ok(c);
      }
      case "create_config": {
        const c = createConfig({
          name: args["name"] as string,
          content: args["content"] as string,
          category: args["category"] as ConfigCategory,
          agent: (args["agent"] as ConfigAgent) || undefined,
          target_path: (args["target_path"] as string) || undefined,
          kind: (args["kind"] as ConfigKind) || undefined,
          format: (args["format"] as ConfigFormat) || undefined,
          tags: (args["tags"] as string[]) || undefined,
          description: (args["description"] as string) || undefined,
          is_template: (args["is_template"] as boolean) || undefined,
        });
        return ok({ id: c.id, slug: c.slug, name: c.name });
      }
      case "update_config": {
        const c = updateConfig(args["id_or_slug"] as string, {
          content: args["content"] as string | undefined,
          name: args["name"] as string | undefined,
          tags: args["tags"] as string[] | undefined,
          description: args["description"] as string | undefined,
          category: args["category"] as ConfigCategory | undefined,
          agent: args["agent"] as ConfigAgent | undefined,
          target_path: args["target_path"] as string | undefined,
        });
        return ok({ id: c.id, slug: c.slug, version: c.version });
      }
      case "delete_config": {
        const { deleteConfig } = await import("../db/configs.js");
        deleteConfig(args["id_or_slug"] as string);
        return ok({ deleted: true });
      }
      case "apply_config": {
        const config = getConfig(args["id_or_slug"] as string);
        const result = await applyConfig(config, { dryRun: args["dry_run"] as boolean });
        return ok(result);
      }
      case "sync_directory": {
        const dir = args["dir"] as string;
        const direction = (args["direction"] as string) || "from_disk";
        const result = direction === "to_disk"
          ? await syncToDir(dir)
          : await syncFromDir(dir);
        return ok(result);
      }
      case "list_profiles": {
        return ok(listProfiles());
      }
      case "apply_profile": {
        const configs = getProfileConfigs(args["id_or_slug"] as string);
        const results = await applyConfigs(configs, { dryRun: args["dry_run"] as boolean });
        return ok(results);
      }
      case "get_snapshot": {
        const config = getConfig(args["config_id_or_slug"] as string);
        if (args["version"]) {
          const snap = getSnapshotByVersion(config.id, args["version"] as number);
          return snap ? ok(snap) : err("Snapshot not found");
        }
        const snaps = listSnapshots(config.id);
        return ok(snaps[0] ?? null);
      }
      case "get_status": {
        const stats = getConfigStats();
        const allConfigs = listConfigs({ kind: "file" });
        const { existsSync: ex, readFileSync: rf } = await import("node:fs");
        const { expandPath } = await import("../lib/apply.js");
        const { redactContent } = await import("../lib/redact.js");
        let drifted = 0, missing = 0, templates = 0;
        const driftedSlugs: string[] = [];
        for (const c of allConfigs) {
          if (c.is_template) templates++;
          if (!c.target_path) continue;
          const abs = expandPath(c.target_path);
          if (!ex(abs)) { missing++; continue; }
          // Compare redacted disk content vs stored (lightweight — only for known configs, ~30 files)
          const disk = rf(abs, "utf-8");
          const { content: redactedDisk } = redactContent(disk, c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text");
          if (redactedDisk !== c.content) { drifted++; driftedSlugs.push(c.slug); }
        }
        return ok({
          total: stats["total"] || 0,
          by_category: Object.fromEntries(Object.entries(stats).filter(([k]) => k !== "total")),
          templates,
          drifted,
          drifted_configs: driftedSlugs.slice(0, 5),
          missing,
          db_path: process.env["CONFIGS_DB_PATH"] || "~/.hasna/configs/configs.db",
        });
      }
      case "sync_known": {
        const { syncKnown } = await import("../lib/sync.js");
        const result = await syncKnown({
          agent: (args["agent"] as ConfigAgent) || undefined,
          category: (args["category"] as ConfigCategory) || undefined,
        });
        return ok(result);
      }
      case "sync_project": {
        const { syncProject } = await import("../lib/sync.js");
        const dir = (args["project_dir"] as string) || process.cwd();
        const result = await syncProject({ projectDir: dir });
        return ok(result);
      }
      case "render_template": {
        const { renderTemplate } = await import("../lib/template.js");
        const config = getConfig(args["id_or_slug"] as string);
        const vars: Record<string, string> = (args["vars"] as Record<string, string>) || {};
        // Fill from env if requested
        if (args["use_env"]) {
          const { extractTemplateVars } = await import("../lib/template.js");
          for (const v of extractTemplateVars(config.content)) {
            if (!(v.name in vars) && process.env[v.name]) {
              vars[v.name] = process.env[v.name]!;
            }
          }
        }
        const rendered = renderTemplate(config.content, vars);
        return ok({ rendered, config_id: config.id, slug: config.slug });
      }
      case "scan_secrets": {
        const { scanSecrets, redactContent } = await import("../lib/redact.js");
        const configs = args["id_or_slug"]
          ? [getConfig(args["id_or_slug"] as string)]
          : listConfigs({ kind: "file" });
        const findings: Array<{ slug: string; secrets: number; vars: string[] }> = [];
        for (const c of configs) {
          const fmt = c.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text";
          const secrets = scanSecrets(c.content, fmt);
          if (secrets.length > 0) {
            findings.push({ slug: c.slug, secrets: secrets.length, vars: secrets.map((s) => s.varName) });
            if (args["fix"]) {
              const { content, isTemplate } = redactContent(c.content, fmt);
              updateConfig(c.id, { content, is_template: isTemplate });
            }
          }
        }
        return ok({ clean: findings.length === 0, findings, fixed: !!args["fix"] });
      }
      case "search_tools": {
        const query = ((args["query"] as string) || "").toLowerCase();
        const matches = Object.entries(TOOL_DOCS)
          .filter(([k, v]) => k.includes(query) || v.toLowerCase().includes(query))
          .map(([name, description]) => ({ name, description }));
        return ok(matches);
      }
      case "describe_tools": {
        const names = args["names"] as string[] | undefined;
        if (names) {
          return ok(Object.fromEntries(names.map((n) => [n, TOOL_DOCS[n] ?? "Unknown tool"])));
        }
        return ok(TOOL_DOCS);
      }
      case "register_agent": {
        const n = String(args["name"] ?? "");
        const existing = [..._cfgAgents.values()].find(x => x.name === n);
        if (existing) { existing.last_seen_at = new Date().toISOString(); return ok(existing); }
        const id = Math.random().toString(36).slice(2, 10);
        const ag = { id, name: n, last_seen_at: new Date().toISOString() };
        _cfgAgents.set(id, ag);
        return ok(ag);
      }
      case "heartbeat": {
        const ag = _cfgAgents.get(String(args["agent_id"] ?? ""));
        if (!ag) return err(`Agent not found: ${args["agent_id"]}`);
        ag.last_seen_at = new Date().toISOString();
        return ok({ agent_id: ag.id, name: ag.name, last_seen_at: ag.last_seen_at });
      }
      case "set_focus": {
        const ag = _cfgAgents.get(String(args["agent_id"] ?? ""));
        if (!ag) return err(`Agent not found: ${args["agent_id"]}`);
        (ag as Record<string, unknown>)["project_id"] = args["project_id"];
        return ok({ agent_id: ag.id, project_id: args["project_id"] ?? null });
      }
      case "list_agents": {
        return ok([..._cfgAgents.values()]);
      }
      case "send_feedback": {
        const { getDatabase } = await import("../db/database.js");
        const db = getDatabase();
        const pkg = require("../../package.json");
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          [args["message"] as string, (args["email"] as string) || null, (args["category"] as string) || "general", pkg.version]
        );
        return ok({ message: "Feedback saved. Thank you!" });
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
});

// Handle --claude install flag
if (process.argv.includes("--claude")) {
  const proc = Bun.spawn(
    ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "configs", "--", "configs-mcp"],
    { stdout: "inherit", stderr: "inherit" }
  );
  await proc.exited;
  process.exit(0);
}



const transport = new StdioServerTransport();
await server.connect(transport);
