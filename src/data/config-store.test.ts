import { afterEach, describe, expect, test } from "bun:test";
import {
  CloudConfigStore,
  CloudHttpError,
  LocalConfigStore,
  formatCliError,
  isCloudAuthError,
  isCloudMode,
  resolveCloudConfig,
  resolveConfigStore,
} from "./config-store.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (call: RecordedCall) => { status?: number; json?: unknown }) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, json } = handler(call);
    return new Response(json === undefined ? "" : JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const CONFIG = { apiUrl: "https://instructions.hasna.xyz", apiKey: "test-key-xyz" };
const SAMPLE = {
  id: "cfg-1",
  name: "Demo",
  slug: "demo",
  kind: "file",
  category: "rules",
  agent: "global",
  target_path: null,
  outputs: [],
  format: "markdown",
  content: "hello",
  description: null,
  tags: [],
  is_template: false,
  version: 1,
  created_at: "",
  updated_at: "",
  synced_at: null,
};

let active: { restore(): void } | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
});

describe("resolveCloudConfig", () => {
  test("null when neither set", () => {
    expect(resolveCloudConfig({})).toBeNull();
    expect(isCloudMode({})).toBe(false);
  });
  test("config when both set", () => {
    const env = { HASNA_INSTRUCTIONS_API_URL: "https://x", HASNA_INSTRUCTIONS_API_KEY: "k" };
    expect(resolveCloudConfig(env)).toEqual({ apiUrl: "https://x", apiKey: "k" });
    expect(isCloudMode(env)).toBe(true);
  });
  test("throws when only one set (no silent local drift)", () => {
    expect(() => resolveCloudConfig({ HASNA_INSTRUCTIONS_API_URL: "https://x" })).toThrow();
    expect(() => resolveCloudConfig({ HASNA_INSTRUCTIONS_API_KEY: "k" })).toThrow();
  });
});

describe("resolveConfigStore", () => {
  test("local when env unset", () => {
    expect(resolveConfigStore({})).toBeInstanceOf(LocalConfigStore);
  });
  test("cloud when both env vars set", () => {
    const store = resolveConfigStore({
      HASNA_INSTRUCTIONS_API_URL: "https://instructions.hasna.xyz",
      HASNA_INSTRUCTIONS_API_KEY: "k",
    });
    expect(store).toBeInstanceOf(CloudConfigStore);
    expect(store.mode).toBe("api");
  });
});

describe("CloudConfigStore CRUD mapping", () => {
  test("listConfigs -> GET /v1/configs with bearer + query", async () => {
    const m = mockFetch(() => ({ json: { configs: [SAMPLE], count: 1 } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    const configs = await store.listConfigs({ category: "rules" as never });
    expect(configs).toHaveLength(1);
    expect(m.calls[0].url).toBe("https://instructions.hasna.xyz/v1/configs?category=rules");
    expect(m.calls[0].headers["Authorization"]).toBe("Bearer test-key-xyz");
  });

  test("getConfig -> GET /v1/configs/:id; 404 -> ConfigNotFoundError", async () => {
    const m = mockFetch((c) =>
      c.url.endsWith("/missing") ? { status: 404, json: { error: "not found" } } : { json: { config: SAMPLE } },
    );
    active = m;
    const store = new CloudConfigStore(CONFIG);
    expect((await store.getConfig("demo")).slug).toBe("demo");
    await expect(store.getConfig("missing")).rejects.toThrow();
  });

  test("createConfig -> POST with Idempotency-Key", async () => {
    const m = mockFetch(() => ({ status: 201, json: { config: SAMPLE } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    const created = await store.createConfig({ name: "Demo", category: "rules" as never, content: "hello" });
    expect(created.id).toBe("cfg-1");
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].headers["Idempotency-Key"]).toBeTruthy();
  });

  test("updateConfig -> PATCH /v1/configs/:id", async () => {
    const m = mockFetch(() => ({ json: { config: { ...SAMPLE, content: "new" } } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    const updated = await store.updateConfig("demo", { content: "new" });
    expect(updated.content).toBe("new");
    expect(m.calls[0].method).toBe("PATCH");
    expect(m.calls[0].body).toEqual({ content: "new" });
  });

  test("deleteConfig -> DELETE; 404 -> throws", async () => {
    const m = mockFetch((c) => (c.url.endsWith("/gone") ? { status: 404 } : { json: { deleted: true } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    await store.deleteConfig("demo");
    expect(m.calls[0].method).toBe("DELETE");
    await expect(store.deleteConfig("gone")).rejects.toThrow();
  });

  test("getConfigStats -> GET /v1/stats", async () => {
    const m = mockFetch(() => ({ json: { total: 3, rules: 3 } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    expect(await store.getConfigStats()).toEqual({ total: 3, rules: 3 });
    expect(m.calls[0].url).toBe("https://instructions.hasna.xyz/v1/stats");
  });

  test("non-2xx surfaces CloudHttpError", async () => {
    const m = mockFetch(() => ({ status: 401, json: { error: "unauthorized" } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    await expect(store.listConfigs()).rejects.toBeInstanceOf(CloudHttpError);
  });

  test("getProfileConfigs -> GET /v1/profiles/:id embeds configs", async () => {
    const m = mockFetch(() => ({ json: { profile: { id: "p1", name: "P", slug: "p", configs: [SAMPLE] } } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    const configs = await store.getProfileConfigs("p");
    expect(configs).toHaveLength(1);
  });
});

describe("revoked / invalid API key handling", () => {
  const AUTH_ENV = {
    HASNA_INSTRUCTIONS_API_URL: "https://instructions.hasna.xyz",
    HASNA_INSTRUCTIONS_API_KEY: "revoked-key",
  };

  test("isCloudAuthError only matches 401/403 CloudHttpError", () => {
    expect(isCloudAuthError(new CloudHttpError(401, "API key has been revoked"))).toBe(true);
    expect(isCloudAuthError(new CloudHttpError(403, "forbidden"))).toBe(true);
    expect(isCloudAuthError(new CloudHttpError(500, "boom"))).toBe(false);
    expect(isCloudAuthError(new CloudHttpError(404, "not found"))).toBe(false);
    expect(isCloudAuthError(new Error("network down"))).toBe(false);
  });

  test("formatCliError rewrites a revoked-key error into an actionable re-auth message", () => {
    const msg = formatCliError(new CloudHttpError(401, "API key has been revoked"), AUTH_ENV);
    expect(msg).toContain("authentication failed");
    expect(msg).toContain("API key has been revoked");
    expect(msg).toContain("HASNA_INSTRUCTIONS_API_KEY");
    expect(msg).toContain("https://instructions.hasna.xyz");
    // offers both a re-auth and a local-store fallback path
    expect(msg).toContain("export HASNA_INSTRUCTIONS_API_KEY=");
    expect(msg).toContain("unset HASNA_INSTRUCTIONS_API_URL HASNA_INSTRUCTIONS_API_KEY");
  });

  test("formatCliError leaves non-auth errors as plain messages", () => {
    expect(formatCliError(new CloudHttpError(500, "internal error"), AUTH_ENV)).toBe("internal error");
    expect(formatCliError(new Error("disk full"))).toBe("disk full");
    expect(formatCliError("raw string")).toBe("raw string");
  });

  test("formatCliError omits the generic HTTP fallback note but keeps guidance", () => {
    const msg = formatCliError(new CloudHttpError(401, "HTTP 401 on GET /configs"), AUTH_ENV);
    expect(msg).not.toContain("Server said:");
    expect(msg).toContain("missing, expired, or revoked");
  });

  test("cloud list path with revoked key surfaces an auth error that formats cleanly", async () => {
    const m = mockFetch(() => ({ status: 401, json: { error: "API key has been revoked" } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    try {
      await store.listConfigs();
      throw new Error("expected listConfigs to reject");
    } catch (err) {
      expect(isCloudAuthError(err)).toBe(true);
      const shown = formatCliError(err, AUTH_ENV);
      expect(shown).toContain("authentication failed");
      expect(shown).toContain("unset HASNA_INSTRUCTIONS_API_URL HASNA_INSTRUCTIONS_API_KEY");
    }
  });

  test("cloud create path with revoked key surfaces an auth error that formats cleanly", async () => {
    const m = mockFetch(() => ({ status: 401, json: { error: "API key has been revoked" } }));
    active = m;
    const store = new CloudConfigStore(CONFIG);
    try {
      await store.createConfig({ name: "Demo", category: "rules" as never, content: "hello" });
      throw new Error("expected createConfig to reject");
    } catch (err) {
      expect(isCloudAuthError(err)).toBe(true);
      const shown = formatCliError(err, AUTH_ENV);
      expect(shown).toContain("export HASNA_INSTRUCTIONS_API_KEY=");
    }
  });
});
