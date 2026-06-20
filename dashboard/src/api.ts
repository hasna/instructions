const BASE = "http://localhost:3457";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  configs: {
    list: (params?: Record<string, string>) => {
      const qs = params ? "?" + new URLSearchParams(params).toString() : "";
      return req<Config[]>("GET", `/api/configs${qs}`);
    },
    get: (id: string) => req<Config>("GET", `/api/configs/${id}`),
    update: (id: string, body: Partial<Config>) => req<Config>("PUT", `/api/configs/${id}`, body),
    apply: (id: string, dryRun = false) => req<ApplyResult>("POST", `/api/configs/${id}/apply`, { dry_run: dryRun }),
    snapshots: (id: string) => req<Snapshot[]>("GET", `/api/configs/${id}/snapshots`),
  },
  profiles: {
    list: () => req<Profile[]>("GET", "/api/profiles"),
    get: (id: string) => req<Profile & { configs: Config[] }>("GET", `/api/profiles/${id}`),
    create: (name: string, description?: string) => req<Profile>("POST", "/api/profiles", { name, description }),
    apply: async (id: string, dryRun = false) => {
      const response = await req<{ results: ApplyResult[] }>("POST", `/api/profiles/${id}/apply`, { dry_run: dryRun });
      return response.results;
    },
    addConfig: (profileId: string, configId: string) => req("POST", `/api/profiles/${profileId}/configs`, { config_id: configId }),
  },
  machines: { list: () => req<Machine[]>("GET", "/api/machines") },
  stats: () => req<Record<string, number>>("GET", "/api/stats"),
  sync: (dir: string, direction = "from_disk") => req<SyncResult>("POST", "/api/sync", { dir, direction }),
};

export interface ConfigOutput { agent: string; target_path: string; transform: string; }
export interface Config { id: string; name: string; slug: string; kind: string; category: string; agent: string; target_path: string | null; outputs: ConfigOutput[]; format: string; content: string; description: string | null; tags: string[]; is_template: boolean; version: number; created_at: string; updated_at: string; synced_at: string | null; }
export interface Profile { id: string; name: string; slug: string; description: string | null; selectors: { os?: string[]; arch?: string[]; hostnames?: string[] }; variables: Record<string, string>; created_at: string; updated_at: string; }
export interface Machine { id: string; hostname: string; os: string | null; arch: string | null; last_applied_at: string | null; created_at: string; }
export interface Snapshot { id: string; config_id: string; content: string; version: number; created_at: string; }
export interface ApplyResult { config_id: string; path: string; previous_content: string | null; new_content: string; dry_run: boolean; changed: boolean; }
export interface SyncResult { added: number; updated: number; unchanged: number; skipped: string[]; }
