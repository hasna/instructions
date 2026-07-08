import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function getDbPath(): string {
  if (process.env["HASNA_CONFIGS_DB_PATH"]) {
    return process.env["HASNA_CONFIGS_DB_PATH"];
  }
  if (process.env["CONFIGS_DB_PATH"]) {
    return process.env["CONFIGS_DB_PATH"]; // backward compat
  }
  migrateDotfile();
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const dir = join(home, ".hasna", "configs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "configs.db");
}

export function uuid(): string {
  return randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'file',
    category TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'global',
    target_path TEXT,
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

  CREATE TABLE IF NOT EXISTS config_snapshots (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_configs (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, config_id)
  );

  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL UNIQUE,
    os TEXT,
    last_applied_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  INSERT OR IGNORE INTO schema_version (version) VALUES (1);
  `,
  `
  ALTER TABLE profiles ADD COLUMN selectors TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE profiles ADD COLUMN variables TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE machines ADD COLUMN arch TEXT;
  `,
  `
  ALTER TABLE configs ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]';
  `,
];

let _db: Database | null = null;

export function getDatabase(path?: string): Database {
  if (_db) return _db;
  // In self_hosted (cloud) mode the client must never read/write the local
  // SQLite database. Any code path that still reaches for the local DB while
  // both HASNA_INSTRUCTIONS_API_URL and HASNA_INSTRUCTIONS_API_KEY are set is a
  // bug that would cause silent local drift — fail loudly instead. Pass an
  // explicit path (e.g. tests) to bypass this guard.
  if (!path && process.env["HASNA_INSTRUCTIONS_API_URL"] && process.env["HASNA_INSTRUCTIONS_API_KEY"]) {
    throw new Error(
      "instructions is in self_hosted (cloud) mode: this command is not wired to the cloud API yet. " +
        "Unset HASNA_INSTRUCTIONS_API_URL / HASNA_INSTRUCTIONS_API_KEY to use it against the local store.",
    );
  }
  const dbPath = path || getDbPath();
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  ensureFeedbackTable(db);
  _db = db;
  return db;
}

export function resetDatabase(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
}

/**
 * Destroy the on-disk local database: close the handle and delete the db file
 * plus its WAL/SHM sidecars. Used by `init --force`. Resolves the path from the
 * db module (honoring HASNA_CONFIGS_DB_PATH / CONFIGS_DB_PATH); a no-op for the
 * in-memory (`:memory:`) database. Local-only — the CloudConfigStore never calls
 * this (destroying the shared cloud store from a client is forbidden).
 */
export function resetLocalDatabase(): void {
  resetDatabase();
  const dbPath = getDbPath();
  if (dbPath === ":memory:") return;
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) rmSync(p);
  }
}

function applyMigrations(db: Database): void {
  let currentVersion = 0;
  try {
    const row = db.query<{ version: number }, []>(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    ).get();
    currentVersion = row?.version ?? 0;
  } catch {
    // schema_version doesn't exist yet — fresh DB, start from 0
    currentVersion = 0;
  }

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]!);
    db.run(`INSERT OR REPLACE INTO schema_version (version) VALUES (${i + 1})`);
  }
}

function ensureFeedbackTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      message TEXT NOT NULL,
      email TEXT,
      category TEXT DEFAULT 'general',
      version TEXT,
      machine_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export interface FeedbackInput {
  message: string;
  email?: string | null;
  category?: string | null;
  version?: string | null;
}

export function insertFeedback(input: FeedbackInput, db?: Database): void {
  const d = db || getDatabase();
  d.run(
    "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
    [input.message, input.email ?? null, input.category ?? "general", input.version ?? null],
  );
}

function migrateDotfile(): void {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const oldDirs = [join(home, ".open-configs"), join(home, ".configs")];
  const newDir = join(home, ".hasna", "configs");
  if (existsSync(newDir)) return;

  for (const oldDir of oldDirs) {
    if (!existsSync(oldDir)) continue;
    try {
      if (!statSync(oldDir).isDirectory()) continue;
      mkdirSync(join(home, ".hasna"), { recursive: true });
      cpSync(oldDir, newDir, { recursive: true, force: false });
      return;
    } catch {
      // Ignore legacy directories that cannot be copied.
    }
  }
}
