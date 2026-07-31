import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigStore } from "../data/config-store.js";
import { getDatabase, resetDatabase } from "../db/database.js";
import { startMcpHttpServer } from "./http.js";
import { makeTempRoot } from "../lib/test-temp-root";

/**
 * The MCP is the surface AGENTS reach through, and until 0.4.14 it did not share
 * the duplicate-target-path guard that `instructions add` enforces. The CLI
 * refused a second row on an owned path while `create_config` minted one
 * silently, so the CLI's refusal read as fleet-wide protection that was not.
 *
 * These tests drive the REAL dispatch — buildServer() over the real Streamable
 * HTTP transport with a real MCP client — deliberately. The neighbouring
 * mcp.test.ts re-implements the dispatch and calls the db layer directly, which
 * is precisely why it could never have caught this: a test that re-implements
 * the handler proves only that the test agrees with itself.
 */

const servers: Array<{ stop: () => void }> = [];
let configsHome: string;

beforeEach(() => {
  // Isolation, per open defect b19d3d37: HASNA_INSTRUCTIONS_DB_PATH is consulted
  // ONLY by LocalConfigStore. resolveConfigStore() returns the CloudConfigStore
  // whenever the API vars are set, so setting DB_PATH alone does NOT isolate —
  // it silently writes into the shared fleet store. Both API vars must be unset.
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  resetDatabase();
  getDatabase();

  // Verify the isolation HELD rather than merely requesting it. If this ever
  // reports "api", every write below lands in production config for the fleet.
  expect(resolveConfigStore().mode).toBe("local");

  configsHome = makeTempRoot("configs-mcp-target-guard-");
  process.env["CONFIGS_HOME"] = configsHome;
});

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop();
  resetDatabase();
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

async function withClient<T>(fn: (call: CallTool) => Promise<T>): Promise<T> {
  const { port, stop } = await startMcpHttpServer(0);
  servers.push({ stop });
  const client = new Client({ name: "configs-target-guard-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport, { timeout: 15_000 });
  try {
    return await fn(async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
      const content = result.content as Array<{ type?: string; text?: string }>;
      return { isError: Boolean(result.isError), text: content[0]?.text ?? "" };
    });
  } finally {
    try {
      await client.close();
    } catch {
      // Stateless HTTP may already have closed the session.
    }
  }
}

type CallTool = (
  name: string,
  args: Record<string, unknown>
) => Promise<{ isError: boolean; text: string }>;

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "on disk\n");
}

describe("MCP create_config duplicate-target-path guard", () => {
  it("refuses a second row on a target path an existing row already owns", async () => {
    await withClient(async (call) => {
      const first = await call("create_config", {
        name: "Claude Rules",
        category: "rules",
        content: "first",
        target_path: "~/.claude/CLAUDE.md",
      });
      expect(first.isError).toBe(false);
      const firstSlug = JSON.parse(first.text).slug as string;

      const second = await call("create_config", {
        name: "Claude Rules Twin",
        category: "rules",
        content: "second",
        target_path: "~/.claude/CLAUDE.md",
      });

      expect(second.isError).toBe(true);
      expect(second.text).toContain("is already tracked by");
      // The refusal must NAME the owning row, exactly as the CLI does, or the
      // caller cannot act on it.
      expect(second.text).toContain(firstSlug);

      // And the twin must not exist: a guard that reports a refusal after
      // inserting the row is worse than no guard.
      const list = await call("list_configs", { limit: 100 });
      expect(list.text).not.toContain("Claude Rules Twin");
    });
  });

  it("collapses alternate spellings of one path, matching the CLI's normalizeTargetPath route", async () => {
    await withClient(async (call) => {
      const first = await call("create_config", {
        name: "Tilde Owner",
        category: "rules",
        content: "first",
        target_path: "~/.codex/AGENTS.md",
      });
      expect(first.isError).toBe(false);

      // Same file, spelled absolutely. A raw-string comparison lets this through;
      // normalizeTargetPath collapses it. This is the spelling that let a twin row
      // in through the CLI before the guard was routed through the helper.
      const absolute = await call("create_config", {
        name: "Absolute Twin",
        category: "rules",
        content: "second",
        target_path: join(configsHome, ".codex", "AGENTS.md"),
      });
      expect(absolute.isError).toBe(true);
      expect(absolute.text).toContain("is already tracked by");
    });
  });

  it("collapses a symlinked ancestor onto the real path", async () => {
    const realDir = join(configsHome, "real");
    const target = join(realDir, "CONFIG.md");
    touch(target);
    symlinkSync(realDir, join(configsHome, "link"));

    await withClient(async (call) => {
      const first = await call("create_config", {
        name: "Real Path Owner",
        category: "rules",
        content: "first",
        target_path: target,
      });
      expect(first.isError).toBe(false);

      const viaLink = await call("create_config", {
        name: "Symlink Twin",
        category: "rules",
        content: "second",
        target_path: join(configsHome, "link", "CONFIG.md"),
      });
      expect(viaLink.isError).toBe(true);
      expect(viaLink.text).toContain("is already tracked by");
    });
  });

  it("exempts kind:reference, which owns no target path", async () => {
    await withClient(async (call) => {
      const first = await call("create_config", {
        name: "Reference One",
        category: "rules",
        content: "first",
        kind: "reference",
        target_path: "~/.claude/REFERENCED.md",
      });
      expect(first.isError).toBe(false);

      // Two references may name one path: a reference is a pointer, not a writer,
      // so it cannot race an apply. The CLI exempts them and so must this.
      const second = await call("create_config", {
        name: "Reference Two",
        category: "rules",
        content: "second",
        kind: "reference",
        target_path: "~/.claude/REFERENCED.md",
      });
      expect(second.isError).toBe(false);
    });
  });

  it("still creates rows that carry no target path at all", async () => {
    await withClient(async (call) => {
      const first = await call("create_config", { name: "Pathless One", category: "rules", content: "a" });
      const second = await call("create_config", { name: "Pathless Two", category: "rules", content: "b" });
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
    });
  });
});
