import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase, insertFeedback, uuid, now, slugify } from "./database";
import { makeTempRoot } from "../lib/test-temp-root";

let originalHome: string | undefined;
let tempHome: string | null = null;

beforeEach(() => {
  resetDatabase();
  originalHome = process.env["HOME"];
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
});

afterEach(() => {
  resetDatabase();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

function useTempHome(): string {
  tempHome = makeTempRoot("configs-home-");
  process.env["HOME"] = tempHome;
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
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
    process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
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

  test("migration reconciles duplicate targets to the config with the richest history", () => {
    const home = useTempHome();
    const dbPath = join(home, "duplicate-targets.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'file',
        category TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'global',
        target_path TEXT,
        outputs TEXT NOT NULL DEFAULT '[]',
        format TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL DEFAULT '',
        description TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        is_template INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT
      );
      CREATE TABLE config_snapshots (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        selectors TEXT NOT NULL DEFAULT '{}',
        variables TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE profile_configs (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, config_id)
      );
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL UNIQUE,
        os TEXT,
        arch TEXT,
        last_applied_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (3);

      INSERT INTO configs
        (id, name, slug, category, target_path, content, version, created_at, updated_at)
      VALUES
        ('rich', 'Rich history', 'rich', 'rules', '~/.claude/CLAUDE.md', 'rich-current', 3, '2026-01-01', '2026-01-03'),
        ('high-version', 'High version', 'high-version', 'rules', '~/.claude/CLAUDE.md', 'newer-current', 99, '2026-01-02', '2026-01-04'),
        ('one-snapshot', 'One snapshot', 'one-snapshot', 'rules', '~/.claude/CLAUDE.md', 'other-current', 4, '2026-01-03', '2026-01-05');
      INSERT INTO config_snapshots (id, config_id, content, version, created_at) VALUES
        ('rich-s1', 'rich', 'rich-v1', 1, '2026-01-01'),
        ('rich-s2', 'rich', 'rich-v2', 2, '2026-01-02'),
        ('other-s1', 'one-snapshot', 'other-v1', 1, '2026-01-03');
      INSERT INTO profiles (id, name, slug, created_at, updated_at) VALUES
        ('profile-loser', 'Loser only', 'loser-only', '2026-01-01', '2026-01-01'),
        ('profile-both', 'Both', 'both', '2026-01-01', '2026-01-01');
      INSERT INTO profile_configs (profile_id, config_id, sort_order) VALUES
        ('profile-loser', 'high-version', 4),
        ('profile-both', 'rich', 8),
        ('profile-both', 'one-snapshot', 2);
    `);
    legacy.close();

    resetDatabase();
    const migrated = getDatabase(dbPath);
    const configs = migrated.query<{ id: string; content: string }, []>(
      "SELECT id, content FROM configs",
    ).all();
    expect(configs).toEqual([{ id: "rich", content: "rich-current" }]);
    expect(migrated.query<{ config_id: string }, []>(
      "SELECT DISTINCT config_id FROM config_snapshots",
    ).all()).toEqual([{ config_id: "rich" }]);
    expect(migrated.query<{ profile_id: string; config_id: string; sort_order: number }, []>(
      "SELECT profile_id, config_id, sort_order FROM profile_configs ORDER BY profile_id",
    ).all()).toEqual([
      { profile_id: "profile-both", config_id: "rich", sort_order: 2 },
      { profile_id: "profile-loser", config_id: "rich", sort_order: 4 },
    ]);
    expect(migrated.query<{ version: number }, []>(
      "SELECT MAX(version) AS version FROM schema_version",
    ).get()?.version).toBe(4);
    expect(() => createConfig({
      name: "Still duplicate",
      category: "rules",
      content: "",
      target_path: "~/.claude/CLAUDE.md",
    }, migrated)).toThrow();

    expect(() => createConfig({ name: "Reference one", category: "workspace", content: "", target_path: null }, migrated)).not.toThrow();
    expect(() => createConfig({ name: "Reference two", category: "workspace", content: "", target_path: null }, migrated)).not.toThrow();
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

    process.env["HASNA_INSTRUCTIONS_DB_PATH"] = dbPath;
    resetDatabase();
    const db = getDatabase(dbPath);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(feedback)").all().map((r) => r.name);
    expect(columns).toContain("category");
    expect(columns).toContain("version");
    expect(() => insertFeedback({ message: "legacy ok", category: "feature" }, db)).not.toThrow();
  });
});
