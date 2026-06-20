import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase, uuid, now, slugify } from "./database";

beforeEach(() => {
  resetDatabase();
  process.env["CONFIGS_DB_PATH"] = ":memory:";
});

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
});
