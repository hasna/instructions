import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { findConfigsByTargetPath, findReferenceConfigsByName, findDuplicateReferenceNameGroups } from "./config-target-identity";
import { tempRootPath } from "./test-temp-root";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = tempRootPath(`configs-target-identity-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("findConfigsByTargetPath", () => {
  test("finds the row that already owns a target path", () => {
    const db = getDatabase();
    const target = join(tmpDir, "sample.md");
    writeFileSync(target, "body\n");
    const existing = createConfig({ name: "sample.md", category: "tools", content: "body\n", target_path: target }, db);

    const found = findConfigsByTargetPath([existing], target);

    expect(found.map((c) => c.id)).toEqual([existing.id]);
  });

  test("matches a '~' stored path against the expanded path for the same file", () => {
    process.env["CONFIGS_HOME"] = tmpDir;
    const db = getDatabase();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "body\n");
    const existing = createConfig(
      { name: "CLAUDE.md", category: "rules", content: "body\n", target_path: "~/.claude/CLAUDE.md" },
      db,
    );

    // The same file, named absolutely — as `add <path>` would resolve it.
    const found = findConfigsByTargetPath([existing], join(tmpDir, ".claude", "CLAUDE.md"));

    expect(found.map((c) => c.id)).toEqual([existing.id]);
  });

  test("does not match a different file", () => {
    const db = getDatabase();
    const existing = createConfig(
      { name: "a.md", category: "tools", content: "a\n", target_path: join(tmpDir, "a.md") },
      db,
    );

    expect(findConfigsByTargetPath([existing], join(tmpDir, "b.md"))).toEqual([]);
  });

  test("ignores reference configs, which own no target path", () => {
    const db = getDatabase();
    const ref = createConfig({ name: "Ref", category: "workspace", content: "doc", kind: "reference" }, db);

    expect(findConfigsByTargetPath([ref], join(tmpDir, "anything.md"))).toEqual([]);
  });

  test("reports EVERY row on a colliding target path, not just the first", () => {
    const db = getDatabase();
    const target = join(tmpDir, "collision.md");
    const first = createConfig({ name: "collision.md", category: "tools", content: "one\n", target_path: target }, db);
    const second = createConfig({ name: "collision.md", category: "tools", content: "two\n", target_path: target }, db);

    const found = findConfigsByTargetPath([first, second], target);

    expect(found.length).toBe(2);
    expect(new Set(found.map((c) => c.id))).toEqual(new Set([first.id, second.id]));
  });
});

describe("findReferenceConfigsByName", () => {
  test("finds the reference row that already owns a name", () => {
    const db = getDatabase();
    const existing = createConfig({ name: "sample-rule", category: "rules", content: "doc", kind: "reference" }, db);

    const found = findReferenceConfigsByName([existing], "sample-rule");

    expect(found.map((c) => c.id)).toEqual([existing.id]);
  });

  test("matches on slug, so case/punctuation differences in --name still resolve to the same row", () => {
    const db = getDatabase();
    const existing = createConfig({ name: "Sample Rule", category: "rules", content: "doc", kind: "reference" }, db);

    // uniqueSlug(slugify) turns "Sample Rule" into "sample-rule" at creation;
    // a later re-ingest that types the name slightly differently but produces
    // the same slug must still resolve to this row.
    const found = findReferenceConfigsByName([existing], "sample rule");

    expect(found.map((c) => c.id)).toEqual([existing.id]);
  });

  test("does not match a different name", () => {
    const db = getDatabase();
    const existing = createConfig({ name: "sample-rule", category: "rules", content: "doc", kind: "reference" }, db);

    expect(findReferenceConfigsByName([existing], "other-rule")).toEqual([]);
  });

  test("ignores file configs, which are identified by target_path, not name", () => {
    const db = getDatabase();
    const target = join(tmpDir, "sample-rule.md");
    writeFileSync(target, "body\n");
    const file = createConfig({ name: "sample-rule", category: "tools", content: "body\n", target_path: target }, db);

    // Same name a reference config might use, but this row is file-kind —
    // its identity is target_path, so a reference-name lookup must not match it.
    expect(findReferenceConfigsByName([file], "sample-rule")).toEqual([]);
  });

  test("reports EVERY row on a colliding name, not just the first", () => {
    const db = getDatabase();
    // Same `name` twice: uniqueSlug (db/database.ts) de-duplicates the SLUG
    // column only, so this reproduces exactly what the pre-fix bug already
    // left behind live (measured 2026-08-04: 8 rows named "Global Agent Rules
    // Standard", slugs suffixed -1..-8, one identical content hash across all
    // 8) — two rows, same name, different slugs.
    const first = createConfig({ name: "collision-rule", category: "rules", content: "one", kind: "reference" }, db);
    const second = createConfig({ name: "collision-rule", category: "rules", content: "two", kind: "reference" }, db);
    expect(first.slug).not.toBe(second.slug);

    const found = findReferenceConfigsByName([first, second], "collision-rule");

    expect(found.length).toBe(2);
    expect(new Set(found.map((c) => c.id))).toEqual(new Set([first.id, second.id]));
  });
});

describe("findDuplicateReferenceNameGroups", () => {
  test("reports a name shared by more than one reference row", () => {
    const db = getDatabase();
    const first = createConfig({ name: "Shared Name", category: "rules", content: "one", kind: "reference" }, db);
    const second = createConfig({ name: "Shared Name", category: "rules", content: "two", kind: "reference" }, db);

    const groups = findDuplicateReferenceNameGroups([first, second]);

    expect(groups.length).toBe(1);
    expect(groups[0]!.name).toBe("Shared Name");
    expect(new Set(groups[0]!.configs.map((c) => c.id))).toEqual(new Set([first.id, second.id]));
  });

  test("an empty result means the store is clean — no false positive on distinct names", () => {
    const db = getDatabase();
    const first = createConfig({ name: "Rule One", category: "rules", content: "one", kind: "reference" }, db);
    const second = createConfig({ name: "Rule Two", category: "rules", content: "two", kind: "reference" }, db);

    expect(findDuplicateReferenceNameGroups([first, second])).toEqual([]);
  });

  test("ignores file-kind configs even if their name collides with a reference config's", () => {
    const db = getDatabase();
    const target = join(tmpDir, "shared.md");
    writeFileSync(target, "body\n");
    const file = createConfig({ name: "Shared Name", category: "tools", content: "body\n", target_path: target }, db);
    const ref = createConfig({ name: "Shared Name", category: "rules", content: "doc", kind: "reference" }, db);

    // Only one reference row named "Shared Name" — the file-kind row is a
    // different identity axis entirely and must not count toward this group.
    expect(findDuplicateReferenceNameGroups([file, ref])).toEqual([]);
  });
});
