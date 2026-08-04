// Regression cover for todos 757cefdb: `instructions add <path> --kind reference`
// can NEVER find an existing row to update, at any `--update` setting, because
// the collision check that backs `--update` is target-path-only
// (findConfigsByTargetPath) and reference configs own no target_path by design
// (see config-target-identity.ts). Every re-ingest of a reference-kind config —
// the kind that carries global/managed operating-rules content, not a config
// mirrored 1:1 onto one file — therefore silently mints a new row instead of
// updating the one that already exists.
//
// Measured live 2026-08-04 by t42d493a5-driver (todos 757cefdb comment
// 47307cda): reproduced three ways on disposable rows, and confirmed the
// installed fleet store held 20 reference-kind configs with target_path=null
// on 20/20. Re-confirmed independently here via `instructions list --json`
// against the same live store before writing this test: 163 total configs,
// kind counts {file: 143, reference: 20}, and target_path null on all 20
// reference rows and non-null on all 143 file rows — the same shape, on a
// fresh read, is what makes this a load-bearing regression rather than a
// one-off.
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
      HASNA_INSTRUCTIONS_API_URL: undefined,
      HASNA_INSTRUCTIONS_API_KEY: undefined,
      ...env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function isolatedEnv(root: string) {
  return { HASNA_INSTRUCTIONS_DB_PATH: join(root, "db.sqlite"), CONFIGS_HOME: root };
}

function referenceRowsNamed(root: string, name: string): Array<{ slug: string; content: string; version: number }> {
  const listed = runCli(["list", "--json"], isolatedEnv(root));
  expect(listed.status).toBe(0);
  const all = JSON.parse(listed.stdout) as Array<{ slug: string; name: string; kind: string; content: string; version: number }>;
  return all.filter((c) => c.kind === "reference" && c.name === name).map(({ slug, content, version }) => ({ slug, content, version }));
}

describe("instructions add --kind reference — one name, one row", () => {
  test("refuses a second reference add for a name a config already owns, and names that config", () => {
    const root = makeTempRoot("configs-add-ref-dup-");
    const source = join(root, "rule.md");
    writeFileSync(source, "alpha\n");

    const first = runCli(["add", source, "--name", "sample-rule", "--kind", "reference"], isolatedEnv(root));
    expect(first.status).toBe(0);
    expect(referenceRowsNamed(root, "sample-rule").length).toBe(1);

    const second = runCli(["add", source, "--name", "sample-rule", "--kind", "reference"], isolatedEnv(root));

    // It must refuse rather than mint a twin — the same contract `add` already
    // gives file-kind configs on a colliding target_path.
    expect(second.status).not.toBe(0);
    expect(`${second.stdout}${second.stderr}`).toContain("sample-rule");
    const rows = referenceRowsNamed(root, "sample-rule");
    expect(rows.length).toBe(1);
  });

  test("--update refreshes the existing reference row in place instead of adding one", () => {
    const root = makeTempRoot("configs-add-ref-update-");
    const source = join(root, "rule.md");
    writeFileSync(source, "alpha\n");
    expect(runCli(["add", source, "--name", "sample-rule", "--kind", "reference"], isolatedEnv(root)).status).toBe(0);

    writeFileSync(source, "alpha\nbeta\n");
    const updated = runCli(["add", source, "--name", "sample-rule", "--kind", "reference", "--update"], isolatedEnv(root));

    expect(updated.status).toBe(0);
    const rows = referenceRowsNamed(root, "sample-rule");
    // The failure mode this guards: before the fix, this array has length 2
    // (a fresh "sample-rule-1" twin) instead of one updated row.
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe("alpha\nbeta\n");
    expect(rows[0]!.version).toBe(2);
  });

  test("--update on a reference row preserves the prior content as a snapshot", () => {
    const root = makeTempRoot("configs-add-ref-snapshot-");
    const source = join(root, "rule.md");
    writeFileSync(source, "v1 content\n");
    expect(runCli(["add", source, "--name", "sample-rule", "--kind", "reference"], isolatedEnv(root)).status).toBe(0);

    writeFileSync(source, "v2 content\n");
    expect(runCli(["add", source, "--name", "sample-rule", "--kind", "reference", "--update"], isolatedEnv(root)).status).toBe(0);

    const rows = referenceRowsNamed(root, "sample-rule");
    expect(rows.length).toBe(1);

    // `snapshot list` has no --json output; it prints "  v<N> <created_at> <id>"
    // per row (src/cli/index.tsx, snapshotCmd "list <config>"). Parse that
    // contract directly rather than inventing a flag that does not exist.
    const listed = runCli(["snapshot", "list", rows[0]!.slug], isolatedEnv(root));
    expect(listed.status).toBe(0);
    const v1Line = listed.stdout.split("\n").find((line) => /^\s*v1\s/.test(line));
    expect(v1Line).toBeDefined();
    const v1Id = v1Line!.trim().split(/\s+/)[2];
    expect(v1Id).toBeTruthy();

    const shown = runCli(["snapshot", "show", v1Id!], isolatedEnv(root));
    expect(shown.status).toBe(0);
    expect(shown.stdout.trimEnd()).toBe("v1 content");
  });

  test("still adds a genuinely new reference — the guard is per-name, not a blanket refusal", () => {
    const root = makeTempRoot("configs-add-ref-distinct-");
    const first = join(root, "one.md");
    const second = join(root, "two.md");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");

    expect(runCli(["add", first, "--name", "rule-one", "--kind", "reference"], isolatedEnv(root)).status).toBe(0);
    const added = runCli(["add", second, "--name", "rule-two", "--kind", "reference"], isolatedEnv(root));

    expect(added.status).toBe(0);
    expect(referenceRowsNamed(root, "rule-one").length).toBe(1);
    expect(referenceRowsNamed(root, "rule-two").length).toBe(1);
  });

  test("file-kind add/--update behavior is unchanged by this fix", () => {
    const root = makeTempRoot("configs-add-file-unaffected-");
    const target = join(root, "sample.md");
    writeFileSync(target, "alpha\n");
    expect(runCli(["add", target, "--name", "sample.md"], isolatedEnv(root)).status).toBe(0);

    const dup = runCli(["add", target, "--name", "sample.md"], isolatedEnv(root));
    expect(dup.status).not.toBe(0);

    writeFileSync(target, "alpha\nbeta\n");
    const updated = runCli(["add", target, "--name", "sample.md", "--update"], isolatedEnv(root));
    expect(updated.status).toBe(0);
  });
});
