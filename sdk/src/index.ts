// @hasna/instructions-sdk — zero-dependency TypeScript client for the instructions REST API
// Works in Node, Bun, Deno, and browser environments.

export interface Config {
  id: string;
  name: string;
  slug: string;
  kind: "file" | "reference";
  category: "agent" | "rules" | "mcp" | "shell" | "secrets_schema" | "workspace" | "git" | "tools";
  agent: "claude" | "codex" | "antigravity" | "opencode" | "cursor" | "codewith" | "aicopilot" | "qwen" | "zsh" | "git" | "npm" | "global";
  target_path: string | null;
  outputs: ConfigOutput[];
  format: "text" | "json" | "toml" | "yaml" | "markdown" | "ini";
  content: string;
  description: string | null;
  tags: string[];
  is_template: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export type ConfigTransform = "passthrough" | "claude-passthrough" | "codex-flat" | "opencode-flat" | "cursor-mdc" | "skill-neutral";

export interface ConfigOutput {
  agent: Config["agent"];
  target_path: string;
  transform: ConfigTransform;
}

export interface ConfigSummary {
  id: string;
  slug: string;
  name: string;
  category: Config["category"];
  agent: Config["agent"];
  kind: Config["kind"];
  target_path: string | null;
  outputs: ConfigOutput[];
  version: number;
}

export interface Profile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  selectors: { os?: string[]; arch?: string[]; hostnames?: string[] };
  variables: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface Machine {
  id: string;
  hostname: string;
  os: string | null;
  arch: string | null;
  last_applied_at: string | null;
  created_at: string;
}

export interface ApplyResult {
  config_id: string;
  path: string;
  previous_content: string | null;
  new_content: string;
  dry_run: boolean;
  changed: boolean;
}

export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: string[];
}

export interface ConfigFilter {
  category?: Config["category"];
  agent?: Config["agent"];
  kind?: Config["kind"];
  search?: string;
  fields?: string;
}

export interface CreateConfigInput {
  name: string;
  content: string;
  category: Config["category"];
  agent?: Config["agent"];
  target_path?: string;
  outputs?: ConfigOutput[];
  kind?: Config["kind"];
  format?: Config["format"];
  tags?: string[];
  description?: string;
  is_template?: boolean;
}

export interface UpdateConfigInput {
  content?: string;
  name?: string;
  tags?: string[];
  description?: string;
  category?: Config["category"];
  agent?: Config["agent"];
  target_path?: string;
  outputs?: ConfigOutput[];
}

export interface ConfigsClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class ConfigsClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(opts: ConfigsClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3457").replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (opts.apiKey) this.headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json() as T | { error: string };
    if (!res.ok) throw new Error((data as { error: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  }

  async listConfigs(filter?: ConfigFilter): Promise<Config[]> {
    const params = new URLSearchParams();
    if (filter?.category) params.set("category", filter.category);
    if (filter?.agent) params.set("agent", filter.agent);
    if (filter?.kind) params.set("kind", filter.kind);
    if (filter?.search) params.set("search", filter.search);
    if (filter?.fields) params.set("fields", filter.fields);
    const qs = params.toString() ? `?${params}` : "";
    return this.req<Config[]>("GET", `/api/configs${qs}`);
  }

  async getConfig(idOrSlug: string): Promise<Config> {
    return this.req<Config>("GET", `/api/configs/${idOrSlug}`);
  }

  async createConfig(input: CreateConfigInput): Promise<Config> {
    return this.req<Config>("POST", "/api/configs", input);
  }

  async updateConfig(idOrSlug: string, input: UpdateConfigInput): Promise<Config> {
    return this.req<Config>("PUT", `/api/configs/${idOrSlug}`, input);
  }

  async deleteConfig(idOrSlug: string): Promise<void> {
    await this.req<{ ok: boolean }>("DELETE", `/api/configs/${idOrSlug}`);
  }

  async applyConfig(idOrSlug: string, dryRun = false): Promise<ApplyResult> {
    return this.req<ApplyResult>("POST", `/api/configs/${idOrSlug}/apply`, { dry_run: dryRun });
  }

  async syncDirectory(dir: string, direction: "from_disk" | "to_disk" = "from_disk", dryRun = false): Promise<SyncResult> {
    return this.req<SyncResult>("POST", "/api/sync", { dir, direction, dry_run: dryRun });
  }

  async listProfiles(): Promise<Profile[]> {
    return this.req<Profile[]>("GET", "/api/profiles");
  }

  async getProfile(idOrSlug: string): Promise<Profile & { configs: Config[] }> {
    return this.req<Profile & { configs: Config[] }>("GET", `/api/profiles/${idOrSlug}`);
  }

  async createProfile(name: string, description?: string, opts?: { selectors?: Profile["selectors"]; variables?: Profile["variables"] }): Promise<Profile> {
    return this.req<Profile>("POST", "/api/profiles", {
      name,
      description,
      selectors: opts?.selectors,
      variables: opts?.variables,
    });
  }

  async updateProfile(idOrSlug: string, input: { name?: string; description?: string; selectors?: Profile["selectors"]; variables?: Profile["variables"] }): Promise<Profile> {
    return this.req<Profile>("PUT", `/api/profiles/${idOrSlug}`, input);
  }

  async deleteProfile(idOrSlug: string): Promise<void> {
    await this.req<{ ok: boolean }>("DELETE", `/api/profiles/${idOrSlug}`);
  }

  async applyProfile(idOrSlug: string, dryRun = false): Promise<ApplyResult[]> {
    const response = await this.req<{ results: ApplyResult[] }>("POST", `/api/profiles/${idOrSlug}/apply`, { dry_run: dryRun });
    return response.results;
  }

  async resolveProfile(opts?: { hostname?: string; os?: string; arch?: string }): Promise<{ profile: Profile; machine: Machine & { os_family: string; home_dir: string; workspace_root: string; bun_bin_dir: string; bun_path: string; path_prefix: string }; variables: Record<string, string> }> {
    return this.req("POST", "/api/profiles/resolve", opts);
  }

  async applyAutoProfile(opts?: { dryRun?: boolean; hostname?: string; os?: string; arch?: string }): Promise<{ profile: Profile; machine: Machine & { os_family: string; home_dir: string; workspace_root: string; bun_bin_dir: string; bun_path: string; path_prefix: string }; results: ApplyResult[] }> {
    return this.req("POST", "/api/profiles/apply-auto", {
      dry_run: opts?.dryRun,
      hostname: opts?.hostname,
      os: opts?.os,
      arch: opts?.arch,
    });
  }

  async listMachines(): Promise<Machine[]> {
    return this.req<Machine[]>("GET", "/api/machines");
  }

  async registerMachine(hostname?: string, os?: string, arch?: string): Promise<Machine> {
    return this.req<Machine>("POST", "/api/machines", { hostname, os, arch });
  }

  async getStats(): Promise<Record<string, number>> {
    return this.req<Record<string, number>>("GET", "/api/stats");
  }

  async getStatus(): Promise<{ total: number; by_category: Record<string, number>; templates: number; db_path: string }> {
    return this.req("GET", "/api/status");
  }

  async syncKnown(opts?: { agent?: string; category?: string; dry_run?: boolean }): Promise<SyncResult> {
    return this.req<SyncResult>("POST", "/api/sync-known", opts);
  }

  async createSnapshot(configId: string): Promise<{ id: string; config_id: string; version: number; created_at: string }> {
    return this.req("POST", `/api/configs/${configId}/snapshot`);
  }

  async getSnapshots(configId: string): Promise<Array<{ id: string; config_id: string; content: string; version: number; created_at: string }>> {
    return this.req("GET", `/api/configs/${configId}/snapshots`);
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    return this.req<{ ok: boolean; version: string }>("GET", "/health");
  }
}

export default ConfigsClient;

// ── Versioned /v1 cloud client ───────────────────────────────────────────────
// Generated from the serve OpenAPI document (src/server/openapi.ts).
// Regenerate with `bun run scripts/generate-sdk.ts`.
export { InstructionsV1Client, ApiError as InstructionsV1ApiError } from "./v1.generated.js";
export type {
  InstructionsV1ClientOptions,
  Config as InstructionsV1Config,
  Profile as InstructionsV1Profile,
  CreateConfigInput as InstructionsV1CreateConfigInput,
  UpdateConfigInput as InstructionsV1UpdateConfigInput,
  CreateProfileInput as InstructionsV1CreateProfileInput,
} from "./v1.generated.js";
