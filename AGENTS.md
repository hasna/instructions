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
| `delete_config` | full | Delete a config by id or slug |
| `sync_directory` | full | Sync an arbitrary directory (legacy) |
| `sync_project` | full | Sync curated project-scoped config files |
| `get_snapshot` | full | Get historical version of a config |
| `register_agent`, `heartbeat`, `set_focus`, `list_agents` | full | Ephemeral in-process agent state |
| `send_feedback` | full | Store feedback through the active store |

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
2. Keep ~/.npmrc env-backed: //registry.npmjs.org/:_authToken=${NPM_TOKEN}
3. Load NPM_TOKEN from the shell, CI secret store, or an approved vault at runtime
4. Run configs package-manager-scan --home --fail-on-findings before committing
```

Do not render or write a literal npm token into `~/.npmrc`. The safe home
credential flow stores only the scoped registry line plus `${NPM_TOKEN}` and
keeps the token value in the runtime environment or secret manager.

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
| `rules` | CLAUDE.md, AGENTS.md, AICOPILOT.md, .agents/rules/*.md, rules/*.md |
| `mcp` | ~/.claude.json (MCP server entries) |
| `shell` | .zshrc |
| `git` | .gitconfig |
| `tools` | .npmrc |
| `secrets_schema` | Shape of .secrets (keys only, no values) |
| `workspace` | Directory structure conventions |

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `HASNA_INSTRUCTIONS_DB_PATH` | `~/.hasna/instructions/instructions.db` | Local SQLite location |
| `INSTRUCTIONS_PROFILE` | `full` | MCP tool profile (minimal/standard/full) |
| `MCP_HTTP_PORT` | `8853` | Loopback MCP HTTP port |
| `INSTRUCTIONS_PORT` | `3457` | HTTP API server port (`PORT` takes priority) |
| `INSTRUCTIONS_HOST` | `localhost` | HTTP API bind address (`HOST` takes priority) |
| `HASNA_INSTRUCTIONS_API_URL` | unset | Client `/v1` base URL; requires the API key too |
| `HASNA_INSTRUCTIONS_API_KEY` | unset | Client bearer key; requires the API URL too |
| `HASNA_CONFIGS_HOME` | `~/.hasna/configs` | Session-render storage root |

## Secret Redaction

Configs automatically redacts secrets before storing. Patterns detected:
- Key names: `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, `*_AUTH*`
- Value patterns: npm tokens, GitHub tokens, Anthropic/OpenAI keys, AWS keys, JWTs, Slack tokens

Redacted values become `{{VAR_NAME}}` template placeholders, except `.npmrc`
auth tokens, which are converted to npm's `${NPM_TOKEN}` environment reference
so home and repo package-manager configs do not store literal tokens.

## Package-Manager Secret Guard

Use `configs package-manager-scan --fail-on-findings .` in repo CI or
pre-commit hooks. Add `--home` for local operator checks. The guard scans repo
`.npmrc`, home `.npmrc`, Bun config, lockfiles, and shell profiles, and prints
only paths, line numbers, rule names, surfaces, and tracked status.

Bun release-age quarantine must remain enabled. `minimumReleaseAgeExcludes`
should contain only exact `@hasna/<package>` names; do not use wildcard or
third-party excludes.

## Constraints

- Local DB is SQLite at `~/.hasna/instructions/instructions.db` by default.
- Known sync uses a curated set of files and rule directories, not a recursive
  home-directory walk.
- MCP HTTP binds to `127.0.0.1`; `instructions-serve` binds to localhost unless
  configured otherwise.
- `instructions-serve` exposes authenticated `/v1`, not the removed `/api`
  surface, and does not mount MCP.
- Session/project renderers reject path escapes and symlinked managed paths.
