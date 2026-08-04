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

  test("refuses a case/punctuation variant of a name a config already owns (todos 195272ae, Finding 1)", () => {
    const root = makeTempRoot("configs-add-ref-dup-case-");
    const source = join(root, "rule.md");
    writeFileSync(source, "alpha\n");

    const first = runCli(["add", source, "--name", "Sample Rule", "--kind", "reference"], isolatedEnv(root));
    expect(first.status).toBe(0);

    // A different exact string that slugifies to the same identity. Before
    // this fix, findReferenceConfigsByName's slug branch compared against the
    // EXISTING row's stored `.slug` column, which for a fresh, un-colliding
    // row equals slugify(its own name) — so this specific single-collision
    // shape actually already worked pre-fix. The defect this test guards is
    // the population immediately downstream of it: once this second add is
    // (correctly) refused, the store must still hold exactly one row, so a
    // LATER re-ingest under either spelling never has two same-identity rows
    // to go blind between (see the --update test below for what happens if
    // it does, e.g. via the MCP create_config path this file does not cover).
    const second = runCli(["add", source, "--name", "sample rule", "--kind", "reference"], isolatedEnv(root));

    expect(second.status).not.toBe(0);
    expect(referenceRowsNamed(root, "Sample Rule").length).toBe(1);
    expect(referenceRowsNamed(root, "sample rule").length).toBe(0);
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

  test("--update on a name colliding only after slugification warns about the sibling instead of staying silent (todos 195272ae, Finding 1)", () => {
    const root = makeTempRoot("configs-add-ref-case-collision-");

    // `add`'s own guard now refuses to create this pair through the CLI (this
    // fix also prevents the corruption at creation time, not only detects it
    // afterward — see the CLI-level `add` test above for the byte-identical
    // case). To exercise --update against a pair that ALREADY exists — e.g.
    // left over from before this fix shipped, or created via the MCP
    // create_config path, which still has no reference-kind guard at all
    // (see mcp/create-config-target-guard.test.ts) — seed both rows directly
    // at the DB layer, the same pattern doctor-reference-duplicates.test.ts
    // uses.
    const seed = spawnSync(
      "bun",
      [
        "-e",
        `
        import { createConfig } from "./src/db/configs.ts";
        createConfig({ name: "Sample Rule", category: "rules", content: "one\\n", kind: "reference" });
        createConfig({ name: "sample rule", category: "rules", content: "two\\n", kind: "reference" });
        `,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...isolatedEnv(root), HASNA_INSTRUCTIONS_API_URL: undefined, HASNA_INSTRUCTIONS_API_KEY: undefined } },
    );
    expect(seed.status).toBe(0);
    expect(referenceRowsNamed(root, "Sample Rule").length).toBe(1);
    expect(referenceRowsNamed(root, "sample rule").length).toBe(1);

    const source = join(root, "rule.md");
    writeFileSync(source, "three\n");
    const updated = runCli(["add", source, "--name", "Sample Rule", "--kind", "reference", "--update"], isolatedEnv(root));
    expect(updated.status).toBe(0);

    // Both rows must still exist — this is about visibility, not merging them.
    const exact = referenceRowsNamed(root, "Sample Rule");
    const sibling = referenceRowsNamed(root, "sample rule");
    expect(exact.length).toBe(1);
    expect(sibling.length).toBe(1);

    // Exactly one of the two now carries the new content; whichever the CLI
    // picked as the row to refresh, the OTHER must be reported, not silently
    // skipped. Before this fix `rest` was empty for this pair and neither the
    // "N other row(s) still share this name" warning nor any trace of the
    // sibling appeared anywhere in the command's output.
    const contents = [exact[0]!.content, sibling[0]!.content];
    expect(contents.filter((c) => c === "three\n").length).toBe(1);
    expect(contents.filter((c) => c === "one\n" || c === "two\n").length).toBe(1);
    expect(`${updated.stdout}${updated.stderr}`).toContain("other row(s) still share this name");
  });

  test("--update targets the EXACT name match, not the alphabetically-first colliding row (todos 195272ae, Finding 2)", () => {
    const root = makeTempRoot("configs-add-ref-update-exact-");

    // Same seeded pair as the test above, but this time the update is
    // requested by the LOWERCASE name. SQLite's default BINARY collation sorts
    // uppercase before lowercase ('S' = 0x53 < 's' = 0x73), so
    // `ORDER BY category, name` — what `listConfigs` actually runs — always
    // returns "Sample Rule" before "sample rule" for this pair, regardless of
    // which one the caller named. Before this fix, `add`'s `[target, ...rest]
    // = existingOwners` destructure took whichever row sorted first with no
    // preference for an exact `name` match, so asking to update "sample rule"
    // silently overwrote "Sample Rule" instead — the wrong row, with no error
    // and no indication in the "✓ Updated: <name>" line, which itself printed
    // the WRONG config's name.
    const seed = spawnSync(
      "bun",
      [
        "-e",
        `
        import { createConfig } from "./src/db/configs.ts";
        createConfig({ name: "Sample Rule", category: "rules", content: "one\\n", kind: "reference" });
        createConfig({ name: "sample rule", category: "rules", content: "two\\n", kind: "reference" });
        `,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...isolatedEnv(root), HASNA_INSTRUCTIONS_API_URL: undefined, HASNA_INSTRUCTIONS_API_KEY: undefined } },
    );
    expect(seed.status).toBe(0);
    expect(referenceRowsNamed(root, "Sample Rule").length).toBe(1);
    expect(referenceRowsNamed(root, "sample rule").length).toBe(1);

    const source = join(root, "rule.md");
    writeFileSync(source, "three\n");
    const updated = runCli(["add", source, "--name", "sample rule", "--kind", "reference", "--update"], isolatedEnv(root));
    expect(updated.status).toBe(0);

    const exact = referenceRowsNamed(root, "Sample Rule");
    const targeted = referenceRowsNamed(root, "sample rule");
    expect(exact.length).toBe(1);
    expect(targeted.length).toBe(1);

    // The row actually named "sample rule" must carry the new content — NOT
    // "Sample Rule", which the caller never named.
    expect(targeted[0]!.content).toBe("three\n");
    expect(exact[0]!.content).toBe("one\n");

    // The confirmation line must name the row that was actually touched.
    expect(`${updated.stdout}${updated.stderr}`).toContain("sample-rule-1");
    expect(`${updated.stdout}${updated.stderr}`).toContain("other row(s) still share this name");
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
