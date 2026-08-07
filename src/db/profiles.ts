import type { Database } from "bun:sqlite";
import type {
  Config,
  CreateProfileInput,
  Profile,
  ProfileSelector,
  ProfileVariables,
  ProfileRow,
  UpdateProfileInput,
  MachineContext,
  BoundedReadOptions,
  BoundedReadPage,
  ProfileResolutionRead,
} from "../types/index.js";
import { ProfileNotFoundError } from "../types/index.js";
import { getDatabase, now, slugify, uuid } from "./database.js";
import { getConfigById } from "./configs.js";
import { detectMachineContext, normalizeOsFamily } from "../lib/machine.js";
import { boundedReadPage, normalizeBoundedReadOptions } from "../lib/bounded-read.js";

function rowToProfile(row: ProfileRow): Profile {
  return {
    ...row,
    selectors: JSON.parse(row.selectors || "{}") as ProfileSelector,
    variables: JSON.parse(row.variables || "{}") as ProfileVariables,
  };
}

function uniqueProfileSlug(name: string, db: Database, excludeId?: string): string {
  const base = slugify(name);
  let slug = base;
  let i = 1;
  while (true) {
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM profiles WHERE slug = ?")
      .get(slug);
    if (!existing || existing.id === excludeId) return slug;
    slug = `${base}-${i++}`;
  }
}

export function createProfile(input: CreateProfileInput, db?: Database): Profile {
  const d = db || getDatabase();
  const id = uuid();
  const ts = now();
  const slug = uniqueProfileSlug(input.name, d);
  d.run(
    "INSERT INTO profiles (id, name, slug, description, selectors, variables, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      input.name,
      slug,
      input.description ?? null,
      JSON.stringify(input.selectors ?? {}),
      JSON.stringify(input.variables ?? {}),
      ts,
      ts,
    ]
  );
  return getProfile(id, d);
}

export function getProfile(idOrSlug: string, db?: Database): Profile {
  const d = db || getDatabase();
  const row = d
    .query<ProfileRow, [string, string]>(
      "SELECT * FROM profiles WHERE id = ? OR slug = ?"
    )
    .get(idOrSlug, idOrSlug);
  if (!row) throw new ProfileNotFoundError(idOrSlug);
  return rowToProfile(row);
}

export function listProfiles(db?: Database): Profile[] {
  const d = db || getDatabase();
  return d
    .query<ProfileRow, []>("SELECT * FROM profiles ORDER BY name")
    .all()
    .map(rowToProfile);
}

export function listProfilesPage(
  options: BoundedReadOptions = {},
  db?: Database,
): BoundedReadPage<Profile> {
  const d = db || getDatabase();
  const normalized = normalizeBoundedReadOptions(options);
  const total = d.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM profiles").get()?.total ?? 0;
  const rows = d
    .query<ProfileRow, [number, number]>("SELECT * FROM profiles ORDER BY name LIMIT ? OFFSET ?")
    .all(normalized.limit, normalized.cursor)
    .map(rowToProfile);
  return boundedReadPage(rows, total, normalized);
}

export function updateProfile(
  idOrSlug: string,
  input: UpdateProfileInput,
  db?: Database
): Profile {
  const d = db || getDatabase();
  const existing = getProfile(idOrSlug, d);
  const ts = now();
  const updates: string[] = ["updated_at = ?"];
  const params: (string | null)[] = [ts];

  if (input.name !== undefined) {
    updates.push("name = ?", "slug = ?");
    params.push(input.name, uniqueProfileSlug(input.name, d, existing.id));
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    params.push(input.description);
  }
  if (input.selectors !== undefined) {
    updates.push("selectors = ?");
    params.push(JSON.stringify(input.selectors));
  }
  if (input.variables !== undefined) {
    updates.push("variables = ?");
    params.push(JSON.stringify(input.variables));
  }
  params.push(existing.id);
  d.run(`UPDATE profiles SET ${updates.join(", ")} WHERE id = ?`, params);
  return getProfile(existing.id, d);
}

export function deleteProfile(idOrSlug: string, db?: Database): void {
  const d = db || getDatabase();
  const existing = getProfile(idOrSlug, d);
  d.run("DELETE FROM profiles WHERE id = ?", [existing.id]);
}

export function addConfigToProfile(
  profileIdOrSlug: string,
  configId: string,
  db?: Database
): void {
  const d = db || getDatabase();
  const profile = getProfile(profileIdOrSlug, d);
  const maxRow = d
    .query<{ max_order: number | null }, [string]>(
      "SELECT MAX(sort_order) as max_order FROM profile_configs WHERE profile_id = ?"
    )
    .get(profile.id);
  const order = (maxRow?.max_order ?? -1) + 1;
  d.run(
    "INSERT OR IGNORE INTO profile_configs (profile_id, config_id, sort_order) VALUES (?, ?, ?)",
    [profile.id, configId, order]
  );
}

export function removeConfigFromProfile(
  profileIdOrSlug: string,
  configId: string,
  db?: Database
): void {
  const d = db || getDatabase();
  const profile = getProfile(profileIdOrSlug, d);
  d.run(
    "DELETE FROM profile_configs WHERE profile_id = ? AND config_id = ?",
    [profile.id, configId]
  );
}

export function getProfileConfigs(profileIdOrSlug: string, db?: Database): Config[] {
  const d = db || getDatabase();
  const configs: Config[] = [];
  let cursor = 0;
  while (true) {
    const page = getProfileConfigsPage(profileIdOrSlug, { limit: 100, cursor }, d);
    configs.push(...page.items);
    if (page.complete) return configs;
    cursor = page.next_cursor!;
  }
}

export function getProfileConfigsPage(
  profileIdOrSlug: string,
  options: BoundedReadOptions = {},
  db?: Database,
): BoundedReadPage<Config> {
  const d = db || getDatabase();
  const profile = getProfile(profileIdOrSlug, d);
  const normalized = normalizeBoundedReadOptions(options);
  const total = d
    .query<{ total: number }, [string]>("SELECT COUNT(*) AS total FROM profile_configs WHERE profile_id = ?")
    .get(profile.id)?.total ?? 0;
  const rows = d
    .query<{ config_id: string }, [string, number, number]>(
      "SELECT config_id FROM profile_configs WHERE profile_id = ? ORDER BY sort_order LIMIT ? OFFSET ?",
    )
    .all(profile.id, normalized.limit, normalized.cursor);
  return boundedReadPage(rows.map((row) => getConfigById(row.config_id, d)), total, normalized);
}

export function profileHasSelectors(profile: Pick<Profile, "selectors">): boolean {
  const selectors = profile.selectors ?? {};
  return (selectors.os?.length ?? 0) > 0
    || (selectors.arch?.length ?? 0) > 0
    || (selectors.hostnames?.length ?? 0) > 0;
}

export function profileMatchesMachine(
  profile: Pick<Profile, "selectors">,
  machine: Pick<MachineContext, "hostname" | "os" | "arch" | "os_family">
): boolean {
  const selectors = profile.selectors ?? {};
  const osMatches = !selectors.os?.length
    || selectors.os.some((candidate) => {
      const value = candidate.trim().toLowerCase();
      return value === machine.os_family || value === (machine.os ?? "").trim().toLowerCase() || normalizeOsFamily(candidate) === machine.os_family;
    });
  const archMatches = !selectors.arch?.length
    || selectors.arch.some((candidate) => candidate.trim().toLowerCase() === (machine.arch ?? "").trim().toLowerCase());
  const hostnameMatches = !selectors.hostnames?.length
    || selectors.hostnames.some((candidate) => candidate.trim().toLowerCase() === machine.hostname.trim().toLowerCase());
  return osMatches && archMatches && hostnameMatches;
}

export function resolveProfileForMachine(
  machine: MachineContext = detectMachineContext(),
  db?: Database
): Profile | null {
  return resolveProfileForMachineRead(machine, {}, db).profile;
}

export function resolveProfileForMachineRead(
  machine: MachineContext = detectMachineContext(),
  options: BoundedReadOptions = {},
  db?: Database,
): ProfileResolutionRead {
  const d = db || getDatabase();
  const { limit } = normalizeBoundedReadOptions(options);
  let cursor = 0;
  let scanned = 0;
  let total = 0;
  let selected: { profile: Profile; score: number } | null = null;

  while (true) {
    const page = listProfilesPage({ limit, cursor }, d);
    total = page.total;
    scanned += page.items.length;
    for (const profile of page.items) {
      if (!profileHasSelectors(profile) || !profileMatchesMachine(profile, machine)) continue;
      const selectors = profile.selectors;
      const score =
        (selectors.hostnames?.length ? 100 : 0) +
        (selectors.os?.length ? 10 : 0) +
        (selectors.arch?.length ? 10 : 0);
      if (
        !selected ||
        score > selected.score ||
        (score === selected.score && profile.name.localeCompare(selected.profile.name) < 0)
      ) {
        selected = { profile, score };
      }
    }
    if (page.complete) break;
    cursor = page.next_cursor!;
  }

  return {
    profile: selected?.profile ?? null,
    scanned,
    total,
    batch_limit: limit,
    complete: true,
    truncated: false,
  };
}
