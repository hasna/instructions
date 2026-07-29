# HTTP API

`instructions-serve` is the authenticated Postgres-backed `/v1` service. It is
not a local SQLite REST wrapper.

```bash
instructions-serve
instructions-serve --version
instructions-serve migrate
```

The default listener is `localhost:3457`. `PORT` overrides
`INSTRUCTIONS_PORT`; `HOST` overrides `INSTRUCTIONS_HOST`.

## Server modes

The process reports `local` mode when no database URL is configured and
`cloud` mode when one is configured. The `/v1` surface requires cloud mode: a
database URL and API signing secret. In local mode, probes and static files can
still be served, but `/v1` fails closed rather than exposing SQLite.

Database URL priority:

1. `HASNA_INSTRUCTIONS_DATABASE_URL`
2. `INSTRUCTIONS_DATABASE_URL`
3. `DATABASE_URL`

Signing-secret priority:

1. `HASNA_INSTRUCTIONS_API_SIGNING_KEY`
2. `HASNA_API_SIGNING_KEY`
3. `API_KEY_SIGNING_SECRET`

Clients receive only a service URL and API key. They never receive the DSN or
signing secret.

## Migration

```bash
HASNA_INSTRUCTIONS_DATABASE_URL=postgres://... \
HASNA_INSTRUCTIONS_API_SIGNING_KEY=... \
instructions-serve migrate
```

Migration ensures the Instructions domain tables and the contracts API-key
table. It is idempotent and does not drop existing data. A signing secret is
needed to serve requests; migration itself resolves only the database URL.

## Authentication

Every `/v1/*` request is authenticated by `@hasna/contracts`. Supply either:

```http
x-api-key: <token>
```

or:

```http
Authorization: Bearer <token>
```

GET/HEAD requests require `instructions:read`. Other methods require
`instructions:write`. `instructions:*` satisfies both. Missing server auth
configuration returns 503; invalid, expired, or revoked client credentials are
rejected by the auth middleware.

## Unauthenticated routes

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Process liveness: `{ status, version, mode, name }`. |
| GET | `/version` | Same current payload shape as `/health`. |
| GET | `/ready` | Local mode returns ready; cloud mode verifies Postgres and returns 503 when unavailable. |
| GET | `/openapi.json` | OpenAPI 3.1 document. |
| GET | `/v1/openapi.json` | Same OpenAPI document. |

CORS middleware is enabled for all routes.

## Config routes

| Method | Route | Body/query and result |
| --- | --- | --- |
| GET | `/v1/configs` | Filters: `category`, `agent`, `kind`, `search`; returns `{ configs, count }`. |
| POST | `/v1/configs` | Config create body; returns `{ config }` with 201. |
| GET | `/v1/configs/:id` | ID or slug; returns `{ config }`. |
| PATCH, PUT | `/v1/configs/:id` | Partial update body; returns `{ config }`. |
| DELETE | `/v1/configs/:id` | Returns `{ deleted: true, id }`. |
| GET | `/v1/configs/:id/snapshots` | Returns `{ snapshots, count }`. |
| POST | `/v1/configs/:id/snapshots` | Empty body snapshots current content; `{ content, version }` stores explicit content/version; returns 201. |
| GET | `/v1/configs/:id/snapshots/:version` | Returns `{ snapshot }`. |
| POST | `/v1/configs/:id/snapshots/prune` | Optional `{ keep }`, default 10; returns `{ pruned }`. |
| GET | `/v1/snapshots/:id` | Looks up a snapshot by snapshot ID. |

Create requires `name`, `category`, and `content`. The runtime store also
accepts config kind, agent, target path, outputs, format, description, tags,
and template state according to the shared TypeScript model.

## Profile routes

| Method | Route | Body/query and result |
| --- | --- | --- |
| GET | `/v1/profiles` | Returns `{ profiles, count }`. |
| POST | `/v1/profiles` | Profile create body; returns `{ profile }` with 201. |
| GET | `/v1/profiles/resolve` | Query: `hostname`, `os`, `arch`; returns the best `{ profile }` or 404. |
| GET | `/v1/profiles/:id` | Returns `{ profile: { ...profile, configs } }`. |
| PATCH, PUT | `/v1/profiles/:id` | Partial profile update; returns `{ profile }`. |
| DELETE | `/v1/profiles/:id` | Returns `{ deleted: true, id }`. |
| POST | `/v1/profiles/:id/configs` | Body `{ config_id }`; returns `{ added: true }`. |
| DELETE | `/v1/profiles/:id/configs/:configId` | Returns `{ removed: true }`. |

## Machines, stats, and feedback

| Method | Route | Body/result |
| --- | --- | --- |
| GET | `/v1/stats` | Category counts plus total. |
| GET | `/v1/machines` | Returns `{ machines, count }`. |
| POST | `/v1/machines` | `{ hostname, os?, arch? }`; returns `{ machine }` with 201. |
| POST | `/v1/machines/applied` | `{ hostname }`; updates the last-applied time. |
| POST | `/v1/feedback` | `{ message, email?, category?, version? }`; returns `{ ok: true }` with 201. |

Unknown resources/actions return 404. Known routes reject unsupported methods
with 405. Invalid JSON returns 400 where the handler reads a request body.
Database errors otherwise return 500; initial schema/database failures return
503.

## OpenAPI and generated SDK coverage

The served OpenAPI document currently describes the core config CRUD routes,
snapshot list/create, profile list/create/get/delete, and stats. The additional
runtime routes listed above are implemented but are not yet represented in that
document. Consequently, the generated `InstructionsV1Client` exposes only the
documented subset; use direct HTTP for the extended routes.

## Deliberately absent routes

- No `/api/*`: the former local REST API is not mounted.
- No `/mcp`: run `instructions-mcp` locally for MCP.

If `dashboard/dist/index.html` exists, the server serves it and other dashboard
assets as a static SPA. The checked-in dashboard still calls `/api/*`, so it is
not functional against this server until migrated to authenticated `/v1`.
