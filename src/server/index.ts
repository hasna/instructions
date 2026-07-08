#!/usr/bin/env bun
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getPackageVersion } from "../lib/package-version.js";
import { handleV1Request } from "./v1.js";
import {
  getHonoAuthMiddleware,
  isCloudModeEnabled,
  pingCloud,
  resolveCloudDatabaseUrl,
  ensureCloudSchema,
  closeCloud,
} from "./cloud.js";
import { buildV1OpenApiDocument } from "./openapi.js";

// ── One-shot schema migration (used by the ECS migration task) ───────────────
//   instructions-serve migrate   |   instructions db migrate
if (process.argv.includes("migrate")) {
  if (!resolveCloudDatabaseUrl()) {
    console.error("migrate: no database URL (HASNA_INSTRUCTIONS_DATABASE_URL / INSTRUCTIONS_DATABASE_URL / DATABASE_URL)");
    process.exit(2);
  }
  console.log("migrate: connecting…");
  await pingCloud();
  console.log("migrate: applying schema (instructions tables + api_keys)…");
  await ensureCloudSchema();
  console.log("migrate: done");
  await closeCloud();
  process.exit(0);
}

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(getPackageVersion());
  process.exit(0);
}

const PORT = Number(
  process.env["PORT"] ?? process.env["INSTRUCTIONS_PORT"] ?? process.env["CONFIGS_PORT"] ?? 3457,
);

const app = new Hono();
app.use("*", cors());

// ── Service surface probes (unauthenticated): /health /ready /version ─────────
function serviceMode(): "cloud" | "local" {
  return isCloudModeEnabled() ? "cloud" : "local";
}

app.get("/health", (c) => c.json({ status: "ok", version: getPackageVersion(), mode: serviceMode(), name: "instructions" }));

app.get("/version", (c) => c.json({ status: "ok", version: getPackageVersion(), mode: serviceMode(), name: "instructions" }));

app.get("/ready", async (c) => {
  const version = getPackageVersion();
  const mode = serviceMode();
  if (mode === "cloud") {
    try {
      await pingCloud();
    } catch (e) {
      return c.json({ status: "unavailable", version, mode, error: (e as Error).message }, 503);
    }
  }
  return c.json({ status: "ready", version, mode });
});

// ── OpenAPI document (unauthenticated; the SDK's source of truth) ─────────────
app.get("/openapi.json", (c) => c.json(buildV1OpenApiDocument()));
app.get("/v1/openapi.json", (c) => c.json(buildV1OpenApiDocument()));

// ── Versioned cloud API (/v1/*): A1 pure-remote, contracts API-key auth ───────
// Auth is the contracts `honoApiKey` middleware; reads need `instructions:read`,
// writes need `instructions:write` (an `instructions:*` key satisfies both).
app.use("/v1/*", async (c, next) => {
  const isWrite = c.req.method !== "GET" && c.req.method !== "HEAD";
  let mw;
  try {
    mw = getHonoAuthMiddleware([isWrite ? "instructions:write" : "instructions:read"]);
  } catch (e) {
    // Fail closed: /v1 is never an unauthenticated backdoor.
    return c.json({ error: (e as Error).message }, 503);
  }
  return mw(c, next);
});

app.all("/v1/*", async (c) => {
  const res = await handleV1Request(c.req.raw, new URL(c.req.url));
  return res ?? c.json({ error: "Not found" }, 404);
});

// ── MCP is a CLIENT transport, never mounted on the cloud server ─────────────
// The MCP server (src/mcp) runs on the operator's machine (stdio or the local
// `instructions mcp --http` process on 127.0.0.1). Its tools resolve the Store
// from the client env, so with HASNA_INSTRUCTIONS_API_URL/KEY set they route to
// this server's authenticated /v1 API — the same path the CLI/SDK use.
//
// It is deliberately NOT mounted here: on ECS the container holds a DATABASE_URL
// (not the client API env), so a server-mounted /mcp would resolve to an
// ephemeral on-container SQLite store instead of RDS (split-brain), and being
// outside the /v1/* auth middleware it would be unauthenticated. Only /v1/* (and
// the unauthenticated health/version probes above) are exposed by the server.

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

const HOST = process.env["HOST"] ?? process.env["INSTRUCTIONS_HOST"] ?? process.env["CONFIGS_HOST"] ?? "localhost";
console.log(`instructions-serve listening on http://${HOST}:${PORT} (mode: ${serviceMode()})${dashDir ? " (dashboard: /)" : " (no dashboard)"}`);
export default { port: PORT, hostname: HOST, fetch: app.fetch };
