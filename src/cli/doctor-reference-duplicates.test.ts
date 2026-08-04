// CLI-level cover for the `instructions doctor` check added alongside todos
// 757cefdb: a reference-kind config's identity is its name, not a target_path
// (it has none — see config-target-identity.ts). Before that fix, `add <path>
// --kind reference --update` had no way to find an existing row, so every
// re-ingest minted a duplicate. This checks that `doctor` surfaces any such
// duplicates that already exist, the same way it already surfaces duplicate
// target-path rows.
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { makeTempRoot } from "../lib/test-temp-root";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      // Isolation is the point of this file: an ambient cloud-mode credential
      // silently overrides HASNA_INSTRUCTIONS_DB_PATH below and every write
      // this test makes would land in the shared fleet store instead of the
      // temp sqlite file. Clearing all three here, not just the DB path, is
      // load-bearing — confirmed the hard way while writing this fix, on the
      // live store, and cleaned up immediately (todos 757cefdb).
      HASNA_INSTRUCTIONS_API_URL: undefined,
      HASNA_INSTRUCTIONS_API_KEY: undefined,
      HASNA_INSTRUCTIONS_STORAGE_MODE: undefined,
      ...env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function isolatedEnv(root: string) {
  return { HASNA_INSTRUCTIONS_DB_PATH: join(root, "db.sqlite"), CONFIGS_HOME: root };
}

describe("instructions doctor — reference-name duplicates", () => {
  test("passes clean when no reference name is claimed by more than one row", () => {
    const root = makeTempRoot("doctor-ref-clean-");
    const source = join(root, "rule.md");
    writeFileSync(source, "alpha\n");
    expect(runCli(["add", source, "--name", "solo-rule", "--kind", "reference"], isolatedEnv(root)).status).toBe(0);

    const doctor = runCli(["doctor"], isolatedEnv(root));
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("No reference config name is claimed by more than one row");
  });

  test("reports a pre-existing duplicate by name, id, and updated_at", () => {
    const root = makeTempRoot("doctor-ref-dup-");

    // `add`'s own guard now refuses to create this duplicate through the CLI —
    // that is the fix. So to test `doctor`'s detection of a duplicate that
    // ALREADY exists (e.g. left over from before this fix shipped), seed one
    // directly at the DB layer, the same way the unit tests in
    // config-target-identity.test.ts do, but out-of-process against the same
    // isolated sqlite file `doctor` will then read.
    const seed = spawnSync(
      "bun",
      [
        "-e",
        `
        import { createConfig } from "./src/db/configs.ts";
        createConfig({ name: "Twin Rule", category: "rules", content: "one", kind: "reference" });
        createConfig({ name: "Twin Rule", category: "rules", content: "two", kind: "reference" });
        `,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...isolatedEnv(root), HASNA_INSTRUCTIONS_API_URL: undefined, HASNA_INSTRUCTIONS_API_KEY: undefined, HASNA_INSTRUCTIONS_STORAGE_MODE: undefined } },
    );
    expect(seed.status).toBe(0);

    const doctor = runCli(["doctor"], isolatedEnv(root));
    // `doctor` never fails the process on findings (see the existing
    // duplicate-target-path check it mirrors) — it reports and continues.
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("reference name(s) claimed by more than one row");
    expect(doctor.stdout).toContain("Twin Rule");
  });
});
