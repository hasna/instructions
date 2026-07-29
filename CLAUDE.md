# @hasna/instructions

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
configs session plan --tool codex --profile <name> --source repo:rules=./AGENTS.md
configs project-context plan --runtime codex --workspace-root "$PWD" --bundle ./project-context.json
configs package-manager-scan --fail-on-findings .
configs mcp install --claude    # install MCP server with profile
configs completions zsh         # shell completions
```

The complete, code-audited references are in `docs/cli.md`, `docs/mcp.md`, and
`docs/http-api.md`.

## Architecture

```
src/types/index.ts    — all TypeScript types
src/db/               — SQLite (bun:sqlite): configs, snapshots, profiles, machines
src/lib/              — apply, sync, redact, export/import, template
src/cli/index.tsx     — 33 native top-level commands plus events/webhooks groups
src/mcp/index.ts      — 22 MCP tools (lean schemas + INSTRUCTIONS_PROFILE)
src/server/index.ts   — Hono probes + authenticated Postgres /v1 API
src/index.ts          — library exports
sdk/                  — generated /v1 client plus legacy /api compatibility client
dashboard/            — legacy /api React+Vite client (not current-server compatible)
```

## Key Design Decisions

- **KNOWN_CONFIGS map** — known sync uses curated files/directories, never a recursive home walk
- **Secret redaction** — always redact before storing (key-name + value-pattern matching)
- **Templates** — redacted values become {{VAR}} placeholders, render with `--env` or `--var`
- **Profiles** — named bundles of configs for full-machine setup
- **Snapshots** — auto-versioned on every apply
- **MCP profiles** — INSTRUCTIONS_PROFILE=minimal|standard|full for tool filtering
- **Bootstrap** — one command installs full 12-package ecosystem
- **Drift detection** — get_status MCP tool reports which configs changed on disk
- **Security** — renderer path/symlink guards, loopback MCP, authenticated `/v1`, and secret redaction

## Testing

```bash
bun test
```

## Publishing

```bash
bun run build && npm version patch && bun publish --access public
cd sdk && bun run build && bun publish --access public
```
