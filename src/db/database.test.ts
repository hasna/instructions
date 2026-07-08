import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase, insertFeedback, uuid, now, slugify } from "./database";

let originalHome: string | undefined;
let tempHome: string | null = null;

beforeEach(() => {
  resetDatabase();
  originalHome = process.env["HOME"];
  process.env["CONFIGS_DB_PATH"] = ":memory:";
});

afterEach(() => {
  resetDatabase();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  delete process.env["HASNA_CONFIGS_DB_PATH"];
  delete process.env["CONFIGS_DB_PATH"];
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

function useTempHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "configs-home-"));
  process.env["HOME"] = tempHome;
  delete process.env["CONFIGS_DB_PATH"];
  delete process.env["HASNA_CONFIGS_DB_PATH"];
  return tempHome;
}

describe("database", () => {
  test("getDatabase returns a database instance", () => {
    const db = getDatabase();
    expect(db).toBeTruthy();
  });

  test("getDatabase returns same instance on second call", () => {
    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);
  });

  test("resetDatabase clears singleton", () => {
    const db1 = getDatabase();
    resetDatabase();
    process.env["CONFIGS_DB_PATH"] = ":memory:";
    const db2 = getDatabase();
    expect(db1).not.toBe(db2);
  });

  test("uuid generates unique IDs", () => {
    const id1 = uuid();
    const id2 = uuid();
    expect(id1).not.toBe(id2);
    expect(id1.length).toBeGreaterThan(10);
  });

  test("now returns ISO string", () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("slugify converts names to slugs", () => {
    expect(slugify("My Config File")).toBe("my-config-file");
    expect(slugify("hello_world 123")).toBe("hello-world-123");
    expect(slugify("  spaces  ")).toBe("spaces");
    expect(slugify("UPPER-case")).toBe("upper-case");
  });

  test("migrations create all tables", () => {
    const db = getDatabase();
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r) => r.name);
    expect(tables).toContain("configs");
    expect(tables).toContain("config_snapshots");
    expect(tables).toContain("profiles");
    expect(tables).toContain("profile_configs");
    expect(tables).toContain("machines");
    expect(tables).toContain("schema_version");
  });

  test("migrations add machine/profile platform columns", () => {
    const db = getDatabase();
    const profileColumns = db.query<{ name: string }, []>("PRAGMA table_info(profiles)").all().map((row) => row.name);
    const machineColumns = db.query<{ name: string }, []>("PRAGMA table_info(machines)").all().map((row) => row.name);
    expect(profileColumns).toContain("selectors");
    expect(profileColumns).toContain("variables");
    expect(machineColumns).toContain("arch");
  });

  test("migrations add config outputs column", () => {
    const db = getDatabase();
    const configColumns = db.query<{ name: string }, []>("PRAGMA table_info(configs)").all().map((row) => row.name);
    expect(configColumns).toContain("outputs");
  });

  test("migrates legacy ~/.open-configs into ~/.hasna/configs", () => {
    const home = useTempHome();
    mkdirSync(join(home, ".open-configs", "nested"), { recursive: true });
    writeFileSync(join(home, ".open-configs", "config.json"), "{\"ok\":true}");
    writeFileSync(join(home, ".open-configs", "nested", "profile.txt"), "profile");

    getDatabase();

    expect(readFileSync(join(home, ".hasna", "configs", "config.json"), "utf8")).toBe("{\"ok\":true}");
    expect(readFileSync(join(home, ".hasna", "configs", "nested", "profile.txt"), "utf8")).toBe("profile");
  });

  test("migrates legacy ~/.configs when ~/.open-configs is absent", () => {
    const home = useTempHome();
    mkdirSync(join(home, ".configs"), { recursive: true });
    writeFileSync(join(home, ".configs", "legacy.txt"), "legacy");

    getDatabase();

    expect(readFileSync(join(home, ".hasna", "configs", "legacy.txt"), "utf8")).toBe("legacy");
  });

  test("feedback insert works on a fresh database", () => {
    const db = getDatabase();
    expect(() => insertFeedback({ message: "hi", category: "bug", version: "9.9.9" }, db)).not.toThrow();
    const row = db.query<{ message: string; category: string }, []>(
      "SELECT message, category FROM feedback LIMIT 1",
    ).get();
    expect(row?.message).toBe("hi");
    expect(row?.category).toBe("bug");
  });

  test("ensureFeedbackTable backfills category on a legacy feedback table", () => {
    const home = useTempHome();
    const dbPath = join(home, "legacy.db");
    // Simulate a pre-existing store whose feedback table predates the
    // category/version columns (the exact shape that produced
    // "table feedback has no column named category").
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE feedback (id TEXT PRIMARY KEY, message TEXT NOT NULL, email TEXT)");
    legacy.close();

    process.env["CONFIGS_DB_PATH"] = dbPath;
    resetDatabase();
    const db = getDatabase(dbPath);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(feedback)").all().map((r) => r.name);
    expect(columns).toContain("category");
    expect(columns).toContain("version");
    expect(() => insertFeedback({ message: "legacy ok", category: "feature" }, db)).not.toThrow();
  });

  test("does not copy legacy data over an existing canonical directory", () => {
    const home = useTempHome();
    mkdirSync(join(home, ".open-configs"), { recursive: true });
    mkdirSync(join(home, ".hasna", "configs"), { recursive: true });
    writeFileSync(join(home, ".open-configs", "legacy.txt"), "legacy");
    writeFileSync(join(home, ".hasna", "configs", "current.txt"), "current");

    getDatabase();

    expect(readFileSync(join(home, ".hasna", "configs", "current.txt"), "utf8")).toBe("current");
    expect(existsSync(join(home, ".hasna", "configs", "legacy.txt"))).toBe(false);
  });
});
