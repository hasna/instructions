/**
 * PostgreSQL migrations for open-configs storage sync.
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
    outputs TEXT NOT NULL DEFAULT '[]',
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
    selectors TEXT NOT NULL DEFAULT '{}',
    variables TEXT NOT NULL DEFAULT '{}',
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
    arch TEXT,
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

  // Migration 7: output fan-out metadata
  `ALTER TABLE configs ADD COLUMN IF NOT EXISTS outputs TEXT NOT NULL DEFAULT '[]'`,

  // Migration 8: reconcile legacy duplicate target bindings, then prevent more.
  `LOCK TABLE configs, config_snapshots, profile_configs IN SHARE ROW EXCLUSIVE MODE;

   WITH ranked AS (
     SELECT
       c.id,
       FIRST_VALUE(c.id) OVER (
         PARTITION BY c.target_path
         ORDER BY
           (SELECT COUNT(*) FROM config_snapshots s WHERE s.config_id = c.id) DESC,
           c.version DESC,
           c.updated_at DESC,
           c.created_at ASC,
           c.id ASC
       ) AS survivor_id
     FROM configs c
     WHERE c.target_path IS NOT NULL
   )
   INSERT INTO profile_configs (profile_id, config_id, sort_order)
   SELECT pc.profile_id, ranked.survivor_id, MIN(pc.sort_order)
   FROM profile_configs pc
   JOIN ranked ON ranked.id = pc.config_id
   WHERE ranked.id <> ranked.survivor_id
   GROUP BY pc.profile_id, ranked.survivor_id
   ON CONFLICT (profile_id, config_id) DO UPDATE SET
     sort_order = LEAST(profile_configs.sort_order, EXCLUDED.sort_order);

   DELETE FROM configs
   WHERE id IN (
     SELECT id
     FROM (
       SELECT
         c.id,
         ROW_NUMBER() OVER (
           PARTITION BY c.target_path
           ORDER BY
             (SELECT COUNT(*) FROM config_snapshots s WHERE s.config_id = c.id) DESC,
             c.version DESC,
             c.updated_at DESC,
             c.created_at ASC,
             c.id ASC
         ) AS target_rank
       FROM configs c
       WHERE c.target_path IS NOT NULL
     ) ranked
     WHERE target_rank > 1
   );

   CREATE UNIQUE INDEX IF NOT EXISTS configs_target_path_unique_idx
     ON configs (target_path)
     WHERE target_path IS NOT NULL`,
];
