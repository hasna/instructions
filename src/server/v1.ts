/**
 * Versioned `/v1` HTTP API for `instructions-serve` (A1 pure-remote).
 *
 * Every handler goes through the vendored storage kit client (`getCloudClient`)
 * which reads/writes the shared RDS directly. Auth is enforced by the contracts
 * API-key verifier: reads require `instructions:read`, writes require
 * `instructions:write` (an `instructions:*` key satisfies both). This is a real
 * wrapper over the configs/profiles store — there are NO stubs; unknown routes
 * 404 and unimplemented operations throw a clear error.
 */
import { ConfigNotFoundError, ProfileNotFoundError } from "../types/index.js";
import { getCloudClient, ensureCloudSchema } from "./cloud.js";
import * as store from "../storage/cloud-store.js";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...(extra ?? {}) }, status);
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Handle a `/v1/*` request. Authentication + read/write scope enforcement is
 * performed UPSTREAM by the contracts `honoApiKey` middleware (see
 * server/index.ts); by the time this runs the caller is an authorized principal.
 * Returns `null` when the path is not a `/v1` route so the caller can fall
 * through to other handlers.
 */
export async function handleV1Request(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/v1" && !path.startsWith("/v1/")) return null;

  const method = req.method.toUpperCase();

  // Schema is idempotently ensured on the first authenticated request.
  try {
    await ensureCloudSchema();
  } catch (e) {
    return errorResponse(503, `database unavailable: ${(e as Error).message}`);
  }
  const client = getCloudClient();

  const segments = path.split("/").filter(Boolean); // ["v1", resource, id?, action?]
  const resource = segments[1];
  const id = segments[2] ? decodeURIComponent(segments[2]) : undefined;
  const action = segments[3];

  try {
    // ── /v1/configs ──
    if (resource === "configs") {
      if (!id) {
        if (method === "GET") {
          const filter = {
            ...(url.searchParams.get("category") ? { category: url.searchParams.get("category") as never } : {}),
            ...(url.searchParams.get("agent") ? { agent: url.searchParams.get("agent") as never } : {}),
            ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind") as never } : {}),
            ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
          };
          const configs = await store.listConfigs(client, filter);
          return json({ configs, count: configs.length });
        }
        if (method === "POST") {
          const body = await readJson<Parameters<typeof store.createConfig>[1]>(req);
          if (!body) return errorResponse(400, "invalid JSON body");
          try {
            const config = await store.createConfig(client, body);
            return json({ config }, 201);
          } catch (e) {
            return errorResponse(400, (e as Error).message);
          }
        }
        return errorResponse(405, `method ${method} not allowed on /v1/configs`);
      }
      // /v1/configs/:id/snapshots
      if (action === "snapshots") {
        if (method === "GET") {
          const snapshots = await store.listSnapshots(client, id);
          return json({ snapshots, count: snapshots.length });
        }
        if (method === "POST") {
          const snapshot = await store.createSnapshot(client, id);
          return json({ snapshot }, 201);
        }
        return errorResponse(405, `method ${method} not allowed on /v1/configs/:id/snapshots`);
      }
      if (action) return errorResponse(404, `unknown config action: ${action}`);
      if (method === "GET") {
        const config = await store.getConfig(client, id);
        return json({ config });
      }
      if (method === "PATCH" || method === "PUT") {
        const body = await readJson<Parameters<typeof store.updateConfig>[2]>(req);
        if (!body) return errorResponse(400, "invalid JSON body");
        const config = await store.updateConfig(client, id, body);
        return json({ config });
      }
      if (method === "DELETE") {
        await store.deleteConfig(client, id);
        return json({ deleted: true, id });
      }
      return errorResponse(405, `method ${method} not allowed on /v1/configs/:id`);
    }

    // ── /v1/profiles ──
    if (resource === "profiles") {
      if (!id) {
        if (method === "GET") {
          const profiles = await store.listProfiles(client);
          return json({ profiles, count: profiles.length });
        }
        if (method === "POST") {
          const body = await readJson<Parameters<typeof store.createProfile>[1]>(req);
          if (!body) return errorResponse(400, "invalid JSON body");
          try {
            const profile = await store.createProfile(client, body);
            return json({ profile }, 201);
          } catch (e) {
            return errorResponse(400, (e as Error).message);
          }
        }
        return errorResponse(405, `method ${method} not allowed on /v1/profiles`);
      }
      if (method === "GET") {
        const profile = await store.getProfile(client, id);
        const configs = await store.getProfileConfigs(client, id);
        return json({ profile: { ...profile, configs } });
      }
      if (method === "PATCH" || method === "PUT") {
        const body = await readJson<Parameters<typeof store.updateProfile>[2]>(req);
        if (!body) return errorResponse(400, "invalid JSON body");
        const profile = await store.updateProfile(client, id, body);
        return json({ profile });
      }
      if (method === "DELETE") {
        await store.deleteProfile(client, id);
        return json({ deleted: true, id });
      }
      return errorResponse(405, `method ${method} not allowed on /v1/profiles/:id`);
    }

    // ── /v1/stats ──
    if (resource === "stats" && method === "GET") {
      return json(await store.getConfigStats(client));
    }

    return errorResponse(404, `unknown /v1 resource: ${resource ?? "(root)"}`);
  } catch (e) {
    if (e instanceof ConfigNotFoundError || e instanceof ProfileNotFoundError) {
      return errorResponse(404, e.message);
    }
    return errorResponse(500, (e as Error).message || "internal error");
  }
}
