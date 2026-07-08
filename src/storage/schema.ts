/**
 * Canonical Postgres schema for the instructions cloud (A1 pure-remote) DB.
 *
 * These statements are idempotent (`CREATE ... IF NOT EXISTS`) and NEVER drop
 * or rewrite existing tables — safe to run against a populated database. The
 * same DDL is committed under `migrations/0001_instructions.sql` for
 * transparency; the migration runner and the serve process both apply it via
 * this single, tested code path.
 */

/** Ordered list of schema statements for the instructions domain tables. */
export function instructionsSchemaSql(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS configs (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       slug TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL DEFAULT 'file',
       category TEXT NOT NULL,
       agent TEXT NOT NULL DEFAULT 'global',
       target_path TEXT,
       outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
       format TEXT NOT NULL DEFAULT 'text',
       content TEXT NOT NULL DEFAULT '',
       description TEXT,
       tags JSONB NOT NULL DEFAULT '[]'::jsonb,
       is_template BOOLEAN NOT NULL DEFAULT false,
       version INTEGER NOT NULL DEFAULT 1,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       synced_at TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS configs_category_idx ON configs (category)`,
    `CREATE INDEX IF NOT EXISTS configs_agent_idx ON configs (agent)`,
    `CREATE TABLE IF NOT EXISTS config_snapshots (
       id TEXT PRIMARY KEY,
       config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
       content TEXT NOT NULL,
       version INTEGER NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS config_snapshots_config_idx ON config_snapshots (config_id)`,
    `CREATE TABLE IF NOT EXISTS profiles (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       slug TEXT NOT NULL UNIQUE,
       description TEXT,
       selectors JSONB NOT NULL DEFAULT '{}'::jsonb,
       variables JSONB NOT NULL DEFAULT '{}'::jsonb,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS profile_configs (
       profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
       config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
       sort_order INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (profile_id, config_id)
     )`,
    `CREATE TABLE IF NOT EXISTS machines (
       id TEXT PRIMARY KEY,
       hostname TEXT NOT NULL UNIQUE,
       os TEXT,
       arch TEXT,
       last_applied_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS feedback (
       id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
       message TEXT NOT NULL,
       email TEXT,
       category TEXT DEFAULT 'general',
       version TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ];
}
