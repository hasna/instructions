#!/usr/bin/env bun
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createConfig, deleteConfig, getConfig, getConfigById, getConfigStats, listConfigs, updateConfig } from "../db/configs.js";
import { createProfile, deleteProfile, getProfile, getProfileConfigs, listProfiles, resolveProfileForMachine, updateProfile } from "../db/profiles.js";
import { listSnapshots, createSnapshot } from "../db/snapshots.js";
import { listMachines, registerMachine } from "../db/machines.js";
import { applyConfig, applyConfigs } from "../lib/apply.js";
import { syncKnown } from "../lib/sync.js";
import { syncFromDir, syncToDir } from "../lib/sync-dir.js";
import { detectMachineContext, resolveProfileVariables } from "../lib/machine.js";
import type { ConfigAgent, ConfigCategory, ConfigFormat, ConfigKind } from "../types/index.js";

const PORT = Number(process.env["CONFIGS_PORT"] ?? 3457);

function pickFields<T extends object>(obj: T, fields?: string): Partial<T> | T {
  if (!fields) return obj;
  const keys = fields.split(",").map((f) => f.trim());
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, (obj as Record<string, unknown>)[k]])) as Partial<T>;
}


const app = new Hono();
app.use("*", cors());

// ── Status + Stats ────────────────────────────────────────────────────────────
app.get("/api/stats", (c) => c.json(getConfigStats()));

app.get("/api/status", (c) => {
  const stats = getConfigStats();
  const allConfigs = listConfigs({ kind: "file" });
  let templates = 0;
  for (const cfg of allConfigs) { if (cfg.is_template) templates++; }
  return c.json({
    total: stats["total"] || 0,
    by_category: Object.fromEntries(Object.entries(stats).filter(([k]) => k !== "total")),
    templates,
    db_path: process.env["CONFIGS_DB_PATH"] || "~/.hasna/configs/configs.db",
  });
});

// ── Sync known ────────────────────────────────────────────────────────────────
app.post("/api/sync-known", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await syncKnown({ agent: body.agent, category: body.category, dryRun: body.dry_run });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.post("/api/sync-project", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { syncProject } = await import("../lib/sync.js");
    const result = await syncProject({ projectDir: body.project_dir || process.cwd() });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.post("/api/render-template", async (c) => {
  try {
    const body = await c.req.json();
    const { renderTemplate } = await import("../lib/template.js");
    const config = getConfig(body.id_or_slug);
    const vars: Record<string, string> = body.vars || {};
    if (body.use_env) {
      const { extractTemplateVars } = await import("../lib/template.js");
      for (const v of extractTemplateVars(config.content)) {
        if (!(v.name in vars) && process.env[v.name]) vars[v.name] = process.env[v.name]!;
      }
    }
    return c.json({ rendered: renderTemplate(config.content, vars), config_id: config.id, slug: config.slug });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.post("/api/scan-secrets", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { scanSecrets, redactContent } = await import("../lib/redact.js");
    const configs = body.id_or_slug ? [getConfig(body.id_or_slug)] : listConfigs({ kind: "file" });
    const findings: Array<{ slug: string; secrets: number; vars: string[] }> = [];
    for (const cfg of configs) {
      const fmt = cfg.format as "shell" | "json" | "toml" | "ini" | "markdown" | "text";
      const secrets = scanSecrets(cfg.content, fmt);
      if (secrets.length > 0) {
        findings.push({ slug: cfg.slug, secrets: secrets.length, vars: secrets.map((s) => s.varName) });
        if (body.fix) {
          const { content, isTemplate } = redactContent(cfg.content, fmt);
          updateConfig(cfg.id, { content, is_template: isTemplate });
        }
      }
    }
    return c.json({ clean: findings.length === 0, findings, fixed: !!body.fix });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

// ── Configs ───────────────────────────────────────────────────────────────────
app.get("/api/configs", (c) => {
  const { category, agent, kind, search, fields } = c.req.query();
  const configs = listConfigs({
    category: category as ConfigCategory || undefined,
    agent: agent as ConfigAgent || undefined,
    kind: kind as ConfigKind || undefined,
    search: search || undefined,
  });
  return c.json(fields ? configs.map((cfg) => pickFields(cfg, fields)) : configs);
});

app.post("/api/configs", async (c) => {
  try {
    const body = await c.req.json();
    const config = createConfig({
      name: body.name,
      content: body.content ?? "",
      category: body.category,
      agent: body.agent,
      kind: body.kind,
      target_path: body.target_path,
      format: body.format,
      tags: body.tags,
      description: body.description,
      is_template: body.is_template,
    });
    return c.json(config, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.get("/api/configs/:id", (c) => {
  try {
    const { fields } = c.req.query();
    const config = getConfig(c.req.param("id"));
    return c.json(pickFields(config, fields));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

app.put("/api/configs/:id", async (c) => {
  try {
    const body = await c.req.json();
    const config = updateConfig(c.req.param("id"), body);
    return c.json(config);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.delete("/api/configs/:id", (c) => {
  try {
    deleteConfig(c.req.param("id"));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

app.post("/api/configs/:id/apply", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const config = getConfig(c.req.param("id"));
    const result = await applyConfig(config, { dryRun: body.dry_run });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.post("/api/configs/:id/snapshot", async (c) => {
  try {
    const config = getConfig(c.req.param("id"));
    const snap = createSnapshot(config.id, config.content, config.version);
    return c.json(snap, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.get("/api/configs/:id/snapshots", (c) => {
  try {
    const { fields } = c.req.query();
    const config = getConfig(c.req.param("id"));
    const snaps = listSnapshots(config.id);
    return c.json(fields ? snaps.map((s) => pickFields(s, fields)) : snaps);
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post("/api/sync", async (c) => {
  try {
    const body = await c.req.json();
    const dir = body.dir || "~/.claude";
    // SECURITY: restrict to home directory paths only
    const { resolve } = require("node:path");
    const { homedir: hd } = require("node:os");
    const absDir = dir.startsWith("~/") ? resolve(hd(), dir.slice(2)) : resolve(dir);
    if (!absDir.startsWith(hd())) {
      return c.json({ error: "Sync restricted to home directory paths" }, 403);
    }
    const direction = body.direction || "from_disk";
    const result = direction === "to_disk"
      ? await syncToDir(dir, { dryRun: body.dry_run })
      : await syncFromDir(dir, { dryRun: body.dry_run });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

// ── Profiles ──────────────────────────────────────────────────────────────────
app.get("/api/profiles", (c) => {
  const { fields } = c.req.query();
  const profiles = listProfiles();
  return c.json(fields ? profiles.map((p) => pickFields(p, fields)) : profiles);
});

app.post("/api/profiles", async (c) => {
  try {
    const body = await c.req.json();
    const profile = createProfile({
      name: body.name,
      description: body.description,
      selectors: body.selectors,
      variables: body.variables,
    });
    return c.json(profile, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.get("/api/profiles/:id", (c) => {
  try {
    const profile = getProfile(c.req.param("id"));
    const configs = getProfileConfigs(c.req.param("id"));
    return c.json({ ...profile, configs });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

app.put("/api/profiles/:id", async (c) => {
  try {
    const body = await c.req.json();
    const profile = updateProfile(c.req.param("id"), body);
    return c.json(profile);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.delete("/api/profiles/:id", (c) => {
  try {
    deleteProfile(c.req.param("id"));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

app.post("/api/profiles/:id/apply", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const machine = detectMachineContext({ hostname: body.hostname, os: body.os, arch: body.arch });
    const profile = getProfile(c.req.param("id"));
    const configs = getProfileConfigs(profile.id);
    const results = await applyConfigs(configs, {
      dryRun: body.dry_run,
      vars: resolveProfileVariables(profile, machine),
    });
    return c.json({ profile, machine, results });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.post("/api/profiles/resolve", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const machine = detectMachineContext({ hostname: body.hostname, os: body.os, arch: body.arch });
    const profile = resolveProfileForMachine(machine);
    if (!profile) return c.json({ error: "No matching machine-aware profile found" }, 404);
    return c.json({ profile, machine, variables: resolveProfileVariables(profile, machine) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

app.post("/api/profiles/apply-auto", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const machine = detectMachineContext({ hostname: body.hostname, os: body.os, arch: body.arch });
    const profile = resolveProfileForMachine(machine);
    if (!profile) return c.json({ error: "No matching machine-aware profile found" }, 404);
    const configs = getProfileConfigs(profile.id);
    const results = await applyConfigs(configs, {
      dryRun: body.dry_run,
      vars: resolveProfileVariables(profile, machine),
    });
    return c.json({ profile, machine, results });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

// ── Machines ──────────────────────────────────────────────────────────────────
app.get("/api/machines", (c) => {
  const { fields } = c.req.query();
  const machines = listMachines();
  return c.json(fields ? machines.map((m) => pickFields(m, fields)) : machines);
});

app.post("/api/machines", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const machine = registerMachine(body.hostname, body.os, body.arch);
    return c.json(machine, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────
import { createRequire } from "node:module";
const serverPkg = createRequire(import.meta.url)("../../package.json") as { version: string };
app.get("/health", (c) => c.json({ ok: true, version: serverPkg.version }));

// ── Dashboard (serve static files from dashboard/dist/) ──────────────────────
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function findDashboardDir(): string | null {
  // Try multiple locations: relative to script, installed package
  const candidates = [
    join(import.meta.dir, "../../dashboard/dist"),
    join(import.meta.dir, "../dashboard/dist"),
    join(import.meta.dir, "../../../dashboard/dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

const dashDir = findDashboardDir();
if (dashDir) {
  const resolvedDashDir = require("node:path").resolve(dashDir);
  app.get("/*", (c) => {
    const url = new URL(c.req.url);
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    let absPath = require("node:path").resolve(join(dashDir, filePath));

    // SECURITY: prevent path traversal — resolved path must stay within dashboard dir
    if (!absPath.startsWith(resolvedDashDir)) return c.json({ error: "Forbidden" }, 403);

    // If file doesn't exist, serve index.html (SPA routing)
    if (!existsSync(absPath)) absPath = join(dashDir, "index.html");
    if (!existsSync(absPath)) return c.json({ error: "Not found" }, 404);

    const content = readFileSync(absPath);
    const ext = extname(absPath);
    return new Response(content, {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
    });
  });
}

const HOST = process.env["CONFIGS_HOST"] ?? "localhost";
console.log(`configs-serve listening on http://${HOST}:${PORT}${dashDir ? " (dashboard: /" : " (no dashboard found)"}`);
export default { port: PORT, hostname: HOST, fetch: app.fetch };
