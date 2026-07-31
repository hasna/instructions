import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { findConfigsByTargetPath } from "./config-target-identity";
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
