import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../mcp/server.js";
import type { Config, ConfigSnapshot, Profile } from "../types/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];
const servers: Array<{ stop(): void }> = [];

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function baseConfig(input: Partial<Config> & Pick<Config, "id" | "name" | "slug" | "content">): Config {
  return {
    kind: "file",
    category: "rules",
    agent: "global",
    target_path: null,
    outputs: [],
    format: "markdown",
    description: null,
    tags: [],
    is_template: false,
    version: 1,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    synced_at: null,
    ...input,
  };
}

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", "src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function startCloudApi(configs: Config[], profiles: Array<Profile & { configs: Config[] }> = []) {
  const calls: RecordedCall[] = [];
  const byIdOrSlug = (id: string) => configs.find((config) => config.id === id || config.slug === id);
  const profileByIdOrSlug = (id: string) => profiles.find((profile) => profile.id === id || profile.slug === id);
  const snapshots: Record<string, ConfigSnapshot[]> = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const bodyText = await req.text();
      const body = bodyText ? JSON.parse(bodyText) : undefined;
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

      if (req.headers.get("Authorization") !== "Bearer dummy") {
        return json({ error: "unauthorized" }, 401);
      }

      if (url.pathname === "/v1/configs" && req.method === "GET") {
        let rows = configs;
        const kind = url.searchParams.get("kind");
        const category = url.searchParams.get("category");
        const agent = url.searchParams.get("agent");
        if (kind) rows = rows.filter((config) => config.kind === kind);
        if (category) rows = rows.filter((config) => config.category === category);
        if (agent) rows = rows.filter((config) => config.agent === agent);
        return json({ configs: rows, count: rows.length });
      }

      const configMatch = url.pathname.match(/^\/v1\/configs\/([^/]+)(?:\/snapshots)?$/);
      if (configMatch) {
        const id = decodeURIComponent(configMatch[1]!);
        const config = byIdOrSlug(id);
        if (!config) return json({ error: `Config not found: ${id}` }, 404);
        if (url.pathname.endsWith("/snapshots")) {
          return json({ snapshots: snapshots[config.id] ?? [], count: snapshots[config.id]?.length ?? 0 });
        }
        if (req.method === "GET") return json({ config });
        if (req.method === "PATCH") {
          Object.assign(config, body, { updated_at: "2026-07-07T00:00:01.000Z" });
          return json({ config });
        }
      }

      if (url.pathname === "/v1/profiles" && req.method === "GET") {
        return json({ profiles: profiles.map(({ configs: _configs, ...profile }) => profile), count: profiles.length });
      }

      const profileMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
      if (profileMatch && req.method === "GET") {
        const id = decodeURIComponent(profileMatch[1]!);
        const profile = profileByIdOrSlug(id);
        if (!profile) return json({ error: `Profile not found: ${id}` }, 404);
        return json({ profile });
      }

      if (url.pathname === "/v1/stats" && req.method === "GET") {
        return json({ total: configs.length, rules: configs.filter((config) => config.category === "rules").length });
      }

      return json({ error: `unhandled ${req.method} ${url.pathname}` }, 404);
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return {
    apiUrl: `http://127.0.0.1:${server.port}`,
    calls,
  };
}

function cloudEnv(apiUrl: string, home: string) {
  return {
    HOME: home,
    HASNA_CONFIGS_HOME: join(home, ".hasna", "configs"),
    HASNA_INSTRUCTIONS_API_URL: apiUrl,
    HASNA_INSTRUCTIONS_API_KEY: "dummy",
  };
}

async function callMcpTool(name: string, args: Record<string, unknown>, env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "configs-cloud-mode-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({ name, arguments: args });
  } finally {
    try { await client.close(); } catch { /* closed */ }
    try { await server.close(); } catch { /* closed */ }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "open-configs-cloud-cli-"));
  tempDirs.push(home);
  return home;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("configs CLI self_hosted mode", () => {
  test("apply missing --dry-run routes to the API instead of the local DB guard", async () => {
    const home = makeHome();
    const { apiUrl, calls } = startCloudApi([]);
    const result = await runCli(["apply", "missing", "--dry-run"], cloudEnv(apiUrl, home));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Config not found: missing");
    expect(result.stderr).not.toContain("not wired to the cloud API yet");
    expect(calls.map((call) => call.path)).toEqual(["/v1/configs/missing"]);
  }, 20_000);

  test("API-backed commands read and update through /v1", async () => {
    const home = makeHome();
    const targetPath = join(home, "agent.md");
    writeFileSync(targetPath, "disk content");
    const sample = baseConfig({
      id: "cfg-1",
      name: "Sample",
      slug: "sample",
      content: "Hello {{NAME}}",
      target_path: targetPath,
      is_template: true,
    });
    const leaky = baseConfig({
      id: "cfg-2",
      name: "Leaky",
      slug: "leaky",
      content: ["OPENAI_API_KEY", "=", "not-a-real-secret-value-for-test"].join(""),
      format: "ini",
      category: "tools",
    });
    const profile: Profile & { configs: Config[] } = {
      id: "profile-1",
      name: "Setup",
      slug: "setup",
      description: null,
      selectors: {},
      variables: { NAME: "Cloud" },
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: "2026-07-07T00:00:00.000Z",
      configs: [sample],
    };
    const { apiUrl, calls } = startCloudApi([sample, leaky], [profile]);
    const env = cloudEnv(apiUrl, home);

    expect((await runCli(["session", "plan", "--tool", "codex", "--profile", "account999", "--target-home", join(home, "session"), "--config", "global:sample", "--json"], env)).status).toBe(0);
    expect((await runCli(["apply", "sample", "--dry-run"], env)).stdout).toContain("[dry-run]");
    expect((await runCli(["diff", "sample"], env)).stdout).toContain("--- stored (DB)");
    expect((await runCli(["template", "vars", "sample"], env)).stdout).toContain("{{NAME}}");
    expect((await runCli(["template", "render", "sample", "--var", "NAME=World"], env)).stdout).toContain("Hello World");
    expect((await runCli(["scan", "leaky", "--fix"], env)).stdout).toContain("Redacted");
    expect((await runCli(["profile", "apply", "setup", "--dry-run"], env)).status).toBe(0);
    expect((await runCli(["snapshot", "list", "sample"], env)).status).toBe(0);

    expect(calls.some((call) => call.path === "/v1/configs/sample")).toBe(true);
    expect(calls.some((call) => call.path === "/v1/configs")).toBe(true);
    expect(calls.some((call) => call.path === "/v1/profiles/setup")).toBe(true);
    expect(calls.some((call) => call.path === "/v1/configs/cfg-1/snapshots")).toBe(true);
    expect(calls.some((call) => call.method === "PATCH" && call.path === "/v1/configs/cfg-2")).toBe(true);
  }, 30_000);

  test("local-only commands are gated before local DB helpers", async () => {
    const home = makeHome();
    const env = cloudEnv("https://instructions.invalid", home);
    const gatedCommands = [
      ["sync"],
      ["sync", "--to-disk"],
      ["sync", "--project", home],
      ["pull"],
      ["push"],
      ["storage", "status"],
      ["storage", "pull"],
      ["storage", "push"],
      ["profile", "add", "setup", "sample"],
      ["profile", "remove", "setup", "sample"],
      ["profile", "apply", "--auto", "--dry-run"],
      ["snapshot", "show", "snap-1"],
    ];

    for (const args of gatedCommands) {
      const result = await runCli(args, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not available in self_hosted mode");
      expect(result.stderr).not.toContain("not wired to the cloud API yet");
    }
  }, 30_000);

  test("MCP apply_config uses /v1 context in self_hosted dry-run", async () => {
    const home = makeHome();
    const targetPath = join(home, "mcp-agent.md");
    const sample = baseConfig({
      id: "cfg-mcp",
      name: "MCP Sample",
      slug: "mcp-sample",
      content: "MCP cloud content",
      target_path: targetPath,
    });
    const { apiUrl, calls } = startCloudApi([sample]);

    const result = await callMcpTool("apply_config", {
      id_or_slug: "mcp-sample",
      dry_run: true,
    }, cloudEnv(apiUrl, home));

    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ text?: string }>;
    expect(content[0]?.text).toContain(targetPath);
    expect(calls.some((call) => call.path === "/v1/configs/mcp-sample")).toBe(true);
    expect(calls.some((call) => call.path === "/v1/configs")).toBe(true);
  }, 20_000);
});
