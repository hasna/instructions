import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDatabase, resetDatabase } from "../db/database.js";
import { buildServer } from "./server.js";
import {
  healthPayload,
  isHttpMode,
  resolveHttpPort,
  startMcpHttpServer,
} from "./http.js";

const servers: Array<{ stop: () => void }> = [];

beforeEach(() => {
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
});
