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
let savedApiUrl: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  // Isolation, per open defect b19d3d37: HASNA_INSTRUCTIONS_DB_PATH is consulted
  // ONLY by LocalConfigStore. resolveConfigStore() returns the CloudConfigStore
  // whenever the API vars are set, so setting DB_PATH alone does NOT isolate —
  // it silently writes into the shared fleet store. Both API vars must be unset.
  savedApiUrl = process.env["HASNA_INSTRUCTIONS_API_URL"];
  savedApiKey = process.env["HASNA_INSTRUCTIONS_API_KEY"];
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
  // Restore ambient state — see http.test.ts's afterEach for the measured
  // consequence (todos 195272ae, Finding 2) of deleting these two vars without
  // restoring them: under bun test's default non-isolated runner, every test
  // file shares one process.env, so the leak silently masks the very hazard
  // this beforeEach's own comment (defect b19d3d37) documents, for every test
  // file that runs afterward in the same process.
  if (savedApiUrl !== undefined) process.env["HASNA_INSTRUCTIONS_API_URL"] = savedApiUrl;
  else delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  if (savedApiKey !== undefined) process.env["HASNA_INSTRUCTIONS_API_KEY"] = savedApiKey;
  else delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
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

  it("refuses a second reference row on a name an existing reference row already owns (todos 195272ae, Finding 1)", async () => {
    // Exemption from the target-path guard above is not exemption from ANY
    // identity check. A reference config's identity is its NAME (see
    // config-target-identity.ts's doc comment) — the CLI has enforced this
    // since todos 757cefdb (add-reference-update.test.ts), but this handler
    // is the surface agents actually reach through, and until this fix it had
    // no such check at all: calling create_config with kind:"reference" and a
    // name that already exists always minted a fresh duplicate row, with
    // nothing to stop it and nothing to warn about it.
    await withClient(async (call) => {
      const first = await call("create_config", {
        name: "Reference Guide",
        category: "rules",
        content: "first",
        kind: "reference",
      });
      expect(first.isError).toBe(false);
      const firstSlug = JSON.parse(first.text).slug as string;

      const second = await call("create_config", {
        name: "Reference Guide",
        category: "rules",
        content: "second",
        kind: "reference",
      });

      expect(second.isError).toBe(true);
      expect(second.text).toContain("is already tracked by");
      expect(second.text).toContain(firstSlug);

      const list = await call("list_configs", { limit: 100, kind: "reference" });
      expect(list.text).not.toContain("second");
    });
  });

  it("refuses a case/punctuation variant of a name an existing reference row already owns (todos 195272ae, Finding 1)", async () => {
    await withClient(async (call) => {
      const first = await call("create_config", {
        name: "Reference Guide",
        category: "rules",
        content: "first",
        kind: "reference",
      });
      expect(first.isError).toBe(false);
      const firstSlug = JSON.parse(first.text).slug as string;

      // Different exact string, same identity once slugified — the case this
      // fix's unit tests reproduce in config-target-identity.test.ts.
      const second = await call("create_config", {
        name: "reference guide",
        category: "rules",
        content: "second",
        kind: "reference",
      });

      expect(second.isError).toBe(true);
      expect(second.text).toContain("is already tracked by");
      expect(second.text).toContain(firstSlug);
    });
  });
});
