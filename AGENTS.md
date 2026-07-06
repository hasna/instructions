# AGENTS.md — How AI Agents Should Use @hasna/instructions

## MCP Setup

```bash
configs mcp install --claude --profile standard  # 13 tools
configs mcp install --claude --profile minimal    # 3 tools (lowest context cost)
```

## Quick Reference — MCP Tools

| Tool | Profile | What it does |
|------|---------|-------------|
| `get_status` | minimal | Orientation: total configs, drifted count, templates, DB path |
| `get_config` | minimal | Get full config content by id or slug |
| `sync_known` | minimal | Pull known configs from disk into DB |
| `list_configs` | standard | List configs with category/agent/kind/search filters |
| `create_config` | standard | Store a new config |
| `update_config` | standard | Update content/tags/metadata |
| `apply_config` | standard | Write config to its target_path on disk |
| `render_template` | standard | Fill {{VAR}} placeholders with real values |
| `scan_secrets` | standard | Audit for unredacted secrets (optionally fix) |
| `list_profiles` | standard | List named config bundles |
| `apply_profile` | standard | Apply all configs in a profile to disk |
| `search_tools` | standard | Keyword search across tool descriptions |
| `describe_tools` | standard | Get full docs for specific tools |
| `sync_directory` | full | Sync an arbitrary directory (legacy) |
| `get_snapshot` | full | Get historical version of a config |

## Workflows

### Session Start — Check Config Health
```
1. get_status → check drifted count
2. If drifted > 0: sync_known → pull latest from disk
3. get_config("agent-workflow-template") → load canonical workflow
```

### Restore Secrets on New Machine
```
1. Import backup: configs import backup.tar.gz (CLI)
2. render_template("npmrc", use_env=true) → fills {{NPM_AUTH_TOKEN}} from env
3. apply_config("npmrc") → writes to ~/.npmrc
```

### Sync Project Configs
```
1. sync_known(agent="claude") → sync all Claude Code configs
2. Or via CLI: configs sync --project /path/to/repo
```

### Audit for Leaked Secrets
```
1. scan_secrets() → returns findings with var names and line numbers
2. scan_secrets(fix=true) → redacts in-place, converts to templates
```

## Config Categories

| Category | What's stored |
|----------|--------------|
| `agent` | settings.json, keybindings.json, config.toml |
| `rules` | CLAUDE.md, AGENTS.md, GEMINI.md, rules/*.md |
| `mcp` | ~/.claude.json (MCP server entries) |
| `shell` | .zshrc |
| `git` | .gitconfig |
| `tools` | .npmrc |
| `secrets_schema` | Shape of .secrets (keys only, no values) |
| `workspace` | Directory structure conventions |

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `CONFIGS_DB_PATH` | `~/.configs/configs.db` | Database location |
| `CONFIGS_PROFILE` | `full` | MCP tool profile (minimal/standard/full) |
| `CONFIGS_PORT` | `3457` | REST API port |
| `CONFIGS_HOST` | `localhost` | REST API bind address |
| `CONFIGS_URL` | `http://localhost:3457` | SDK base URL |

## Secret Redaction

Configs automatically redacts secrets before storing. Patterns detected:
- Key names: `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, `*_AUTH*`
- Value patterns: npm tokens, GitHub tokens, Anthropic/OpenAI keys, AWS keys, JWTs, Slack tokens

Redacted values become `{{VAR_NAME}}` template placeholders. Use `render_template` with `use_env=true` to fill them from environment variables.

## Constraints

- DB is SQLite at `~/.configs/configs.db` (~4KB for 50 configs)
- Only syncs ~30 known config files (not recursive directory walks)
- REST server binds to localhost by default (security)
- Path traversal blocked on all endpoints
- `POST /api/sync` restricted to home directory paths
