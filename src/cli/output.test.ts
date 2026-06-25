import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];

function runCli(args: string[], dbPath: string) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CONFIGS_DB_PATH: dbPath,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function seedConfigs(count: number): { home: string; dbPath: string } {
  const home = mkdtempSync(join(tmpdir(), "open-configs-output-cli-"));
  tempDirs.push(home);
  const dbPath = join(home, "configs.db");
  process.env["CONFIGS_DB_PATH"] = dbPath;
  resetDatabase();
  const db = getDatabase();
  for (let i = 1; i <= count; i++) {
    createConfig({
      name: `Very Long Agent Config ${String(i).padStart(2, "0")}`,
      category: i % 2 === 0 ? "agent" : "rules",
      agent: i % 3 === 0 ? "codex" : "claude",
      kind: "file",
      target_path: `~/.config/very/deep/path/that/keeps/going/agent-${i}/settings-with-a-long-name.json`,
      format: "json",
      content: JSON.stringify({ value: "x".repeat(400) }),
      description: "This description is intentionally long and repetitive so the default output would be noisy.",
      tags: ["long", "sample", `item-${i}`],
      outputs: [{ agent: "codewith", target_path: `~/.codewith/generated/agent-${i}/CODEWITH.md`, transform: "codex-flat" }],
    }, db);
  }
  resetDatabase();
  delete process.env["CONFIGS_DB_PATH"];
  return { home, dbPath };
}

afterEach(() => {
  resetDatabase();
  delete process.env["CONFIGS_DB_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("configs list output", () => {
  test("defaults to compact paged output", () => {
    const { dbPath } = seedConfigs(25);
    const result = runCli(["list"], dbPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Showing 20 of 25");
    expect(result.stdout).toContain("Next: configs list --cursor 20 --limit 20");
    expect(result.stdout).toContain("configs show <slug>");
    expect(result.stdout).not.toContain("intentionally long and repetitive");
    expect(result.stdout.split("\n").filter(Boolean).length).toBeLessThanOrEqual(25);
  });

  test("verbose output discloses expanded metadata only when requested", () => {
    const { dbPath } = seedConfigs(3);
    const result = runCli(["list", "--verbose", "--limit", "1"], dbPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Very Long Agent Config");
    expect(result.stdout).toContain("intentionally long and repetitive");
    expect(result.stdout).toContain("Showing 1 of 3");
  });

  test("json output remains full matching records", () => {
    const { dbPath } = seedConfigs(4);
    const result = runCli(["list", "--json"], dbPath);

    expect(result.status).toBe(0);
    const records = JSON.parse(result.stdout) as Array<{ content: string; outputs: unknown[] }>;
    expect(records).toHaveLength(4);
    expect(records[0]?.content).toContain("xxx");
    expect(records[0]?.outputs).toHaveLength(1);
  });
});
