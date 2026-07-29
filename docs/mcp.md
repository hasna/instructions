# MCP reference

The package installs `instructions-mcp` and the `configs-mcp` alias. The server
identity and registration name remain `configs` for fleet compatibility.

## Transports

The MCP binary defaults to Streamable HTTP on loopback:

```bash
instructions-mcp                    # http://127.0.0.1:8853/mcp
instructions-mcp --port 9000
MCP_HTTP_PORT=9000 instructions-mcp
```

`GET /health` returns `{ "status": "ok", "name": "configs" }`. `/mcp` is
the only MCP route. The process binds to `127.0.0.1`; it is not mounted on
`instructions-serve`.

Use explicit stdio when an MCP client launches the process:

```bash
instructions-mcp --stdio
MCP_STDIO=1 instructions-mcp
```

The current `instructions mcp install` and `instructions-mcp --claude`
registration helpers do not append `--stdio`, although they register a stdio
transport. Until those helpers are changed, add `--stdio` to the client args or
register the MCP command manually.

`--http` or `MCP_HTTP=1` also selects HTTP, although HTTP is already the
default. Port precedence is `--port`, then `MCP_HTTP_PORT`, then 8853.

## Tool profiles

Set `INSTRUCTIONS_PROFILE` before the process starts. An unknown value behaves
like `full`.

| Profile | Tools | Intended use |
| --- | ---: | --- |
| `minimal` | 3 | Orientation, one-config reads, and known-file sync. |
| `standard` | 13 | Normal config/profile management with gradual disclosure. |
| `full` | 22 | Every tool, including legacy directory sync and ephemeral agent state. |

### Minimal

`get_status`, `get_config`, `sync_known`

### Standard

`list_configs`, `get_config`, `create_config`, `update_config`, `apply_config`,
`sync_known`, `get_status`, `render_template`, `scan_secrets`, `list_profiles`,
`apply_profile`, `search_tools`, `describe_tools`

### Full-only additions

`delete_config`, `sync_directory`, `get_snapshot`, `sync_project`,
`register_agent`, `heartbeat`, `set_focus`, `list_agents`, `send_feedback`

## Tool schemas

MCP responses contain one text item whose text is JSON. Tool failures set
`isError: true` and return `{ "error": "..." }` in that text item.

### Configs

| Tool | Input |
| --- | --- |
| `list_configs` | `category?`, `agent?`, `kind?`, `search?`, `limit?`, `cursor?`, `verbose?` |
| `get_config` | `id_or_slug` (required) |
| `create_config` | `name`, `content`, `category` (required); `agent?`, `target_path?`, `outputs?`, `kind?`, `format?`, `tags?`, `description?`, `is_template?` |
| `update_config` | `id_or_slug` (required); `content?`, `name?`, `tags?`, `description?`, `category?`, `agent?`, `target_path?`, `outputs?` |
| `delete_config` | `id_or_slug` (required) |
| `apply_config` | `id_or_slug` (required), `dry_run?`, `verbose?` |

`list_configs` returns a paged compact envelope and omits content. Set
`verbose: true` for tags/output targets or call `get_config` for the complete
record. `apply_config` uses the same session-renderer ownership gate as the CLI
and reports owned targets in `skipped`. `verbose` controls whether apply
results include previous/new content.

### Sync and status

| Tool | Input |
| --- | --- |
| `get_status` | none |
| `sync_known` | `agent?`, `category?` |
| `sync_project` | `project_dir?` (defaults to process cwd) |
| `sync_directory` | `dir` (required), `direction?` (`from_disk` default or `to_disk`) |

`get_status` is the compact MCP orientation payload, not the larger CLI
`status --json` contract. It reports total/category counts, template count,
drift/missing counts, up to five drifted slugs, and the DB path.

`sync_directory` recursively imports or exports an arbitrary directory and is
kept only in the full profile. Prefer the curated `sync_known` or
`sync_project` tools for routine use.

### Profiles and snapshots

| Tool | Input |
| --- | --- |
| `list_profiles` | `limit?`, `cursor?`, `verbose?` |
| `apply_profile` | `id_or_slug?`, `auto?`, `dry_run?`, `hostname?`, `os?`, `arch?`, `verbose?` |
| `get_snapshot` | `config_id_or_slug` (required), `version?` |

`apply_profile` requires an ID unless `auto: true`. Machine overrides affect
profile selection and variable rendering. Compact apply results omit content;
set `verbose: true` for full results. `get_snapshot` returns the requested
version or, when omitted, the latest snapshot.

### Templates and secret scanning

| Tool | Input |
| --- | --- |
| `render_template` | `id_or_slug` (required), `vars?` object, `use_env?` |
| `scan_secrets` | `id_or_slug?`, `fix?`, `limit?`, `cursor?` |

Secret scan output includes slugs, counts, and variable names, never secret
values. With no ID, the MCP implementation scans all file configs. `fix: true`
updates matching configs to redacted templates.

### Tool discovery

| Tool | Input |
| --- | --- |
| `search_tools` | `query` (required) |
| `describe_tools` | `names?` array; omit for all descriptions |

Discovery descriptions cover the config-oriented tools. The full-profile
agent and feedback tools have only their lean schema descriptions.

### Ephemeral agent state and feedback

| Tool | Input |
| --- | --- |
| `register_agent` | `name` (required), `session_id?` |
| `heartbeat` | `agent_id` (required) |
| `set_focus` | `agent_id` (required), `project_id?` |
| `list_agents` | none |
| `send_feedback` | `message` (required), `email?`, `category?` (`bug`, `feature`, or `general`) |

The agent registry is an in-memory map inside one MCP process. It is not stored
in SQLite/Postgres, and `session_id` is accepted by the schema but is not
retained by the current implementation. Feedback uses the active config store.

## Storage selection

MCP tools use the same store resolution as the CLI:

- neither API variable set: local SQLite;
- both `HASNA_INSTRUCTIONS_API_URL` and `HASNA_INSTRUCTIONS_API_KEY` set:
  authenticated `/v1` API;
- exactly one set: startup/tool use fails instead of silently using local data.

Filesystem operations still happen on the machine running the MCP process.
