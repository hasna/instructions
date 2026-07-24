// Single Store abstraction for the instructions app.
//
// LOCKED architecture (client -> AWS API only): when HASNA_INSTRUCTIONS_API_URL
// and HASNA_INSTRUCTIONS_API_KEY are both set the app runs in `api` transport
// (self_hosted OR cloud — the client code is identical; only URL/key differ and
// the self_hosted/cloud distinction is enforced server-side by tenancy). In api
// mode ALL config/profile/snapshot/machine reads and writes route to
// `https://<host>/v1` with a bearer key — no local SQLite, no DSN on the client.
// With the env unset the app uses the local SQLite store (LocalConfigStore),
// which stays fully first-class. Setting exactly one var throws (no silent
// local drift).
//
// EVERY CLI command, MCP tool, and SDK method routes through this interface.
// No consumer may import `../db/*` or call `fetch` directly.
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  createConfig as dbCreateConfig,
  deleteConfig as dbDeleteConfig,
  getConfig as dbGetConfig,
  getConfigById as dbGetConfigById,
  getConfigStats as dbGetConfigStats,
  listConfigs as dbListConfigs,
  updateConfig as dbUpdateConfig,
} from "../db/configs.js";
import {
  addConfigToProfile as dbAddConfigToProfile,
  createProfile as dbCreateProfile,
  deleteProfile as dbDeleteProfile,
  getProfile as dbGetProfile,
  getProfileConfigs as dbGetProfileConfigs,
  listProfiles as dbListProfiles,
  removeConfigFromProfile as dbRemoveConfigFromProfile,
  resolveProfileForMachine as dbResolveProfileForMachine,
  updateProfile as dbUpdateProfile,
} from "../db/profiles.js";
import {
  createSnapshot as dbCreateSnapshot,
  getSnapshot as dbGetSnapshot,
  getSnapshotByVersion as dbGetSnapshotByVersion,
  listSnapshots as dbListSnapshots,
  pruneSnapshots as dbPruneSnapshots,
} from "../db/snapshots.js";
import {
  listMachines as dbListMachines,
  registerMachine as dbRegisterMachine,
  updateMachineApplied as dbUpdateMachineApplied,
} from "../db/machines.js";
import { insertFeedback as dbInsertFeedback, resetLocalDatabase as dbResetLocalDatabase, type FeedbackInput } from "../db/database.js";
import { ConfigNotFoundError, ProfileNotFoundError } from "../types/index.js";
import type {
  Config,
  ConfigFilter,
  ConfigSnapshot,
  CreateConfigInput,
  CreateProfileInput,
  Machine,
  MachineContext,
  Profile,
  UpdateConfigInput,
  UpdateProfileInput,
} from "../types/index.js";

export interface CloudConfig {
  apiUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class CloudHttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = "CloudHttpError";
  }
}

const API_URL_ENV = "HASNA_INSTRUCTIONS_API_URL";
const API_KEY_ENV = "HASNA_INSTRUCTIONS_API_KEY";

/**
 * True when `err` is a cloud authentication failure — an HTTP 401/403 from the
 * `/v1` API, which is what a missing, expired, or revoked bearer key produces.
 */
export function isCloudAuthError(err: unknown): err is CloudHttpError {
  return err instanceof CloudHttpError && (err.status === 401 || err.status === 403);
}

/**
 * Render an error for CLI/user display. A cloud auth failure (401/403 — e.g. a
 * revoked or invalid `HASNA_INSTRUCTIONS_API_KEY`) is rewritten into a clear,
 * actionable re-auth message so the operator is not blocked by a raw
 * `CloudHttpError`: they can rotate the key or fall back to the local store.
 * All other errors fall back to their plain message (unchanged behaviour).
 */
export function formatCliError(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (isCloudAuthError(err)) {
    const apiUrl = env[API_URL_ENV]?.trim();
    const detail = err.message?.trim();
    // Only echo the server's own message when it adds signal beyond the generic
    // `HTTP <status> on ...` fallback synthesised by CloudConfigStore.request.
    const serverNote = detail && !/^HTTP \d+\b/.test(detail) ? `  Server said: ${detail}` : "";
    return [
      `Instructions cloud API rejected the request (HTTP ${err.status}: authentication failed).`,
      serverNote,
      `  The API key in ${API_KEY_ENV} is missing, expired, or revoked${apiUrl ? ` for ${apiUrl}` : ""}.`,
      `  To continue, either:`,
      `    - set a valid key:   export ${API_KEY_ENV}=<new-key>`,
      `    - or use the local store instead:   unset ${API_URL_ENV} ${API_KEY_ENV}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve cloud config from the environment.
 * - both vars set   -> config (api transport: self_hosted / cloud)
 * - neither set     -> null (local SQLite)
 * - exactly one set -> throws (no silent local drift)
 */
export function resolveCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const apiUrl = env[API_URL_ENV]?.trim();
  const apiKey = env[API_KEY_ENV]?.trim();
  if (!apiUrl && !apiKey) return null;
  if (!apiUrl || !apiKey) {
    throw new Error(
      `API mode requires BOTH ${API_URL_ENV} and ${API_KEY_ENV}; only ` +
        `${apiUrl ? API_URL_ENV : API_KEY_ENV} is set. Set both to use the cloud API, ` +
        `or unset both to use the local store.`,
    );
  }
  return { apiUrl, apiKey };
}

/** True when api (self_hosted/cloud) mode is active. */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCloudConfig(env) !== null;
}

/**
 * The single Store contract. Two transports implement it: LocalConfigStore
 * (on-box SQLite) and CloudConfigStore (HTTP /v1 + bearer key).
 */
export interface ConfigStore {
  readonly mode: "local" | "api";
  // Configs
  listConfigs(filter?: ConfigFilter): Promise<Config[]>;
  getConfig(idOrSlug: string): Promise<Config>;
  getConfigById(id: string): Promise<Config>;
  createConfig(input: CreateConfigInput): Promise<Config>;
  updateConfig(idOrSlug: string, input: UpdateConfigInput): Promise<Config>;
  deleteConfig(idOrSlug: string): Promise<void>;
  getConfigStats(): Promise<Record<string, number>>;
  // Snapshots
  listSnapshots(configId: string): Promise<ConfigSnapshot[]>;
  getSnapshot(id: string): Promise<ConfigSnapshot | null>;
  getSnapshotByVersion(configId: string, version: number): Promise<ConfigSnapshot | null>;
  createSnapshot(configId: string, content: string, version: number): Promise<ConfigSnapshot>;
  pruneSnapshots(configId: string, keep?: number): Promise<number>;
  // Profiles
  listProfiles(): Promise<Profile[]>;
  getProfile(idOrSlug: string): Promise<Profile>;
  getProfileConfigs(idOrSlug: string): Promise<Config[]>;
  createProfile(input: CreateProfileInput): Promise<Profile>;
  updateProfile(idOrSlug: string, input: UpdateProfileInput): Promise<Profile>;
  deleteProfile(idOrSlug: string): Promise<void>;
  addConfigToProfile(profileIdOrSlug: string, configId: string): Promise<void>;
  removeConfigFromProfile(profileIdOrSlug: string, configId: string): Promise<void>;
  resolveProfileForMachine(machine?: MachineContext): Promise<Profile | null>;
  // Machines
  registerMachine(hostname?: string, os?: string, arch?: string): Promise<Machine>;
  updateMachineApplied(hostname?: string): Promise<void>;
  listMachines(): Promise<Machine[]>;
  // Feedback
  sendFeedback(input: FeedbackInput): Promise<void>;
  // Lifecycle
  /**
   * Destroy all data in this store (used by `init --force`). Local: wipes the
   * on-disk SQLite database. Api: forbidden — you cannot wipe the shared cloud
   * store from a client, so the CloudConfigStore throws.
   */
  reset(): Promise<void>;
}

/**
 * Local SQLite-backed store (wraps the synchronous db layer). Accepts an
 * explicit `Database` handle for isolated use (tests); otherwise uses the
 * process-wide singleton via the db layer's default.
 */
export class LocalConfigStore implements ConfigStore {
  readonly mode = "local" as const;
  constructor(private readonly db?: Database) {}

  // Configs
  async listConfigs(filter?: ConfigFilter): Promise<Config[]> {
    return dbListConfigs(filter, this.db);
  }
  async getConfig(idOrSlug: string): Promise<Config> {
    return dbGetConfig(idOrSlug, this.db);
  }
  async getConfigById(id: string): Promise<Config> {
    return dbGetConfigById(id, this.db);
  }
  async createConfig(input: CreateConfigInput): Promise<Config> {
    return dbCreateConfig(input, this.db);
  }
  async updateConfig(idOrSlug: string, input: UpdateConfigInput): Promise<Config> {
    return dbUpdateConfig(idOrSlug, input, this.db);
  }
  async deleteConfig(idOrSlug: string): Promise<void> {
    dbDeleteConfig(idOrSlug, this.db);
  }
  async getConfigStats(): Promise<Record<string, number>> {
    return dbGetConfigStats(this.db);
  }
  // Snapshots
  async listSnapshots(configId: string): Promise<ConfigSnapshot[]> {
    return dbListSnapshots(configId, this.db);
  }
  async getSnapshot(id: string): Promise<ConfigSnapshot | null> {
    return dbGetSnapshot(id, this.db);
  }
  async getSnapshotByVersion(configId: string, version: number): Promise<ConfigSnapshot | null> {
    return dbGetSnapshotByVersion(configId, version, this.db);
  }
  async createSnapshot(configId: string, content: string, version: number): Promise<ConfigSnapshot> {
    return dbCreateSnapshot(configId, content, version, this.db);
  }
  async pruneSnapshots(configId: string, keep = 10): Promise<number> {
    return dbPruneSnapshots(configId, keep, this.db);
  }
  // Profiles
  async listProfiles(): Promise<Profile[]> {
    return dbListProfiles(this.db);
  }
  async getProfile(idOrSlug: string): Promise<Profile> {
    return dbGetProfile(idOrSlug, this.db);
  }
  async getProfileConfigs(idOrSlug: string): Promise<Config[]> {
    return dbGetProfileConfigs(idOrSlug, this.db);
  }
  async createProfile(input: CreateProfileInput): Promise<Profile> {
    return dbCreateProfile(input, this.db);
  }
  async updateProfile(idOrSlug: string, input: UpdateProfileInput): Promise<Profile> {
    return dbUpdateProfile(idOrSlug, input, this.db);
  }
  async deleteProfile(idOrSlug: string): Promise<void> {
    dbDeleteProfile(idOrSlug, this.db);
  }
  async addConfigToProfile(profileIdOrSlug: string, configId: string): Promise<void> {
    dbAddConfigToProfile(profileIdOrSlug, configId, this.db);
  }
  async removeConfigFromProfile(profileIdOrSlug: string, configId: string): Promise<void> {
    dbRemoveConfigFromProfile(profileIdOrSlug, configId, this.db);
  }
  async resolveProfileForMachine(machine?: MachineContext): Promise<Profile | null> {
    return machine
      ? dbResolveProfileForMachine(machine, this.db)
      : dbResolveProfileForMachine(undefined, this.db);
  }
  // Machines
  async registerMachine(hostname?: string, os?: string, arch?: string): Promise<Machine> {
    return dbRegisterMachine(hostname, os, arch, this.db);
  }
  async updateMachineApplied(hostname?: string): Promise<void> {
    dbUpdateMachineApplied(hostname, this.db);
  }
  async listMachines(): Promise<Machine[]> {
    return dbListMachines(this.db);
  }
  async sendFeedback(input: FeedbackInput): Promise<void> {
    dbInsertFeedback(input, this.db);
  }
  async reset(): Promise<void> {
    dbResetLocalDatabase();
  }
}

/** Cloud store: routes every operation to the `/v1` HTTP API with a bearer key. */
export class CloudConfigStore implements ConfigStore {
  readonly mode = "api" as const;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: CloudConfig) {
    this.base = `${config.apiUrl.replace(/\/+$/, "")}/v1`;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { idempotent?: boolean; allow404?: boolean } = {},
  ): Promise<{ status: number; data: T | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotent) headers["Idempotency-Key"] = randomUUID();
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 404 && opts.allow404) return { status: 404, data: null };
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const message =
          (parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : undefined) ?? `HTTP ${res.status} on ${method} ${path}`;
        throw new CloudHttpError(res.status, message, parsed);
      }
      return { status: res.status, data: parsed as T };
    } finally {
      clearTimeout(timer);
    }
  }

  // Configs
  async listConfigs(filter: ConfigFilter = {}): Promise<Config[]> {
    const params = new URLSearchParams();
    if (filter.category) params.set("category", filter.category);
    if (filter.agent) params.set("agent", filter.agent);
    if (filter.kind) params.set("kind", filter.kind);
    if (filter.search) params.set("search", filter.search);
    const qs = params.toString();
    const { data } = await this.request<{ configs: Config[] }>(
      "GET",
      `/configs${qs ? `?${qs}` : ""}`,
    );
    let configs = data?.configs ?? [];
    if (filter.tags && filter.tags.length > 0) {
      configs = configs.filter((c) => filter.tags!.every((t) => c.tags.includes(t)));
    }
    if (filter.is_template !== undefined) {
      configs = configs.filter((c) => c.is_template === filter.is_template);
    }
    return configs;
  }

  async getConfig(idOrSlug: string): Promise<Config> {
    const { status, data } = await this.request<{ config: Config }>(
      "GET",
      `/configs/${encodeURIComponent(idOrSlug)}`,
      undefined,
      { allow404: true },
    );
    if (status === 404 || !data?.config) throw new ConfigNotFoundError(idOrSlug);
    return data.config;
  }

  async getConfigById(id: string): Promise<Config> {
    return this.getConfig(id);
  }

  async createConfig(input: CreateConfigInput): Promise<Config> {
    const { data } = await this.request<{ config: Config }>("POST", "/configs", input, {
      idempotent: true,
    });
    return (data as { config: Config }).config;
  }

  async updateConfig(idOrSlug: string, input: UpdateConfigInput): Promise<Config> {
    const { data } = await this.request<{ config: Config }>(
      "PATCH",
      `/configs/${encodeURIComponent(idOrSlug)}`,
      input,
    );
    return (data as { config: Config }).config;
  }

  async deleteConfig(idOrSlug: string): Promise<void> {
    const { status } = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/configs/${encodeURIComponent(idOrSlug)}`,
      undefined,
      { allow404: true },
    );
    if (status === 404) throw new ConfigNotFoundError(idOrSlug);
  }

  async getConfigStats(): Promise<Record<string, number>> {
    const { data } = await this.request<Record<string, number>>("GET", "/stats");
    return data ?? { total: 0 };
  }

  // Snapshots
  async listSnapshots(configId: string): Promise<ConfigSnapshot[]> {
    const { data } = await this.request<{ snapshots: ConfigSnapshot[] }>(
      "GET",
      `/configs/${encodeURIComponent(configId)}/snapshots`,
    );
    return data?.snapshots ?? [];
  }

  async getSnapshot(id: string): Promise<ConfigSnapshot | null> {
    const { status, data } = await this.request<{ snapshot: ConfigSnapshot }>(
      "GET",
      `/snapshots/${encodeURIComponent(id)}`,
      undefined,
      { allow404: true },
    );
    if (status === 404 || !data?.snapshot) return null;
    return data.snapshot;
  }

  async getSnapshotByVersion(configId: string, version: number): Promise<ConfigSnapshot | null> {
    const { status, data } = await this.request<{ snapshot: ConfigSnapshot }>(
      "GET",
      `/configs/${encodeURIComponent(configId)}/snapshots/${version}`,
      undefined,
      { allow404: true },
    );
    if (status === 404 || !data?.snapshot) return null;
    return data.snapshot;
  }

  async createSnapshot(configId: string, content: string, version: number): Promise<ConfigSnapshot> {
    const { data } = await this.request<{ snapshot: ConfigSnapshot }>(
      "POST",
      `/configs/${encodeURIComponent(configId)}/snapshots`,
      { content, version },
      { idempotent: true },
    );
    return (data as { snapshot: ConfigSnapshot }).snapshot;
  }

  async pruneSnapshots(configId: string, keep = 10): Promise<number> {
    const { data } = await this.request<{ pruned: number }>(
      "POST",
      `/configs/${encodeURIComponent(configId)}/snapshots/prune`,
      { keep },
    );
    return data?.pruned ?? 0;
  }

  // Profiles
  async listProfiles(): Promise<Profile[]> {
    const { data } = await this.request<{ profiles: Profile[] }>("GET", "/profiles");
    return data?.profiles ?? [];
  }

  async getProfile(idOrSlug: string): Promise<Profile> {
    const { status, data } = await this.request<{ profile: Profile & { configs?: Config[] } }>(
      "GET",
      `/profiles/${encodeURIComponent(idOrSlug)}`,
      undefined,
      { allow404: true },
    );
    if (status === 404 || !data?.profile) throw new ProfileNotFoundError(idOrSlug);
    const { configs: _configs, ...profile } = data.profile;
    return profile;
  }

  async getProfileConfigs(idOrSlug: string): Promise<Config[]> {
    const { status, data } = await this.request<{ profile: Profile & { configs?: Config[] } }>(
      "GET",
      `/profiles/${encodeURIComponent(idOrSlug)}`,
      undefined,
      { allow404: true },
    );
    if (status === 404 || !data?.profile) throw new ProfileNotFoundError(idOrSlug);
    return data.profile.configs ?? [];
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const { data } = await this.request<{ profile: Profile }>("POST", "/profiles", input, {
      idempotent: true,
    });
    return (data as { profile: Profile }).profile;
  }

  async updateProfile(idOrSlug: string, input: UpdateProfileInput): Promise<Profile> {
    const { data } = await this.request<{ profile: Profile }>(
      "PATCH",
      `/profiles/${encodeURIComponent(idOrSlug)}`,
      input,
    );
    return (data as { profile: Profile }).profile;
  }

  async deleteProfile(idOrSlug: string): Promise<void> {
    const { status } = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/profiles/${encodeURIComponent(idOrSlug)}`,
      undefined,
      { allow404: true },
    );
    if (status === 404) throw new ProfileNotFoundError(idOrSlug);
  }

  async addConfigToProfile(profileIdOrSlug: string, configId: string): Promise<void> {
    await this.request<{ added: boolean }>(
      "POST",
      `/profiles/${encodeURIComponent(profileIdOrSlug)}/configs`,
      { config_id: configId },
      { idempotent: true },
    );
  }

  async removeConfigFromProfile(profileIdOrSlug: string, configId: string): Promise<void> {
    await this.request<{ removed: boolean }>(
      "DELETE",
      `/profiles/${encodeURIComponent(profileIdOrSlug)}/configs/${encodeURIComponent(configId)}`,
      undefined,
      { allow404: true },
    );
  }

  async resolveProfileForMachine(machine?: MachineContext): Promise<Profile | null> {
    const params = new URLSearchParams();
    if (machine?.hostname) params.set("hostname", machine.hostname);
    if (machine?.os) params.set("os", machine.os);
    if (machine?.arch) params.set("arch", machine.arch);
    const qs = params.toString();
    const { status, data } = await this.request<{ profile: Profile | null }>(
      "GET",
      `/profiles/resolve${qs ? `?${qs}` : ""}`,
      undefined,
      { allow404: true },
    );
    if (status === 404 || !data?.profile) return null;
    return data.profile;
  }

  // Machines
  async registerMachine(hostname?: string, os?: string, arch?: string): Promise<Machine> {
    const { data } = await this.request<{ machine: Machine }>(
      "POST",
      "/machines",
      { hostname, os, arch },
      { idempotent: true },
    );
    return (data as { machine: Machine }).machine;
  }

  async updateMachineApplied(hostname?: string): Promise<void> {
    await this.request<{ updated: boolean }>("POST", "/machines/applied", { hostname });
  }

  async listMachines(): Promise<Machine[]> {
    const { data } = await this.request<{ machines: Machine[] }>("GET", "/machines");
    return data?.machines ?? [];
  }

  async sendFeedback(input: FeedbackInput): Promise<void> {
    await this.request<{ ok: boolean }>("POST", "/feedback", {
      message: input.message,
      email: input.email ?? undefined,
      category: input.category ?? undefined,
      version: input.version ?? undefined,
    });
  }

  async reset(): Promise<void> {
    throw new Error(
      "`init --force` cannot wipe the shared cloud store from a client. " +
        "Unset HASNA_INSTRUCTIONS_API_URL / HASNA_INSTRUCTIONS_API_KEY to reset the local store instead.",
    );
  }
}

/** Resolve the active store: api transport when the env is set, else local. */
export function resolveConfigStore(env: NodeJS.ProcessEnv = process.env): ConfigStore {
  const cloud = resolveCloudConfig(env);
  return cloud ? new CloudConfigStore(cloud) : new LocalConfigStore();
}
