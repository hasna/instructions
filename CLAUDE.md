# open-configs

AI coding agent configuration manager. Store, version, apply, and share all your AI coding configs.

## Quick Reference

```bash
configs list                    # list all stored configs
configs show <slug>             # view content + metadata
configs pull                    # sync known configs from disk → DB
configs push                    # apply DB configs → disk
configs sync --project .        # sync project-scoped configs
configs sync --project <dir> --all  # sync all projects in a workspace
configs diff                    # diff all stored vs disk
configs compare <a> <b>         # diff two stored configs
configs scan --fix              # find + redact secrets
configs status                  # health check (drift detection)
configs doctor                  # validate syntax + permissions
configs init                    # first-time setup
configs watch                   # auto-sync on file changes
configs backup                  # timestamped export
configs restore <file>          # import from backup
configs bootstrap               # install full @hasna ecosystem (12 packages)
configs clean                   # remove orphaned configs
configs update                  # self-update from npm
configs template render <id> --env --apply  # render templates with env vars
configs mcp install --claude    # install MCP server with profile
configs completions zsh         # shell completions
```

## Architecture

```
src/types/index.ts    — all TypeScript types
src/db/               — SQLite (bun:sqlite): configs, snapshots, profiles, machines
src/lib/              — apply, sync, redact, export/import, template
src/cli/index.tsx     — 28 CLI commands (Commander + chalk)
src/mcp/index.ts      — 16 MCP tools (lean stubs + CONFIGS_PROFILE)
src/server/index.ts   — Hono REST API (port 3457, serves dashboard + ?fields=)
src/index.ts          — library exports
sdk/                  — @hasna/instructions-sdk (zero-dep fetch client)
dashboard/            — React+Vite (5 pages)
```

## Key Design Decisions

- **KNOWN_CONFIGS map** — only sync ~30 curated config files, never recursive dir walk
- **Secret redaction** — always redact before storing (key-name + value-pattern matching)
- **Templates** — redacted values become {{VAR}} placeholders, render with `--env` or `--var`
- **Profiles** — named bundles of configs for full-machine setup
- **Snapshots** — auto-versioned on every apply
- **Agent profiles** — CONFIGS_PROFILE=minimal|standard|full for MCP tool filtering
- **Bootstrap** — one command installs full 12-package ecosystem
- **Drift detection** — get_status MCP tool reports which configs changed on disk
- **Security** — path traversal guard, localhost binding, sync dir restriction, secret redaction

## Testing

```bash
bun test              # 140 tests, 0 failures
```

## Publishing

```bash
bun run build && npm version patch && bun publish --access public
cd sdk && bun run build && bun publish --access public
```
