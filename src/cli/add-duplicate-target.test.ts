// Regression cover for todos 43d0c1c0 defect 1: `instructions add <path>` used to
// INSERT a second row for a target_path a config already owned, minting a
// `<slug>-1` twin. Two rows on one path means an apply races itself — last
// writer wins and nothing reports the conflict. Five such collisions (12 rows)
// were measured in the live fleet store on 2026-07-31.
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
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

function rowsForTarget(root: string, target: string): Array<{ slug: string; content: string }> {
  const listed = runCli(["list", "--json"], isolatedEnv(root));
  expect(listed.status).toBe(0);
  const all = JSON.parse(listed.stdout) as Array<{ slug: string; target_path: string | null; content: string }>;
  return all.filter((c) => c.target_path === target).map(({ slug, content }) => ({ slug, content }));
}

describe("instructions add — one target_path, one row", () => {
  test("refuses a second add for a path a config already owns, and names that config", () => {
    const root = makeTempRoot("configs-add-dup-");
    const target = join(root, "sample.md");
    writeFileSync(target, "alpha\n");

    const first = runCli(["add", target, "--name", "sample.md"], isolatedEnv(root));
    expect(first.status).toBe(0);
    expect(rowsForTarget(root, target).length).toBe(1);

    const second = runCli(["add", target, "--name", "sample.md"], isolatedEnv(root));

    // It must refuse rather than mint a twin...
    expect(second.status).not.toBe(0);
    // ...and name the config that already owns the path, so the operator can act on it.
    expect(`${second.stdout}${second.stderr}`).toContain("sample-md");
    // The store is unchanged: still exactly one row on this path, never a `-1` twin.
    const rows = rowsForTarget(root, target);
    expect(rows.length).toBe(1);
    expect(rows[0]!.slug).toBe("sample-md");
  });

  test("--update refreshes the existing row in place instead of adding one", () => {
    const root = makeTempRoot("configs-add-update-");
    const target = join(root, "sample.md");
    writeFileSync(target, "alpha\n");
    expect(runCli(["add", target, "--name", "sample.md"], isolatedEnv(root)).status).toBe(0);

    writeFileSync(target, "alpha\nbeta\n");
    const updated = runCli(["add", target, "--name", "sample.md", "--update"], isolatedEnv(root));

    expect(updated.status).toBe(0);
    const rows = rowsForTarget(root, target);
    expect(rows.length).toBe(1);
    expect(rows[0]!.slug).toBe("sample-md");
    expect(rows[0]!.content).toBe("alpha\nbeta\n");
  });

  test("still adds a genuinely new path — the guard is per-path, not a blanket refusal", () => {
    const root = makeTempRoot("configs-add-distinct-");
    const first = join(root, "one.md");
    const second = join(root, "two.md");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");

    expect(runCli(["add", first, "--name", "one.md"], isolatedEnv(root)).status).toBe(0);
    const added = runCli(["add", second, "--name", "two.md"], isolatedEnv(root));

    expect(added.status).toBe(0);
    expect(rowsForTarget(root, first).length).toBe(1);
    expect(rowsForTarget(root, second).length).toBe(1);
  });

  test("matches an existing '~'-stored row, so the twin cannot slip in via an absolute path", () => {
    const root = makeTempRoot("configs-add-tilde-");
    const nested = join(root, ".claude");
    const target = join(nested, "CLAUDE.md");
    require("node:fs").mkdirSync(nested, { recursive: true });
    writeFileSync(target, "rules\n");

    // Seed a row stored in `~` form, which is how `sync` writes target paths.
    const seed = runCli(["add", target, "--name", "CLAUDE.md"], isolatedEnv(root));
    expect(seed.status).toBe(0);

    const again = runCli(["add", target, "--name", "CLAUDE.md"], isolatedEnv(root));
    expect(again.status).not.toBe(0);

    const listed = runCli(["list", "--json"], isolatedEnv(root));
    const all = JSON.parse(listed.stdout) as Array<{ target_path: string | null }>;
    const owning = all.filter((c) => c.target_path && /CLAUDE\.md$/.test(c.target_path));
    expect(owning.length).toBe(1);
  });
});

describe("instructions add — the file it read is the file it stores", () => {
  test("stores the disk bytes for a fresh path", () => {
    const root = makeTempRoot("configs-add-bytes-");
    const target = join(root, "sample.md");
    writeFileSync(target, "alpha\nbeta\n");
    expect(runCli(["add", target, "--name", "sample.md"], isolatedEnv(root)).status).toBe(0);
    expect(rowsForTarget(root, target)[0]!.content).toBe(readFileSync(target, "utf-8"));
  });
});
