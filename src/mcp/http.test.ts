import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "../db/configs.js";
import { getDatabase, resetDatabase } from "../db/database.js";
import { addConfigToProfile, createProfile } from "../db/profiles.js";
import { buildServer } from "./server.js";
import {
  healthPayload,
  isHttpMode,
  resolveHttpPort,
  startMcpHttpServer,
} from "./http.js";

const servers: Array<{ stop: () => void }> = [];

beforeEach(() => {
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
  resetDatabase();
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("configs MCP HTTP transport", () => {
  it("isHttpMode and resolveHttpPort work", () => {
    expect(isHttpMode(["--http"])).toBe(true);
    expect(resolveHttpPort([])).toBe(8853);
  });

  it("buildServer constructs a server", async () => {
    const server = buildServer();
    expect(server).toBeDefined();
    await server.close();
  });

  it("GET /health returns ok payload", async () => {
    const { port, stop } = await startMcpHttpServer(0);
    servers.push({ stop });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(healthPayload());
  });

  it("handles MCP initialize + get_status over Streamable HTTP", async () => {
    const { port, stop } = await startMcpHttpServer(0);
    servers.push({ stop });

    const client = new Client(
      { name: "configs-http-test", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );

    try {
      await client.connect(transport, { timeout: 15_000 });
      const tools = await client.listTools(undefined, { timeout: 15_000 });
      expect(tools.tools.some((t) => t.name === "get_status")).toBe(true);

      const result = await client.callTool(
        { name: "get_status", arguments: {} },
        undefined,
        { timeout: 30_000 }
      );
      const content = result.content as Array<{ type?: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      const text = content[0]?.text ?? "";
      expect(text).toContain("total");
    } finally {
      try {
        await client.close();
      } catch {
        // Stateless HTTP may already have closed the session.
      }
    }
  });

  it("serves three concurrent MCP clients from one process", async () => {
    const { port, stop } = await startMcpHttpServer(0);
    servers.push({ stop });

    async function callStatus() {
      const client = new Client(
        { name: "configs-http-concurrent", version: "1.0.0" },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`)
      );
      await client.connect(transport, { timeout: 15_000 });
      const result = await client.callTool({ name: "get_status", arguments: {} }, undefined, {
        timeout: 30_000,
      });
      try {
        await client.close();
      } catch {
        // Stateless HTTP may already have closed the session.
      }
      return result;
    }

    const results = await Promise.all([callStatus(), callStatus(), callStatus()]);
    expect(
      results.every((r) => (r.content as Array<{ type?: string }>)[0]?.type === "text")
    ).toBe(true);
  });

  it("applies direct and profile dry-runs through one ownership gate", async () => {
    const home = mkdtempSync(join(tmpdir(), "configs-mcp-ownership-"));
    process.env["CONFIGS_HOME"] = home;
    const db = getDatabase();
    const claude = createConfig({
      name: "Claude Legacy Writer",
      category: "rules",
      agent: "claude",
      content: "legacy claude",
      target_path: "~/.claude/CLAUDE.md",
    }, db);
    const antigravity = createConfig({
      name: "Antigravity Legacy Writer",
      category: "rules",
      agent: "antigravity",
      content: "legacy antigravity",
      target_path: "~/.gemini/GEMINI.md",
    }, db);
    const opencode = createConfig({
      name: "OpenCode Settings",
      category: "agent",
      agent: "opencode",
      format: "json",
      content: JSON.stringify({ model: "preserved-model", mcp: { preserved: true } }),
      target_path: "~/.config/opencode/opencode.json",
    }, db);
    const profile = createProfile({ name: "Ownership Preview" }, db);
    for (const config of [claude, antigravity, opencode]) addConfigToProfile(profile.id, config.id, db);

    const { port, stop } = await startMcpHttpServer(0);
    servers.push({ stop });
    const client = new Client(
      { name: "configs-http-ownership", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport, { timeout: 15_000 });
      const direct = await client.callTool({
        name: "apply_config",
        arguments: { id_or_slug: claude.slug, dry_run: true, verbose: true },
      });
      const directPayload = JSON.parse((direct.content as Array<{ text?: string }>)[0]?.text ?? "{}") as {
        results: unknown[];
        skipped: Array<{ owner: string; path: string }>;
      };
      expect(directPayload.results).toEqual([]);
      expect(directPayload.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "instructions-session-renderer", path: join(home, ".claude", "CLAUDE.md") }),
      ]));

      const profileResult = await client.callTool({
        name: "apply_profile",
        arguments: {
          id_or_slug: profile.slug,
          dry_run: true,
          hostname: "station01",
          os: "linux",
          arch: "arm64",
          verbose: true,
        },
      });
      const profilePayload = JSON.parse((profileResult.content as Array<{ text?: string }>)[0]?.text ?? "{}") as {
        results: Array<{ path: string; new_content: string }>;
        skipped: Array<{ owner: string; path: string }>;
      };
      expect(new Set(profilePayload.skipped.map((entry) => entry.path))).toEqual(new Set([
        join(home, ".claude", "CLAUDE.md"),
        join(home, ".gemini", "GEMINI.md"),
      ]));
      expect(profilePayload.skipped.every((entry) => entry.owner === "instructions-session-renderer")).toBe(true);
      expect(profilePayload.results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: join(home, ".config", "opencode", "opencode.json"),
          new_content: expect.stringContaining("preserved-model"),
        }),
      ]));
      expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(home, ".gemini", "GEMINI.md"))).toBe(false);
      expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    } finally {
      try {
        await client.close();
      } catch {
        // Stateless HTTP may already have closed the session.
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
