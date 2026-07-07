// Async config/profile data store with a local (SQLite) and a cloud (HTTP /v1)
// implementation, selected at runtime.
//
// LOCKED architecture (client -> AWS API only): when HASNA_INSTRUCTIONS_API_URL
// and HASNA_INSTRUCTIONS_API_KEY are both set (self_hosted mode), ALL config and
// profile reads/writes route to https://<host>/v1 with a bearer key — no local
// SQLite, no DSN on the client. With the env unset, the local SQLite store is
// used and the local database is never touched. Setting only one var throws
// (no silent local drift).
import { randomUUID } from "node:crypto";
import {
  createConfig as dbCreateConfig,
  deleteConfig as dbDeleteConfig,
  getConfig as dbGetConfig,
  getConfigStats as dbGetConfigStats,
  listConfigs as dbListConfigs,
  updateConfig as dbUpdateConfig,
} from "../db/configs.js";
import {
  createProfile as dbCreateProfile,
  deleteProfile as dbDeleteProfile,
  getProfile as dbGetProfile,
  getProfileConfigs as dbGetProfileConfigs,
  listProfiles as dbListProfiles,
  updateProfile as dbUpdateProfile,
} from "../db/profiles.js";
import {
  createSnapshot as dbCreateSnapshot,
  listSnapshots as dbListSnapshots,
} from "../db/snapshots.js";
import { ConfigNotFoundError, ProfileNotFoundError } from "../types/index.js";
import type {
  Config,
  ConfigFilter,
  ConfigSnapshot,
  CreateConfigInput,
  CreateProfileInput,
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
 * Resolve cloud config from the environment.
 * - both vars set   -> config (self_hosted / cloud-http)
 * - neither set     -> null (local SQLite)
 * - exactly one set -> throws (no silent local drift)
 */
export function resolveCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const apiUrl = env[API_URL_ENV]?.trim();
  const apiKey = env[API_KEY_ENV]?.trim();
  if (!apiUrl && !apiKey) return null;
  if (!apiUrl || !apiKey) {
    throw new Error(
      `Cloud (self_hosted) mode requires BOTH ${API_URL_ENV} and ${API_KEY_ENV}; only ` +
        `${apiUrl ? API_URL_ENV : API_KEY_ENV} is set. Set both to use the cloud API, ` +
        `or unset both to use the local store.`,
    );
  }
  return { apiUrl, apiKey };
}

/** True when self_hosted cloud mode is active. */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCloudConfig(env) !== null;
}

export interface ConfigStore {
  readonly mode: "local" | "cloud";
  listConfigs(filter?: ConfigFilter): Promise<Config[]>;
  getConfig(idOrSlug: string): Promise<Config>;
  createConfig(input: CreateConfigInput): Promise<Config>;
  updateConfig(idOrSlug: string, input: UpdateConfigInput): Promise<Config>;
  deleteConfig(idOrSlug: string): Promise<void>;
  getConfigStats(): Promise<Record<string, number>>;
  listProfiles(): Promise<Profile[]>;
  getProfile(idOrSlug: string): Promise<Profile>;
  getProfileConfigs(idOrSlug: string): Promise<Config[]>;
  createProfile(input: CreateProfileInput): Promise<Profile>;
  updateProfile(idOrSlug: string, input: UpdateProfileInput): Promise<Profile>;
  deleteProfile(idOrSlug: string): Promise<void>;
  listSnapshots(idOrSlug: string): Promise<ConfigSnapshot[]>;
  createSnapshot(idOrSlug: string): Promise<ConfigSnapshot>;
}

/** Local SQLite-backed store (wraps the synchronous db layer). */
export class LocalConfigStore implements ConfigStore {
  readonly mode = "local" as const;
  async listConfigs(filter?: ConfigFilter): Promise<Config[]> {
    return dbListConfigs(filter);
  }
  async getConfig(idOrSlug: string): Promise<Config> {
    return dbGetConfig(idOrSlug);
  }
  async createConfig(input: CreateConfigInput): Promise<Config> {
    return dbCreateConfig(input);
  }
  async updateConfig(idOrSlug: string, input: UpdateConfigInput): Promise<Config> {
    return dbUpdateConfig(idOrSlug, input);
  }
  async deleteConfig(idOrSlug: string): Promise<void> {
    dbDeleteConfig(idOrSlug);
  }
  async getConfigStats(): Promise<Record<string, number>> {
    return dbGetConfigStats();
  }
  async listProfiles(): Promise<Profile[]> {
    return dbListProfiles();
  }
  async getProfile(idOrSlug: string): Promise<Profile> {
    return dbGetProfile(idOrSlug);
  }
  async getProfileConfigs(idOrSlug: string): Promise<Config[]> {
    return dbGetProfileConfigs(idOrSlug);
  }
  async createProfile(input: CreateProfileInput): Promise<Profile> {
    return dbCreateProfile(input);
  }
  async updateProfile(idOrSlug: string, input: UpdateProfileInput): Promise<Profile> {
    return dbUpdateProfile(idOrSlug, input);
  }
  async deleteProfile(idOrSlug: string): Promise<void> {
    dbDeleteProfile(idOrSlug);
  }
  async listSnapshots(idOrSlug: string): Promise<ConfigSnapshot[]> {
    return dbListSnapshots(idOrSlug);
  }
  async createSnapshot(idOrSlug: string): Promise<ConfigSnapshot> {
    const config = dbGetConfig(idOrSlug);
    return dbCreateSnapshot(config.id, config.content, config.version);
  }
}

/** Cloud store: routes every operation to the `/v1` HTTP API. */
export class CloudConfigStore implements ConfigStore {
  readonly mode = "cloud" as const;
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
    // Filters not supported by the API query are applied client-side.
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

  async listSnapshots(idOrSlug: string): Promise<ConfigSnapshot[]> {
    const { data } = await this.request<{ snapshots: ConfigSnapshot[] }>(
      "GET",
      `/configs/${encodeURIComponent(idOrSlug)}/snapshots`,
    );
    return data?.snapshots ?? [];
  }

  async createSnapshot(idOrSlug: string): Promise<ConfigSnapshot> {
    const { data } = await this.request<{ snapshot: ConfigSnapshot }>(
      "POST",
      `/configs/${encodeURIComponent(idOrSlug)}/snapshots`,
      {},
      { idempotent: true },
    );
    return (data as { snapshot: ConfigSnapshot }).snapshot;
  }
}

/** Resolve the active store: cloud when self_hosted env is set, else local. */
export function resolveConfigStore(env: NodeJS.ProcessEnv = process.env): ConfigStore {
  const cloud = resolveCloudConfig(env);
  return cloud ? new CloudConfigStore(cloud) : new LocalConfigStore();
}
