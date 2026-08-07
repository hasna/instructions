import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { addConfigToProfile, createProfile } from "../db/profiles";
import { makeTempRoot } from "../lib/test-temp-root";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];

function runCli(args: string[], dbPath: string) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HASNA_INSTRUCTIONS_DB_PATH: dbPath,
      HASNA_INSTRUCTIONS_API_URL: "",
      HASNA_INSTRUCTIONS_API_KEY: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function seedProfileReads(): { dbPath: string; targetSlug: string } {
  const root = makeTempRoot("instructions-profile-reads-");
  tempDirs.push(root);
  const dbPath = join(root, "instructions.db");
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = dbPath;
  process.env["HASNA_INSTRUCTIONS_API_URL"] = "";
  process.env["HASNA_INSTRUCTIONS_API_KEY"] = "";
  resetDatabase();
  const db = getDatabase();

  for (let i = 1; i <= 5; i++) {
    createProfile({
      name: `Profile ${String(i).padStart(2, "0")}`,
      selectors: { hostnames: [`other-${i}`] },
    }, db);
  }
  const target = createProfile({
    name: "Z Target",
    selectors: { hostnames: ["station02"], os: ["linux"], arch: ["x64"] },
  }, db);
  for (let i = 1; i <= 5; i++) {
    const config = createConfig({
      name: `Config ${String(i).padStart(2, "0")}`,
      category: "rules",
      content: `rule ${i}`,
    }, db);
    addConfigToProfile(target.id, config.id, db);
  }

  resetDatabase();
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  return { dbPath, targetSlug: target.slug };
}

afterEach(() => {
  resetDatabase();
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bounded profile reads", () => {
  test("profile list JSON exposes bounded pages and an authoritative terminal page", () => {
    const { dbPath } = seedProfileReads();
    const first = runCli(["profile", "list", "--json", "--limit", "2"], dbPath);

    expect(first.status).toBe(0);
    const firstPage = JSON.parse(first.stdout) as {
      items: unknown[];
      total: number;
      limit: number;
      cursor: number;
      next_cursor: number | null;
      has_more: boolean;
      complete: boolean;
      truncated: boolean;
    };
    expect(firstPage).toMatchObject({
      total: 6,
      limit: 2,
      cursor: 0,
      next_cursor: 2,
      has_more: true,
      complete: false,
      truncated: false,
    });
    expect(firstPage.items).toHaveLength(2);

    const terminal = runCli(["profile", "list", "--json", "--limit", "2", "--cursor", "4"], dbPath);
    expect(terminal.status).toBe(0);
    expect(JSON.parse(terminal.stdout)).toMatchObject({
      total: 6,
      cursor: 4,
      next_cursor: null,
      has_more: false,
      complete: true,
      truncated: false,
    });
  });

  test("profile show JSON returns a producer-bounded membership page", () => {
    const { dbPath, targetSlug } = seedProfileReads();
    const result = runCli(["profile", "show", targetSlug, "--json", "--limit", "2", "--cursor", "4"], dbPath);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      profile: { slug: string };
      configs: {
        items: Array<{ slug: string }>;
        total: number;
        limit: number;
        cursor: number;
        complete: boolean;
        truncated: boolean;
      };
    };
    expect(payload.profile.slug).toBe(targetSlug);
    expect(payload.configs).toMatchObject({
      total: 5,
      limit: 2,
      cursor: 4,
      complete: true,
      truncated: false,
    });
    expect(payload.configs.items.map((config) => config.slug)).toEqual(["config-05"]);
  });

  test("profile resolve JSON scans the complete source in bounded batches", () => {
    const { dbPath, targetSlug } = seedProfileReads();
    const result = runCli([
      "profile",
      "resolve",
      "--json",
      "--limit",
      "2",
      "--hostname",
      "station02",
      "--os",
      "linux",
      "--arch",
      "x64",
    ], dbPath);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      profile: { slug: string };
      scanned: number;
      total: number;
      batch_limit: number;
      complete: boolean;
      truncated: boolean;
    };
    expect(payload).toMatchObject({
      scanned: 6,
      total: 6,
      batch_limit: 2,
      complete: true,
      truncated: false,
    });
    expect(payload.profile.slug).toBe(targetSlug);
  });
});
