# Storage and sync

The CLI, MCP server, and public library resolve one `ConfigStore` abstraction.
The selected store holds config records, profiles, snapshots, machines, and
feedback; filesystem apply/sync operations still run on the client machine.

## Local SQLite

With no client API variables set, the store is SQLite:

```text
~/.hasna/instructions/instructions.db
```

Set `HASNA_INSTRUCTIONS_DB_PATH` to use another file or `:memory:`. The DB uses
WAL mode and foreign keys. `instructions init --force` closes and removes the
local DB plus WAL/SHM sidecars before rebuilding it.

## API transport

Set both variables to route all store operations through authenticated `/v1`:

```bash
export HASNA_INSTRUCTIONS_API_URL=https://instructions.example.com
export HASNA_INSTRUCTIONS_API_KEY=...
```

Setting exactly one is an error. The client does not fall back to SQLite,
which prevents silent local/cloud divergence. API requests use a 30-second
timeout, bearer authentication, and idempotency keys for create operations.

The server-side Postgres variables are different; see [HTTP
API](http-api.md). A client never needs a database DSN.

## Other path variables

| Variable | Effect |
| --- | --- |
| `CONFIGS_HOME` | Home used to expand `~/` config targets and detect machine paths. Falls back to `HOME`. |
| `HASNA_CONFIGS_HOME` | Raw session-render root. Defaults to `~/.hasna/configs`. |
| `HASNA_INSTRUCTIONS_DB_PATH` | Local SQLite path only. |

`CONFIGS_HOME` and `HASNA_CONFIGS_HOME` are intentionally separate and neither
changes the server DSN.

## Config model

A config has a UUID, unique slug, name, kind, category, agent, optional primary
target path, zero or more transformed outputs, format, content, description,
tags, template flag, version, and timestamps.

Kinds:

- `file`: may be applied to a primary target and fan-out outputs.
- `reference`: stored documentation/policy with no writable target.

Categories are `agent`, `rules`, `mcp`, `shell`, `secrets_schema`, `workspace`,
`git`, and `tools`.

Active agent values are `claude`, `codex`, `opencode`, `cursor`, `codewith`,
`aicopilot`, `antigravity`, `qwen`, `zsh`, `git`, `npm`, and `global`.

Formats are `text`, `json`, `toml`, `yaml`, `markdown`, and `ini`. Fan-out
transforms are `passthrough`, `claude-passthrough`, `codex-flat`,
`opencode-flat`, `cursor-mdc`, and `skill-neutral`.

Updating a config increments its version. Applying changed content over an
existing target stores the prior bytes as a config snapshot before writing.

## Known home config sync

`instructions sync` reads only the curated `KNOWN_CONFIGS` map. It is not a
recursive home-directory crawler.

| Owner | Curated home targets |
| --- | --- |
| Claude | `~/.claude/CLAUDE.md`, settings, local settings, keybindings, `~/.claude/rules/*.{md,mdc}`, `~/.claude.json` |
| Codex | `~/.codex/config.toml`, `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md`, `opencode.json` |
| Cursor | `~/.cursor/rules/*.{md,mdc}`, `~/.cursor/mcp.json` |
| Codewith | `~/.codewith/CODEWITH.md`, `config.toml` |
| AI Copilot | `~/.config/aicopilot/AICOPILOT.md`, `aicopilot.json` |
| Antigravity | `~/.gemini/GEMINI.md`, `~/.gemini/config/mcp_config.json` |
| Qwen | `~/.qwen/QWEN.md`, `~/.qwen/settings.json` |
| Shell | `~/.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile` |
| Git | `~/.gitconfig`, `~/.gitignore_global` |
| Package tools | `~/.npmrc`, `~/.bunfig.toml` |

Many provider-specific files are optional. Missing optional paths are skipped
without making `doctor` fail.

Claude's global prompt is the canonical fan-out source for Codex, Codewith,
OpenCode, AI Copilot, Antigravity, Cursor, and Qwen outputs. Generated targets
are not re-ingested when their source exists. Claude rule files also fan out to
Cursor MDC files.

Before storage, sync redacts secret-like content and templateizes detected
machine paths. Existing records are matched by target path or generated slug.
Files over 500 KiB are skipped by project sync.

## Project sync

`instructions sync --project <dir>` considers these project-relative files:

- `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`,
  `.mcp.json`, and `.claude/rules/*.{md,mdc}`;
- `AGENTS.md` and `.codex/AGENTS.md`;
- `.opencode/AGENTS.md`;
- `.codewith/CODEWITH.md`;
- `AICOPILOT.md` and `.aicopilot/AICOPILOT.md`;
- `.cursor/mcp.json`;
- `QWEN.md` and `.qwen/settings.json`;
- `.agents/mcp_config.json` and `.agents/rules/*.{md,mdc}`.

`--project --all` checks immediate child directories of the selected directory
when they contain one of the CLI's provider marker paths; it does not recurse
arbitrarily deep.

The full-profile MCP `sync_directory` tool is a separate legacy recursive
directory import/export facility. Prefer known or project sync for predictable
scope.

## Apply safety

Apply:

- refuses reference configs and retired/unsupported provider rows;
- expands and normalizes targets before ownership comparisons;
- rejects duplicate profile writers instead of choosing an arbitrary one;
- deduplicates equivalent profile configs, preferring the newest identical
  source;
- refuses generated fan-out targets when their canonical source should be
  applied;
- skips session-renderer-owned targets unless the single-config CLI uses the
  explicit `--allow-renderer-owned` opt-in;
- enforces Antigravity's 12,000-character Markdown rule-file limit;
- creates parent directories and snapshots previous bytes.

`--force` is not a synonym for renderer ownership. Session-owned writes require
their separate explicit opt-in.

## Templates and secrets

Secret detection covers secret-like key names and known token formats. Redacted
values become `{{VAR_NAME}}` placeholders, except npm auth entries, which use
npm's runtime `${NPM_TOKEN}` reference.

Template rendering accepts explicit variables and, when requested, environment
variables. Normal writes fail on unresolved placeholders. Machine-aware profile
dry-runs preserve unresolved runtime/secret references so previews remain safe.

For package-manager files, use the narrower guard:

```bash
instructions package-manager-scan --fail-on-findings .
instructions package-manager-scan --home --fail-on-findings .
```

It reports only path, line, rule, surface, tracked state, severity, and a safe
detail string. It never prints detected credential values. Bun release-age
exclusions must be exact `@hasna/<package>` names; wildcards and third-party
exclusions are findings.
