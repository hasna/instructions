import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function getDbPath(): string {
  if (process.env["HASNA_CONFIGS_DB_PATH"]) {
    return process.env["HASNA_CONFIGS_DB_PATH"];
  }
  if (process.env["CONFIGS_DB_PATH"]) {
    return process.env["CONFIGS_DB_PATH"]; // backward compat
  }
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const newDir = join(home, ".hasna", "configs");
  const oldDir = join(home, ".configs");

  // Auto-migrate: if old dir exists and new doesn't, copy files over
  if (existsSync(oldDir) && !existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
    try {
      for (const file of readdirSync(oldDir)) {
        const oldPath = join(oldDir, file);
        const newPath = join(newDir, file);
        try {
          if (statSync(oldPath).isFile()) {
            copyFileSync(oldPath, newPath);
          }
        } catch {
          // Skip files that can't be copied
        }
      }
    } catch {
      // If we can't read old directory, continue with new
    }
  }

  mkdirSync(newDir, { recursive: true });
  return join(newDir, "configs.db");
}

function ensureDir(filePath: string): void {
  if (filePath === ":memory:" || filePath.startsWith("file::memory:")) return;
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
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
];

let _db: Database | null = null;

export function getDatabase(path?: string): Database {
  if (_db) return _db;
  const dbPath = path || getDbPath();
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  _db = db;
  return db;
}

export function resetDatabase(): void {
  _db = null;
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
    db.run(MIGRATIONS[i]!);
    db.run(`INSERT OR REPLACE INTO schema_version (version) VALUES (${i + 1})`);
  }
}
