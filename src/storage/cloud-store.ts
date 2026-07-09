/**
 * Pure-remote (Amendment A1) Postgres store for the instructions `/v1` API.
 *
 * Every function reads/writes the shared RDS Postgres DIRECTLY through the
 * vendored storage kit's typed query client — there is NO local cache or sync
 * in the service. This is a real wrapper over the configs/profiles domain
 * (slug uniqueness, optimistic version bumps, JSONB (de)serialization); it
 * throws clear errors rather than returning fake no-ops.
 */
import { randomUUID } from "node:crypto";
import type { TypedQueryClient } from "../generated/storage-kit/index.js";
import {
  ConfigNotFoundError,
  ProfileNotFoundError,
  type Config,
  type ConfigFilter,
  type ConfigOutput,
  type ConfigSnapshot,
  type CreateConfigInput,
  type CreateProfileInput,
  type Machine,
  type Profile,
  type ProfileSelector,
  type ProfileVariables,
  type UpdateConfigInput,
  type UpdateProfileInput,
} from "../types/index.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value == null ? "" : String(value);
}

/** Parse a value the pg driver may hand back either as JSON string or object. */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? (p as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asObject<T>(value: unknown): T {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return p && typeof p === "object" ? (p as T) : ({} as T);
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

interface ConfigDbRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  category: string;
  agent: string;
  target_path: string | null;
  outputs: unknown;
  format: string;
  content: string;
  description: string | null;
  tags: unknown;
  is_template: boolean;
  version: number;
  created_at: unknown;
  updated_at: unknown;
  synced_at: unknown;
}

function rowToConfig(row: ConfigDbRow): Config {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind as Config["kind"],
    category: row.category as Config["category"],
    agent: row.agent as Config["agent"],
    target_path: row.target_path,
    outputs: asArray<ConfigOutput>(row.outputs),
    format: row.format as Config["format"],
    content: row.content,
    description: row.description,
    tags: asArray<string>(row.tags),
    is_template: Boolean(row.is_template),
    version: Number(row.version),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    synced_at: row.synced_at == null ? null : toIso(row.synced_at),
  };
}

async function uniqueSlug(
  client: TypedQueryClient,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugify(name) || "config";
  let slug = base;
  let i = 1;
  // Bounded loop; a handful of collisions at most in practice.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const existing = await client.get<{ id: string }>(
      "SELECT id FROM configs WHERE slug = $1",
      [slug],
    );
    if (!existing || existing.id === excludeId) return slug;
    slug = `${base}-${i++}`;
  }
  throw new Error(`could not allocate a unique slug for '${name}'`);
}

// ── Configs ────────────────────────────────────────────────────────────────

export async function listConfigs(
  client: TypedQueryClient,
  filter: ConfigFilter = {},
): Promise<Config[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("$?", `$${params.length}`));
  };
  if (filter.category) add("category = $?", filter.category);
  if (filter.agent) add("agent = $?", filter.agent);
  if (filter.kind) add("kind = $?", filter.kind);
  if (filter.is_template !== undefined) add("is_template = $?", filter.is_template);
  if (filter.search) {
    params.push(`%${filter.search}%`);
    const p = `$${params.length}`;
    conditions.push(`(name ILIKE ${p} OR description ILIKE ${p} OR content ILIKE ${p})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await client.many<ConfigDbRow>(
    `SELECT * FROM configs ${where} ORDER BY category, name`,
    params,
  );
  return rows.map(rowToConfig);
}

export async function getConfig(client: TypedQueryClient, idOrSlug: string): Promise<Config> {
  const row = await client.get<ConfigDbRow>(
    "SELECT * FROM configs WHERE id = $1 OR slug = $1",
    [idOrSlug],
  );
  if (!row) throw new ConfigNotFoundError(idOrSlug);
  return rowToConfig(row);
}

export async function createConfig(
  client: TypedQueryClient,
  input: CreateConfigInput,
): Promise<Config> {
  if (!input.name || !input.name.trim()) throw new Error("name is required");
  if (!input.category) throw new Error("category is required");
  const id = randomUUID();
  const slug = await uniqueSlug(client, input.name);
  await client.execute(
    `INSERT INTO configs
       (id, name, slug, kind, category, agent, target_path, outputs, format, content, description, tags, is_template, version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,1,now(),now())`,
    [
      id,
      input.name,
      slug,
      input.kind ?? "file",
      input.category,
      input.agent ?? "global",
      input.target_path ?? null,
      JSON.stringify(input.outputs ?? []),
      input.format ?? "text",
      input.content ?? "",
      input.description ?? null,
      JSON.stringify(input.tags ?? []),
      input.is_template ?? false,
    ],
  );
  return getConfig(client, id);
}

export async function updateConfig(
  client: TypedQueryClient,
  idOrSlug: string,
  input: UpdateConfigInput,
): Promise<Config> {
  const existing = await getConfig(client, idOrSlug);
  const sets: string[] = ["updated_at = now()", "version = version + 1"];
  const params: unknown[] = [];
  const set = (col: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (input.name !== undefined) {
    set("name", input.name);
    set("slug", await uniqueSlug(client, input.name, existing.id));
  }
  if (input.kind !== undefined) set("kind", input.kind);
  if (input.category !== undefined) set("category", input.category);
  if (input.agent !== undefined) set("agent", input.agent);
  if (input.target_path !== undefined) set("target_path", input.target_path);
  if (input.outputs !== undefined) set("outputs", JSON.stringify(input.outputs), "::jsonb");
  if (input.format !== undefined) set("format", input.format);
  if (input.content !== undefined) set("content", input.content);
  if (input.description !== undefined) set("description", input.description);
  if (input.tags !== undefined) set("tags", JSON.stringify(input.tags), "::jsonb");
  if (input.is_template !== undefined) set("is_template", input.is_template);
  if (input.synced_at !== undefined) set("synced_at", input.synced_at, "::timestamptz");

  params.push(existing.id);
  await client.execute(
    `UPDATE configs SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params,
  );
  return getConfig(client, existing.id);
}

export async function deleteConfig(client: TypedQueryClient, idOrSlug: string): Promise<void> {
  const existing = await getConfig(client, idOrSlug);
  await client.execute("DELETE FROM configs WHERE id = $1", [existing.id]);
}

export async function getConfigStats(client: TypedQueryClient): Promise<Record<string, number>> {
  const rows = await client.many<{ category: string; count: string | number }>(
    "SELECT category, COUNT(*)::int AS count FROM configs GROUP BY category",
  );
  const stats: Record<string, number> = { total: 0 };
  for (const row of rows) {
    const n = Number(row.count);
    stats[row.category] = n;
    stats.total += n;
  }
  return stats;
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export async function createSnapshot(
  client: TypedQueryClient,
  idOrSlug: string,
): Promise<ConfigSnapshot> {
  const config = await getConfig(client, idOrSlug);
  const id = randomUUID();
  await client.execute(
    `INSERT INTO config_snapshots (id, config_id, content, version, created_at)
     VALUES ($1,$2,$3,$4,now())`,
    [id, config.id, config.content, config.version],
  );
  const row = await client.get<{ id: string; config_id: string; content: string; version: number; created_at: unknown }>(
    "SELECT id, config_id, content, version, created_at FROM config_snapshots WHERE id = $1",
    [id],
  );
  if (!row) throw new Error("snapshot insert failed");
  return { id: row.id, config_id: row.config_id, content: row.content, version: Number(row.version), created_at: toIso(row.created_at) };
}

export async function createSnapshotContent(
  client: TypedQueryClient,
  idOrSlug: string,
  content: string,
  version: number,
): Promise<ConfigSnapshot> {
  const config = await getConfig(client, idOrSlug);
  const id = randomUUID();
  await client.execute(
    `INSERT INTO config_snapshots (id, config_id, content, version, created_at)
     VALUES ($1,$2,$3,$4,now())`,
    [id, config.id, content, version],
  );
  const row = await client.get<{ id: string; config_id: string; content: string; version: number; created_at: unknown }>(
    "SELECT id, config_id, content, version, created_at FROM config_snapshots WHERE id = $1",
    [id],
  );
  if (!row) throw new Error("snapshot insert failed");
  return { id: row.id, config_id: row.config_id, content: row.content, version: Number(row.version), created_at: toIso(row.created_at) };
}

export async function listSnapshots(
  client: TypedQueryClient,
  idOrSlug: string,
): Promise<ConfigSnapshot[]> {
  const config = await getConfig(client, idOrSlug);
  const rows = await client.many<{ id: string; config_id: string; content: string; version: number; created_at: unknown }>(
    "SELECT id, config_id, content, version, created_at FROM config_snapshots WHERE config_id = $1 ORDER BY version DESC",
    [config.id],
  );
  return rows.map((r) => ({ id: r.id, config_id: r.config_id, content: r.content, version: Number(r.version), created_at: toIso(r.created_at) }));
}

export async function getSnapshotById(
  client: TypedQueryClient,
  snapshotId: string,
): Promise<ConfigSnapshot | null> {
  const row = await client.get<{ id: string; config_id: string; content: string; version: number; created_at: unknown }>(
    "SELECT id, config_id, content, version, created_at FROM config_snapshots WHERE id = $1",
    [snapshotId],
  );
  return row ? { id: row.id, config_id: row.config_id, content: row.content, version: Number(row.version), created_at: toIso(row.created_at) } : null;
}

export async function getSnapshotByVersion(
  client: TypedQueryClient,
  idOrSlug: string,
  version: number,
): Promise<ConfigSnapshot | null> {
  const config = await getConfig(client, idOrSlug);
  const row = await client.get<{ id: string; config_id: string; content: string; version: number; created_at: unknown }>(
    "SELECT id, config_id, content, version, created_at FROM config_snapshots WHERE config_id = $1 AND version = $2",
    [config.id, version],
  );
  return row ? { id: row.id, config_id: row.config_id, content: row.content, version: Number(row.version), created_at: toIso(row.created_at) } : null;
}

export async function pruneSnapshots(
  client: TypedQueryClient,
  idOrSlug: string,
  keep = 10,
): Promise<number> {
  const config = await getConfig(client, idOrSlug);
  const result = await client.query(
    `DELETE FROM config_snapshots WHERE config_id = $1 AND id NOT IN (
       SELECT id FROM config_snapshots WHERE config_id = $1 ORDER BY version DESC LIMIT $2
     )`,
    [config.id, keep],
  );
  return result.rowCount ?? 0;
}

// ── Profiles ─────────────────────────────────────────────────────────────────

interface ProfileDbRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  selectors: unknown;
  variables: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function rowToProfile(row: ProfileDbRow): Profile {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    selectors: asObject<ProfileSelector>(row.selectors),
    variables: asObject<ProfileVariables>(row.variables),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export async function listProfiles(client: TypedQueryClient): Promise<Profile[]> {
  const rows = await client.many<ProfileDbRow>("SELECT * FROM profiles ORDER BY name");
  return rows.map(rowToProfile);
}

export async function getProfile(client: TypedQueryClient, idOrSlug: string): Promise<Profile> {
  const row = await client.get<ProfileDbRow>(
    "SELECT * FROM profiles WHERE id = $1 OR slug = $1",
    [idOrSlug],
  );
  if (!row) throw new ProfileNotFoundError(idOrSlug);
  return rowToProfile(row);
}

export async function getProfileConfigs(
  client: TypedQueryClient,
  idOrSlug: string,
): Promise<Config[]> {
  const profile = await getProfile(client, idOrSlug);
  const rows = await client.many<ConfigDbRow>(
    `SELECT c.* FROM configs c
       JOIN profile_configs pc ON pc.config_id = c.id
      WHERE pc.profile_id = $1
      ORDER BY pc.sort_order`,
    [profile.id],
  );
  return rows.map(rowToConfig);
}

export async function createProfile(
  client: TypedQueryClient,
  input: CreateProfileInput,
): Promise<Profile> {
  if (!input.name || !input.name.trim()) throw new Error("name is required");
  const id = randomUUID();
  const slug = await uniqueProfileSlug(client, input.name);
  await client.execute(
    `INSERT INTO profiles (id, name, slug, description, selectors, variables, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,now(),now())`,
    [id, input.name, slug, input.description ?? null, JSON.stringify(input.selectors ?? {}), JSON.stringify(input.variables ?? {})],
  );
  return getProfile(client, id);
}

async function uniqueProfileSlug(
  client: TypedQueryClient,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugify(name) || "profile";
  let slug = base;
  let i = 1;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const existing = await client.get<{ id: string }>("SELECT id FROM profiles WHERE slug = $1", [slug]);
    if (!existing || existing.id === excludeId) return slug;
    slug = `${base}-${i++}`;
  }
  throw new Error(`could not allocate a unique slug for profile '${name}'`);
}

export async function updateProfile(
  client: TypedQueryClient,
  idOrSlug: string,
  input: UpdateProfileInput,
): Promise<Profile> {
  const existing = await getProfile(client, idOrSlug);
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  const set = (col: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (input.name !== undefined) {
    set("name", input.name);
    set("slug", await uniqueProfileSlug(client, input.name, existing.id));
  }
  if (input.description !== undefined) set("description", input.description);
  if (input.selectors !== undefined) set("selectors", JSON.stringify(input.selectors), "::jsonb");
  if (input.variables !== undefined) set("variables", JSON.stringify(input.variables), "::jsonb");
  params.push(existing.id);
  await client.execute(`UPDATE profiles SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getProfile(client, existing.id);
}

export async function deleteProfile(client: TypedQueryClient, idOrSlug: string): Promise<void> {
  const existing = await getProfile(client, idOrSlug);
  await client.execute("DELETE FROM profiles WHERE id = $1", [existing.id]);
}

// ── Profile membership ───────────────────────────────────────────────────────

export async function addConfigToProfile(
  client: TypedQueryClient,
  profileIdOrSlug: string,
  configId: string,
): Promise<void> {
  const profile = await getProfile(client, profileIdOrSlug);
  const maxRow = await client.get<{ max_order: number | null }>(
    "SELECT MAX(sort_order) AS max_order FROM profile_configs WHERE profile_id = $1",
    [profile.id],
  );
  const order = (maxRow?.max_order ?? -1) + 1;
  await client.execute(
    `INSERT INTO profile_configs (profile_id, config_id, sort_order)
     VALUES ($1,$2,$3) ON CONFLICT (profile_id, config_id) DO NOTHING`,
    [profile.id, configId, order],
  );
}

export async function removeConfigFromProfile(
  client: TypedQueryClient,
  profileIdOrSlug: string,
  configId: string,
): Promise<void> {
  const profile = await getProfile(client, profileIdOrSlug);
  await client.execute(
    "DELETE FROM profile_configs WHERE profile_id = $1 AND config_id = $2",
    [profile.id, configId],
  );
}

// ── Profile resolution (machine-aware) ───────────────────────────────────────

function profileHasSelectors(selectors: ProfileSelector): boolean {
  return (selectors.os?.length ?? 0) > 0
    || (selectors.arch?.length ?? 0) > 0
    || (selectors.hostnames?.length ?? 0) > 0;
}

export async function resolveProfileForMachine(
  client: TypedQueryClient,
  machine: { hostname?: string; os?: string; arch?: string },
): Promise<Profile | null> {
  const profiles = (await listProfiles(client)).filter((p) => profileHasSelectors(p.selectors));
  const host = (machine.hostname ?? "").trim().toLowerCase();
  const os = (machine.os ?? "").trim().toLowerCase();
  const arch = (machine.arch ?? "").trim().toLowerCase();
  const matches = profiles
    .filter((p) => {
      const s = p.selectors;
      const osOk = !s.os?.length || s.os.some((c) => c.trim().toLowerCase() === os);
      const archOk = !s.arch?.length || s.arch.some((c) => c.trim().toLowerCase() === arch);
      const hostOk = !s.hostnames?.length || s.hostnames.some((c) => c.trim().toLowerCase() === host);
      return osOk && archOk && hostOk;
    })
    .map((p) => ({
      profile: p,
      score: (p.selectors.hostnames?.length ? 100 : 0) + (p.selectors.os?.length ? 10 : 0) + (p.selectors.arch?.length ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.profile.name.localeCompare(b.profile.name));
  return matches[0]?.profile ?? null;
}

// ── Machines ─────────────────────────────────────────────────────────────────

interface MachineDbRow {
  id: string;
  hostname: string;
  os: string | null;
  arch: string | null;
  last_applied_at: unknown;
  created_at: unknown;
}

function rowToMachine(row: MachineDbRow): Machine {
  return {
    id: row.id,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    last_applied_at: row.last_applied_at == null ? null : toIso(row.last_applied_at),
    created_at: toIso(row.created_at),
  };
}

export async function listMachines(client: TypedQueryClient): Promise<Machine[]> {
  const rows = await client.many<MachineDbRow>(
    "SELECT * FROM machines ORDER BY last_applied_at DESC NULLS LAST",
  );
  return rows.map(rowToMachine);
}

export async function registerMachine(
  client: TypedQueryClient,
  hostname: string,
  os: string | null,
  arch: string | null,
): Promise<Machine> {
  const existing = await client.get<MachineDbRow>("SELECT * FROM machines WHERE hostname = $1", [hostname]);
  if (existing) {
    if (existing.os !== os || existing.arch !== arch) {
      await client.execute("UPDATE machines SET os = $1, arch = $2 WHERE hostname = $3", [os, arch, hostname]);
    }
    const row = await client.get<MachineDbRow>("SELECT * FROM machines WHERE hostname = $1", [hostname]);
    return rowToMachine(row!);
  }
  const id = randomUUID();
  await client.execute(
    "INSERT INTO machines (id, hostname, os, arch, last_applied_at, created_at) VALUES ($1,$2,$3,$4,NULL,now())",
    [id, hostname, os, arch],
  );
  const row = await client.get<MachineDbRow>("SELECT * FROM machines WHERE id = $1", [id]);
  return rowToMachine(row!);
}

export async function updateMachineApplied(client: TypedQueryClient, hostname: string): Promise<void> {
  await client.execute("UPDATE machines SET last_applied_at = now() WHERE hostname = $1", [hostname]);
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export async function insertFeedback(
  client: TypedQueryClient,
  input: { message: string; email?: string | null; category?: string | null; version?: string | null },
): Promise<void> {
  await client.execute(
    "INSERT INTO feedback (id, message, email, category, version, created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [randomUUID(), input.message, input.email ?? null, input.category ?? "general", input.version ?? null],
  );
}
