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

## Storage Modes

Every CLI command, MCP tool, and SDK method routes through a single `ConfigStore`
abstraction with two transports:

- **local** — on-box SQLite (`LocalConfigStore`), fully first-class. Used when no
  API env vars are set.
- **api** (self_hosted / cloud) — HTTP `/v1` + bearer key (`CloudConfigStore`).
  Activated by setting **both** `HASNA_INSTRUCTIONS_API_URL` and
  `HASNA_INSTRUCTIONS_API_KEY`. Identical client code; only the URL/key differ,
  and the self_hosted/cloud distinction is enforced server-side by tenancy.

Clients never hold a database DSN. The raw Postgres connection is a server-only
concern (`instructions-serve`).

## Data Directory

Local data is stored in `~/.hasna/configs/` (unchanged, for fleet continuity).

## Session Instruction Rendering

`instructions session plan` and `instructions session apply` render
OpenIdentities and instruction sources into provider-native files for Claude,
Codex, Cursor, OpenCode, Codewith, Qwen, aicopilot, and Google Antigravity.
The old Google agent target is removed; Antigravity is the only Google coding
agent render target. Antigravity workspace rules are rendered to
`.agents/rules/*.md`; its current global rules and MCP files use Google's
legacy-named `~/.gemini/GEMINI.md` and `~/.gemini/config/mcp_config.json`
paths but remain owned by the `antigravity` target.

Qwen Code session rendering writes `QWEN.md` instructional context with
`QWEN_HOME` pointing at the rendered profile home. Known config sync also
tracks Qwen Code `QWEN.md` and `settings.json` files at `~/.qwen/...` and
project `QWEN.md` / `.qwen/settings.json`, so native hook settings can be
managed without claiming session-rendered context is hard enforcement.

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

Accepted source layers are `global`, `provider`/`tool`, `account`, `machine`,
`division`, `workspace`, `project`/`repo`, `path`, `identity`/`agent`,
`session`, and `local`. Empty renders fail closed unless `--allow-empty-sources`
is passed. Apply writes generated manifests with file hashes, checks previous
manifests for drift, refuses unmanaged file conflicts unless `--force` is
passed, removes stale managed mirrors only when safe, and writes local snapshots
before mutating managed files.

### Managed project context

`instructions project-context plan|apply` is the sole writer for the strict
`hasna.projects.project_context_bundle.v1` contract emitted by Projects. It
accepts bounded structured JSON from a regular file or stdin and never invokes
Projects, Todos, Conversations, or Mementos while rendering:

```bash
projects context-bundle <project-id> --json > ./project-context.json
instructions project-context plan \
  --runtime codewith \
  --workspace-root /absolute/workspace \
  --bundle ./project-context.json \
  --json
instructions project-context apply \
  --runtime codewith \
  --workspace-root /absolute/workspace \
  --bundle ./project-context.json \
  --json
```

The renderer writes one canonical `.hasna/instructions/project-context.md`
fragment, then a managed import in `CLAUDE.md`, a managed inline block in
`AGENTS.md`, and a managed inline block in `.codewith/CODEWITH.md` by default.
Codewith uses an import only when its existing
`HASNA_CONFIGS_CODEWITH_NATIVE_IMPORTS=1` capability gate is active or
`--codewith-native-imports` explicitly selects that supported runtime mode.
Bytes outside the managed marker pair are preserved. Codewith's
`.codewith/CODEWITH.override.md` takes precedence and causes the stable
`PROJECT_CONTEXT_SHADOWED` failure instead of an ignored write.
Existing Instructions session manifests are updated additively, and later
`instructions session plan|apply` runs recompose the validated durable project
context so routine Claude, Codewith, or Codex rerenders cannot discard it.

Input is limited to 8 KiB, output to 4 KiB and six allowlisted argv commands.
The writer rejects unknown fields, hash/revision inconsistencies, credentials,
URLs, symlinks, malformed or conflicting markers, and older revisions. Applies
use a per-workspace lock, compare-and-swap hashes, same-directory fsynced temp
files and renames, and a metadata-only manifest written last. Existing-file
updates require an atomic exchange primitive (Linux `renameat2` or macOS
`renameatx_np`); unsupported platforms, including Windows, fail closed before
replacement rather than approximating an exchange. A same-project,
compatible last-known-good cache can be selected explicitly with
`--allow-stale-cache --expected-project-id <id>`; its bounded age/status is
visible in the rendered context.

Compatibility remains additive: project-context manifests keep
`hasna.configs.session-render/v1`, `Managed by @hasna/configs`, and
`ownedBy: open-configs`, while recording `canonicalOwner: instructions`. The
legacy `@hasna/configs` 0.2.45 `configs` executable remains available as a bin
alias; no separate Configs repository or flag-day manifest v2 is introduced.

`instructions init` and `bun run seed` also seed
`global-agent-rules-standard`, the managed global/system prompt source for
session renaming, task-scoped worktrees, PR-first landing, protected-branch
push safety, no brittle hardcoding when source-of-truth or reusable abstractions
exist, autonomous repair, Hasna CLI source-of-truth usage, conversation surface
routing, and unbudgeted Codewith goals unless a user asks for budgets.

They also seed `dangerous-operation-guard-standard`, the managed station01 guard
source for risky shell commands, edits, git operations, package installs, and
secret-adjacent access. The guard excludes Gemini CLI, requires Codewith/Codex
`PreToolUse` to hard-deny or inject context rather than ask for approval, uses
`PermissionRequest` for Codewith/Codex approvals, records that Qwen `QWEN.md`
is policy context only, and records native hook or wrapper/plugin fallback
expectations for Claude, Qwen, OpenCode, Cursor, and Antigravity.

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
