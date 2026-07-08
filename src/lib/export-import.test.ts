import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig, listConfigs } from "../db/configs";
import { exportConfigs } from "./export";
import { importConfigs } from "./import";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-export-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
});

describe("export + import roundtrip", () => {
  test("exports configs to tar.gz and imports them back", async () => {
    const db = getDatabase();
    createConfig({ name: "test-export", category: "rules", content: "# Hello", agent: "claude", format: "markdown" }, db);
    createConfig({ name: "test-tools", category: "tools", content: "data", agent: "npm" }, db);

    const outPath = join(tmpDir, "test-export.tar.gz");
    const exportResult = await exportConfigs(outPath, { store: new LocalConfigStore(db) });
    expect(exportResult.count).toBe(2);
    expect(existsSync(outPath)).toBe(true);

    // Import into fresh DB
    resetDatabase();
    process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
    const db2 = getDatabase();
    const importResult = await importConfigs(outPath, { store: new LocalConfigStore(db2) });
    expect(importResult.created).toBe(2);
    expect(importResult.errors.length).toBe(0);

    const configs = listConfigs(undefined, db2);
    expect(configs.length).toBe(2);
  });

  test("import with skip conflict mode skips existing", async () => {
    const db = getDatabase();
    createConfig({ name: "existing", category: "rules", content: "original" }, db);

    const outPath = join(tmpDir, "conflict-test.tar.gz");
    await exportConfigs(outPath, { store: new LocalConfigStore(db) });

    const importResult = await importConfigs(outPath, { store: new LocalConfigStore(db), conflict: "skip" });
    expect(importResult.skipped).toBe(1);
    expect(importResult.created).toBe(0);
  });

  test("import with overwrite conflict mode updates existing", async () => {
    const db = getDatabase();
    const c = createConfig({ name: "overwrite-me", category: "rules", content: "v1" }, db);

    const outPath = join(tmpDir, "overwrite-test.tar.gz");
    await exportConfigs(outPath, { store: new LocalConfigStore(db) });

    // Modify the config
    const { updateConfig } = await import("../db/configs");
    updateConfig(c.id, { content: "v2-modified" }, db);

    // Import with overwrite — should restore to v1
    const importResult = await importConfigs(outPath, { store: new LocalConfigStore(db), conflict: "overwrite" });
    expect(importResult.updated).toBe(1);
  });
});
