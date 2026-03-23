/**
 * PostgreSQL migrations for open-configs cloud sync.
 *
 * Equivalent to the SQLite schema in database.ts, translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 1: configs table
  `CREATE TABLE IF NOT EXISTS configs (
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
    is_template BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    synced_at TEXT
  )`,

  // Migration 2: config_snapshots table
  `CREATE TABLE IF NOT EXISTS config_snapshots (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,

  // Migration 3: profiles table
  `CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // Migration 4: profile_configs join table
  `CREATE TABLE IF NOT EXISTS profile_configs (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, config_id)
  )`,

  // Migration 5: machines table
  `CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL UNIQUE,
    os TEXT,
    last_applied_at TEXT,
    created_at TEXT NOT NULL
  )`,

  // Migration 6: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
];
