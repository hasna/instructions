import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { applyConfigs } from "./apply";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-batch-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
});

describe("applyConfigs (batch)", () => {
  test("applies multiple configs to disk", async () => {
    const db = getDatabase();
    const c1 = createConfig({ name: "A", category: "tools", content: "aaa", target_path: join(tmpDir, "a.txt") }, db);
    const c2 = createConfig({ name: "B", category: "tools", content: "bbb", target_path: join(tmpDir, "b.txt") }, db);
    const results = await applyConfigs([c1, c2], { store: new LocalConfigStore(db) });
    expect(results.length).toBe(2);
    expect(readFileSync(join(tmpDir, "a.txt"), "utf-8")).toBe("aaa");
    expect(readFileSync(join(tmpDir, "b.txt"), "utf-8")).toBe("bbb");
  });

  test("skips reference kind configs", async () => {
    const db = getDatabase();
    const file = createConfig({ name: "File", category: "tools", content: "data", target_path: join(tmpDir, "f.txt") }, db);
    const ref = createConfig({ name: "Ref", category: "workspace", content: "doc", kind: "reference" }, db);
    const results = await applyConfigs([file, ref], { store: new LocalConfigStore(db) });
    expect(results.length).toBe(1); // only file applied
    expect(results[0]!.config_id).toBe(file.id);
  });

  test("dry-run returns results without writing", async () => {
    const db = getDatabase();
    const c = createConfig({ name: "Dry", category: "tools", content: "test", target_path: join(tmpDir, "dry.txt") }, db);
    const results = await applyConfigs([c], { dryRun: true, store: new LocalConfigStore(db) });
    expect(results.length).toBe(1);
    expect(results[0]!.dry_run).toBe(true);
    expect(existsSync(join(tmpDir, "dry.txt"))).toBe(false);
  });

  test("handles empty array", async () => {
    const results = await applyConfigs([]);
    expect(results.length).toBe(0);
  });
});
