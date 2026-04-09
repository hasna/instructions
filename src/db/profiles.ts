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
} from "../types/index.js";
import { ProfileNotFoundError } from "../types/index.js";
import { getDatabase, now, slugify, uuid } from "./database.js";
import { listConfigs } from "./configs.js";
import { detectMachineContext, normalizeOsFamily } from "../lib/machine.js";

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
  const profile = getProfile(profileIdOrSlug, d);
  const rows = d
    .query<{ config_id: string }, [string]>(
      "SELECT config_id FROM profile_configs WHERE profile_id = ? ORDER BY sort_order"
    )
    .all(profile.id);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.config_id);
  return listConfigs(undefined, d).filter((c) => ids.includes(c.id));
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
  const profiles = listProfiles(db).filter(profileHasSelectors);
  const matches = profiles
    .filter((profile) => profileMatchesMachine(profile, machine))
    .map((profile) => {
      const selectors = profile.selectors;
      const score =
        (selectors.hostnames?.length ? 100 : 0) +
        (selectors.os?.length ? 10 : 0) +
        (selectors.arch?.length ? 10 : 0);
      return { profile, score };
    })
    .sort((a, b) => b.score - a.score || a.profile.name.localeCompare(b.profile.name));

  return matches[0]?.profile ?? null;
}
