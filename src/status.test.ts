import { LocalConfigStore } from "./data/config-store";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "./db/database";
import { createConfig } from "./db/configs";
import { createProfile, addConfigToProfile } from "./db/profiles";
import { registerMachine } from "./db/machines";
import { getConfigsStatus } from "./status";
import type { ConfigAgent } from "./types";

let tempDir = "";

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tempDir = join(tmpdir(), `configs-status-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  resetDatabase();
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getConfigsStatus", () => {
  test("reports metadata-only counts without config values, paths, or hostnames", async () => {
    const db = getDatabase();
    const privateTarget = join(tempDir, "private-host.internal", "agent.conf");
    mkdirSync(join(tempDir, "private-host.internal"), { recursive: true });
    writeFileSync(privateTarget, "OPENAI_API_KEY=sk-private-disk-token\n");

    const config = createConfig({
      name: "Private Agent Config",
      kind: "file",
      category: "agent",
      agent: "codex",
      target_path: privateTarget,
      format: "text",
      content: "OPENAI_API_KEY=sk-private-stored-token\n",
      is_template: true,
    }, db);
    const reference = createConfig({
      name: "Synthetic Reference",
      kind: "reference",
      category: "rules",
      agent: "global",
      format: "markdown",
      content: "do not include raw reference text",
    }, db);
    const profile = createProfile({ name: "Synthetic Profile" }, db);
    addConfigToProfile(profile.id, config.id, db);
    registerMachine("private-host.internal", "Linux", "x64", db);

    const status = await getConfigsStatus(new LocalConfigStore(db));
    const serialized = JSON.stringify(status);

    const { name, version } = JSON.parse(readFileSync("package.json", "utf-8")) as { name: string; version: string };

    expect(status).toMatchObject({
      service: "configs",
      schemaVersion: "1.0",
      package: { name, version },
      counts: {
        configs: {
          total: 2,
          file: 1,
          reference: 1,
          templates: 1,
          retiredAgentRows: 0,
        },
        profiles: 1,
        profileLinks: 1,
        machines: 1,
        knownTargets: 1,
      },
      health: {
        status: "warn",
        driftedTargets: 1,
        retiredAgentRows: 0,
      },
      safety: {
        includesConfigValues: false,
        includesPrivatePaths: false,
        includesHostnames: false,
        includesSecretValues: false,
        statusOutputIsMetadataOnly: true,
      },
    });
    expect(status.counts.byCategory.agent).toBe(1);
    expect(status.counts.byCategory.rules).toBe(1);
    expect(status.counts.byAgent.codex).toBe(1);
    expect(status.counts.byAgent.global).toBe(1);
    expect(serialized).not.toContain(privateTarget);
    expect(serialized).not.toContain(tempDir);
    expect(serialized).not.toContain("private-host.internal");
    expect(serialized).not.toContain("sk-private-stored-token");
    expect(serialized).not.toContain("sk-private-disk-token");
    expect(serialized).not.toContain(reference.content);
  });

  test("surfaces retired agent rows as metadata-only status", async () => {
    const db = getDatabase();
    createConfig({
      name: "Stale Gemini Global Rules",
      kind: "file",
      category: "rules",
      agent: "gemini" as ConfigAgent,
      target_path: "~/.gemini/GEMINI.md",
      format: "markdown",
      content: "stale retired content",
    }, db);

    const status = await getConfigsStatus(new LocalConfigStore(db));
    const serialized = JSON.stringify(status);

    expect(status.counts.configs.retiredAgentRows).toBe(1);
    expect(status.health.retiredAgentRows).toBe(1);
    expect(status.health.hasRetiredAgentRows).toBe(true);
    expect(status.health.status).toBe("warn");
    expect(status.health.missingTargets).toBe(0);
    expect(status.counts.knownTargets).toBe(0);
    expect(status.counts.byAgent.gemini).toBe(1);
    expect(serialized).not.toContain("~/.gemini/GEMINI.md");
    expect(serialized).not.toContain("stale retired content");
  });
});
