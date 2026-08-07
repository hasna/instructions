import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempRoot } from "../lib/test-temp-root";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], root: string) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HASNA_INSTRUCTIONS_DB_PATH: join(root, "instructions.db"),
      HASNA_INSTRUCTIONS_API_URL: "",
      HASNA_INSTRUCTIONS_API_KEY: "",
      CONFIGS_HOME: root,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function listProfiles(root: string) {
  const result = runCli(["profile", "list", "--json"], root);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Array<{
    id: string;
    slug: string;
    variables: Record<string, string>;
  }>;
}

describe("instructions profile update", () => {
  test("atomically sets and unsets variables on an existing profile", () => {
    const root = makeTempRoot("instructions-profile-update-");
    try {
      const created = runCli([
        "profile",
        "create",
        "migration-target",
        "--var",
        "PROJECT_CHANNEL_PREFIX=iproj-",
        "REMOVE_ME=legacy",
        "KEEP_ME=before",
      ], root);
      expect(created.status).toBe(0);

      const before = listProfiles(root);
      const existing = before.find((profile) => profile.slug === "migration-target")!;

      const updated = runCli([
        "profile",
        "update",
        existing.slug,
        "--var",
        "PROJECT_CHANNEL_PREFIX=",
        "SET_ME=after",
        "--unset-var",
        "REMOVE_ME",
      ], root);

      expect(updated.status).toBe(0);
      expect(updated.stdout).toContain("Updated profile");

      const after = listProfiles(root);
      const profile = after.find((candidate) => candidate.id === existing.id)!;
      expect(profile.variables).toEqual({
        PROJECT_CHANNEL_PREFIX: "",
        KEEP_ME: "before",
        SET_ME: "after",
      });
      expect(after).toHaveLength(1);
    } finally {
      Bun.spawnSync(["rm", "-rf", root]);
    }
  });

  test("rejects setting and unsetting the same variable together", () => {
    const root = makeTempRoot("instructions-profile-update-conflict-");
    try {
      const created = runCli(["profile", "create", "conflict-target", "--var", "VALUE=before"], root);
      expect(created.status).toBe(0);

      const rejected = runCli([
        "profile",
        "update",
        "conflict-target",
        "--var",
        "VALUE=after",
        "--unset-var",
        "VALUE",
      ], root);

      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain("both set and unset");
      expect(listProfiles(root)[0]!.variables).toEqual({ VALUE: "before" });
    } finally {
      Bun.spawnSync(["rm", "-rf", root]);
    }
  });
});
