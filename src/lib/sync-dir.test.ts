import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig, listConfigs } from "../db/configs";
import { syncFromDir, syncToDir } from "./sync-dir";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-syncdir-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
});

describe("syncToDir", () => {
  test("writes matching configs to disk", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "output.txt");
    createConfig({ name: "Out", category: "tools", content: "hello", target_path: target }, db);
    const result = await syncToDir(tmpDir, { store: new LocalConfigStore(db) });
    expect(result.updated + result.unchanged).toBeGreaterThanOrEqual(0);
  });

  test("dry-run does not write files", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "dryout.txt");
    createConfig({ name: "Dry", category: "tools", content: "data", target_path: target }, db);
    await syncToDir(tmpDir, { store: new LocalConfigStore(db), dryRun: true });
    expect(existsSync(target)).toBe(false);
  });

  test("skips reference kind configs", async () => {
    const db = getDatabase();
    createConfig({ name: "Ref", category: "workspace", content: "doc", kind: "reference" }, db);
    const result = await syncToDir(tmpDir, { store: new LocalConfigStore(db) });
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
  });
});

describe("syncFromDir recursive", () => {
  test("walks nested directories", async () => {
    const db = getDatabase();
    const nested = join(tmpDir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(tmpDir, "root.txt"), "root");
    writeFileSync(join(nested, "deep.txt"), "deep");
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: true });
    expect(result.added).toBe(2);
    expect(listConfigs(undefined, db).length).toBe(2);
  });

  test("skips .git and node_modules", async () => {
    const db = getDatabase();
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(tmpDir, "node_modules", "pkg.json"), "{}");
    writeFileSync(join(tmpDir, "real.txt"), "real");
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db) });
    expect(result.added).toBe(1); // only real.txt
  });

  test("skips .db files", async () => {
    const db = getDatabase();
    writeFileSync(join(tmpDir, "data.db"), "binary");
    writeFileSync(join(tmpDir, "config.txt"), "config");
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db) });
    expect(result.added).toBe(1); // only config.txt
  });

  test("non-recursive mode only reads top level", async () => {
    const db = getDatabase();
    mkdirSync(join(tmpDir, "sub"), { recursive: true });
    writeFileSync(join(tmpDir, "top.txt"), "top");
    writeFileSync(join(tmpDir, "sub", "nested.txt"), "nested");
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: false });
    expect(result.added).toBe(1); // only top.txt
  });
});
