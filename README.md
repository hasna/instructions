# @hasna/configs

AI coding agent configuration manager — store, version, apply, and share all your AI coding configs. CLI + MCP + REST API + Dashboard.

[![npm](https://img.shields.io/npm/v/@hasna/configs)](https://www.npmjs.com/package/@hasna/configs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/configs
```

## CLI Usage

```bash
configs --help
configs list                    # compact, paged summary
configs list --verbose          # expanded metadata, still paged
configs list --json             # full machine-readable records
configs show <slug>             # full metadata + content
configs inspect <slug>          # alias for show
configs profile resolve
configs profile apply --auto
```

Collection commands are compact by default to keep agent terminals and context
small. Human output is capped at 20 rows unless you pass `--limit`; use
`--cursor` to continue from the next page. Detail is explicit:

- `--verbose` expands list rows with descriptions, tags, and paths.
- `--json` preserves full machine-readable records for automation.
- `show`/`inspect` and `snapshot show` print full config or snapshot content.

## MCP Server

```bash
configs-mcp
```

Agent-facing MCP tools follow the same gradual disclosure model. `list_configs`
and `list_profiles` return paged compact envelopes by default and accept
`limit`, `cursor`, and `verbose`. `apply_config` and `apply_profile` omit
`previous_content` and `new_content` unless `verbose: true` is passed. Use
`get_config` when full config content is needed.

## HTTP mode

```bash
configs-mcp --http               # http://127.0.0.1:8807/mcp
MCP_HTTP=1 configs-mcp
```

Health: `GET http://127.0.0.1:8807/health`. MCP is also mounted on `configs-serve` at `/mcp`.

## REST API

```bash
configs-serve
```

## Storage Sync

This package supports optional remote storage sync through a package-local Postgres connection:

```bash
export HASNA_CONFIGS_DATABASE_URL=postgres://...
configs storage status
configs storage push
configs storage pull
configs storage sync
```

The MCP server also exposes `storage_status`, `storage_push`, `storage_pull`, and `storage_sync`.

## Data Directory

Data is stored in `~/.hasna/configs/`.

## Machine-aware Profiles

`configs init` now seeds two platform profiles:

- `linux-arm64` for `linux-node-a` / `linux-node-b`
- `macos-arm64` for `macos-node-a` / `macos-node-b`

These profiles resolve machine variables like `{{WORKSPACE_ROOT}}`, `{{BUN_BIN_DIR}}`, `{{BUN_PATH}}`, and `{{PATH_PREFIX}}`, so synced configs can be portable across Linux and macOS arm64 machines.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
