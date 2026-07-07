# @hasna/instructions

> Formerly `@hasna/configs`. Same tool, renamed. The MCP server keeps the
> `configs` name aliased so existing fleet MCP configs keep working.

AI coding agent instruction & configuration manager — store, version, apply, and
share all your AI coding configs and instruction sources. CLI + MCP + HTTP API
(`instructions-serve`) + generated SDK + Dashboard.

[![npm](https://img.shields.io/npm/v/@hasna/instructions)](https://www.npmjs.com/package/@hasna/instructions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/instructions
```

## CLI Usage

```bash
instructions --help
instructions list                    # compact, paged summary
instructions list --verbose          # expanded metadata, still paged
instructions list --json             # full machine-readable records
instructions show <slug>             # full metadata + content
instructions inspect <slug>          # alias for show
instructions profile resolve
instructions profile apply --auto
instructions package-manager-scan --fail-on-findings .
instructions package-manager-scan --home --fail-on-findings .
```

Collection commands are compact by default to keep agent terminals and context
small. Human output is capped at 20 rows unless you pass `--limit`; use
`--cursor` to continue from the next page. Detail is explicit:

- `--verbose` expands list rows with descriptions, tags, and paths.
- `--json` preserves full machine-readable records for automation.
- `show`/`inspect` and `snapshot show` print full config or snapshot content.

## Package-Manager Secret Guard

`instructions package-manager-scan` blocks package-manager credential ingress without
printing credential values. It scans repo `.npmrc` files, home `.npmrc`, Bun
config, lockfiles, and shell profiles, then reports only path, line, rule,
surface, and tracked status.

Use it in CI or pre-commit hooks:

```bash
instructions package-manager-scan --fail-on-findings .
```

Use `--home` for local operator scans:

```bash
instructions package-manager-scan --home --fail-on-findings .
```

Safe `.npmrc` auth uses npm's environment reference, not a rendered literal:

```ini
@hasna:registry=https://registry.npmjs.org/
# Add the npm auth-token entry with an environment reference, not a literal value.
```

Bun release-age quarantine must stay enabled. Keep
`minimumReleaseAgeExcludes` narrowed to exact `@hasna/<package>` names only;
wildcards and third-party package names fail the guard.

## MCP Server

```bash
instructions-mcp        # or the aliased binary: configs-mcp
```

The MCP server identity is intentionally kept as `configs` so the existing
fleet MCP configuration keeps working; the fleet rename is a separate controlled
step. Agent-facing MCP tools follow the same gradual disclosure model.
`list_configs` and `list_profiles` return paged compact envelopes by default and
accept `limit`, `cursor`, and `verbose`. `apply_config` and `apply_profile` omit
`previous_content` and `new_content` unless `verbose: true` is passed. Use
`get_config` when full config content is needed.

## HTTP mode (MCP)

```bash
instructions-mcp --http          # http://127.0.0.1:8807/mcp
MCP_HTTP=1 instructions-mcp
```

Health: `GET http://127.0.0.1:8807/health`. MCP is also mounted on
`instructions-serve` at `/mcp`.

## HTTP API server (`instructions-serve`)

```bash
instructions-serve
```

Surfaces:

- `GET /health`, `GET /ready`, `GET /version` → `{ status, version, mode }`
- `GET /openapi.json`, `GET /v1/openapi.json` → the OpenAPI 3.1 document the SDK
  is generated from.
- `/v1/*` — versioned cloud API (configs, profiles, snapshots, stats).
- `/api/*` — the local dashboard/REST surface.

### Cloud mode (self-hosted, Amendment A1 pure-remote)

When `HASNA_INSTRUCTIONS_DATABASE_URL` is set the `/v1` API reads/writes the
shared cloud Postgres **directly** (no local sync/cache in the service) and every
`/v1` request is authenticated with a `@hasna/contracts` API key
(`x-api-key` or `Authorization: Bearer`). Reads need `instructions:read`, writes
need `instructions:write` (an `instructions:*` key satisfies both).

```bash
# apply the schema (idempotent; never clobbers existing tables)
instructions-serve migrate

# mint a key with the SAME signing secret the server verifies with
contracts issue-key --app instructions --scopes 'instructions:*'
```

Env: `HASNA_INSTRUCTIONS_DATABASE_URL` (DSN) and
`HASNA_INSTRUCTIONS_API_SIGNING_KEY` (HMAC signing secret; `HASNA_API_SIGNING_KEY`
and `API_KEY_SIGNING_SECRET` are also accepted). Client apps use
`INSTRUCTIONS_API_URL` + `INSTRUCTIONS_API_KEY` — never a DSN.

## SDK

`@hasna/instructions-sdk` ships a zero-dependency typed client. The versioned
`InstructionsV1Client` is generated from the serve OpenAPI document
(`bun run generate:sdk`).

## Storage Sync (local CLI)

The local CLI supports optional remote storage sync through a package-local
Postgres connection:

```bash
export HASNA_INSTRUCTIONS_DATABASE_URL=postgres://...
instructions storage status
instructions storage push
instructions storage pull
instructions storage sync
```

The MCP server also exposes `storage_status`, `storage_push`, `storage_pull`, and
`storage_sync`.

## Data Directory

Local data is stored in `~/.hasna/configs/` (unchanged, for fleet continuity).

## Session Instruction Rendering

`instructions session plan` and `instructions session apply` render
OpenIdentities and instruction sources into provider-native files for Claude,
Codex, Cursor, OpenCode, and Codewith.

```bash
instructions session plan \
  --tool codewith \
  --profile account999 \
  --identity-export ./instructions.json \
  --source project:repo-rules=./CODEWITH.md \
  --json

instructions session apply \
  --tool codex \
  --profile account999 \
  --identity-export ./instructions.json
```

Accepted source layers are `global`, `provider`/`tool`, `account`,
`identity`/`agent`, `project`, and `local`. Empty renders fail closed unless
`--allow-empty-sources` is passed. Apply writes generated manifests with file
hashes, checks previous manifests for drift, refuses unmanaged file conflicts
unless `--force` is passed, removes stale managed mirrors only when safe, and
writes local snapshots before mutating managed files.

## Machine-aware Profiles

`instructions init` seeds two platform profiles:

- `linux-arm64` for `linux-node-a` / `linux-node-b`
- `macos-arm64` for `macos-node-a` / `macos-node-b`

These profiles resolve machine variables like `{{WORKSPACE_ROOT}}`,
`{{BUN_BIN_DIR}}`, `{{BUN_PATH}}`, and `{{PATH_PREFIX}}`, so synced configs can be
portable across Linux and macOS arm64 machines.

They also include project dashboard variables used by agent-managed project
workflows:

- `{{PROJECT_DASHBOARD_DIR}}` -> `.hasna/project`
- `{{PROJECT_DASHBOARD_RENDER_MANIFEST}}` -> `.hasna/project/dashboard/render.json`
- `{{PROJECT_DASHBOARD_SNAPSHOTS_DIR}}` -> `.hasna/project/dashboard/snapshots`
- `{{PROJECT_CHANNEL_PREFIX}}` -> `iproj-`

`instructions init` and `bun run seed` seed the
`agent-managed-project-dashboard-standard` reference. It documents the standard
`.hasna/project` layout, `projects dashboard *` commands, provider panel
commands, `#iproj-*` channel naming, durable todos/goal workflow, and the rule
that dashboards must show ids/statuses/evidence refs instead of raw private
documents or secrets.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
