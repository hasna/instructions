# CLI reference

The package installs `instructions` and the backward-compatible `configs`
alias. Both invoke the same Commander program. Examples below use
`instructions`.

```text
instructions [options] <command>

-V, --version  print the package version
-h, --help     display help
```

`<id>` arguments accept a config or profile UUID or slug unless a command says
otherwise. Destructive commands do not prompt.

## Output and pagination

Collection commands use compact human output and cap it at 20 rows by default.
Use `--limit <n>` and the reported zero-based `--cursor <n>` to page. `--json`
returns full records where offered. `list --verbose` and `profile list
--verbose` expand metadata but remain paged.

Large JSON and content output is written synchronously so piping it to tools
such as `jq` does not truncate it.

## Config commands

### `list` (`ls`)

```text
instructions list [options]
```

- `-c, --category <cat>`
- `-a, --agent <agent>`
- `-k, --kind <kind>` (`file` or `reference`)
- `-t, --tag <tag>`
- `-s, --search <query>` (name, description, and content)
- `-f, --format <fmt>` (`compact`, `table`, or `json`; default `compact`)
- `--brief`, `--verbose`, `--json`
- `--limit <n>`, `--cursor <n>`

### `show` (`inspect`)

```text
instructions show <id> [-f, --format <table|json|content>]
```

The default prints metadata followed by full content. `content` prints only the
stored bytes.

### `add`

```text
instructions add <path> [options]
```

- `-n, --name <name>`
- `-c, --category <cat>`
- `-a, --agent <agent>`
- `-k, --kind <file|reference>` (default `file`)
- `--template`

The file is read, secrets are redacted, category/agent/format are detected when
not overridden, and a home-relative target path is stored when possible.

### `delete` (`rm`)

```text
instructions delete <id> [--json]
```

Deletes the database record and its cascaded links/snapshots. It does not
delete the target file.

### `apply`

```text
instructions apply <id> [--dry-run] [--force] [--allow-renderer-owned]
```

Applies the primary target and configured fan-out outputs. Session-renderer
owned targets are skipped unless `--allow-renderer-owned` is passed. `--force`
is accepted by current CLI help but is not forwarded by this command; it does
not bypass ownership or otherwise change the write.

### `diff`

```text
instructions diff [id] [--all]
```

With an ID, compares that stored config with disk. With no ID, it examines all
file configs; `--all` is accepted as an explicit spelling of that mode.

### `compare`

```text
instructions compare <a> <b>
```

Prints a line-oriented comparison of two stored configs.

### `clean`

```text
instructions clean [--dry-run] [--limit <n>]
```

Deletes file-kind records whose target paths no longer exist. Always preview
with `--dry-run` when the missing files may be temporary.

## Sync commands

### `sync`

```text
instructions sync [options]
```

- `-a, --agent <agent>`
- `-c, --category <cat>`
- `-p, --project [dir]`
- `--all` (with `--project`, inspect immediate subdirectories)
- `--to-disk`
- `--dry-run`
- `--list`, `--limit <n>`, `--cursor <n>`

Without `--project` or `--to-disk`, reads the curated known-file map into the
store. `--to-disk` writes stored configs back through the apply ownership gate.
`--project` ingests supported project files and rule directories. `--list`
prints the curated home targets without syncing.

### `pull`

```text
instructions pull [-a, --agent <agent>] [--dry-run]
```

Alias workflow for known-file sync from disk to the store.

### `push`

```text
instructions push [-a, --agent <agent>] [--dry-run]
```

Alias workflow for known-file sync from the store to disk.

### `watch`

```text
instructions watch [-i, --interval <ms>]
```

Polls known files for changes and runs known-file sync. The default interval is
3000 ms. The long-running process stops only when interrupted.

## Profiles

```text
instructions profile <command>
```

- `list [--brief] [-f, --format <compact|table|json>] [--verbose] [--json]
  [--limit <n>] [--cursor <n>]`
- `create <name> [-d, --description <desc>] [--os <csv>] [--arch <csv>]
  [--hostname <csv>] [--var <KEY=VALUE...>]`
- `show <id> [--limit <n>] [--cursor <n>]`
- `add <profile> <config>`
- `remove <profile> <config>`
- `apply [id] [--dry-run] [--auto] [--hostname <value>] [--os <value>]
  [--arch <value>]`
- `resolve [--hostname <value>] [--os <value>] [--arch <value>]`
- `delete <id>`

Auto resolution considers only profiles with selectors. Hostname matches score
higher than OS/architecture matches; ties sort by profile name. Profile
variables render target paths and content during apply.

## Snapshots, templates, and archives

### `snapshot`

```text
instructions snapshot list <config> [--limit <n>] [--cursor <n>]
instructions snapshot show <id>
instructions snapshot restore <config> <snapshot-id>
```

Config snapshots are created automatically before a changed existing target is
overwritten. Restore updates the stored config content; it does not write the
target file.

### `template`

```text
instructions template vars <id>
instructions template render <id> [--var <KEY=VALUE...>] [--env] [--apply] [--dry-run]
```

Without `--apply` or `--dry-run`, `render` prints the rendered content. A dry
run previews the target write. Missing variables fail normal apply; profile
apply dry-runs preserve unresolved runtime/secret references in the preview.

### `export` and `import`

```text
instructions export [-o, --output <path>] [-c, --category <cat>]
instructions import <file> [--overwrite]
```

The export default is `./configs-export.tar.gz`. Import skips matching configs
unless `--overwrite` is supplied.

### `backup` and `restore`

```text
instructions backup
instructions restore <file> [--overwrite]
```

`backup` writes a timestamped archive below
`~/.hasna/instructions/backups/`. `restore` uses the same archive format as
`import`.

## Session rendering

```text
instructions session plan --tool <tool> --profile <profile> [options]
instructions session apply --tool <tool> --profile <profile> [options]
instructions session restore <snapshot> [--dry-run] [--json]
```

`plan` and `apply` share these options:

- `--target-home <path>`
- `--project-root <path>`
- `--session-id <id>`
- `--source <layer:id=path>` (repeatable)
- `--config <layer:id-or-slug>` (repeatable)
- `--identity-export <path>` (repeatable)
- `--replace-source <id>` (repeatable)
- `--codewith-native-imports`
- `--allow-empty-sources`
- `--json`

`apply` additionally accepts `--dry-run` and `--force`. `--force` adopts or
overwrites unmanaged files and permits removal of changed stale managed files;
it does not disable path or symlink guards. See [Session
rendering](session-rendering.md).

Supported tools are `claude`, `codex`, `cursor`, `opencode`, `codewith`,
`qwen`, `aicopilot`, and `antigravity`. Layer aliases are `provider` →
`tool`, `project` → `repo`, and `identity` → `agent`.

## Managed project context

```text
instructions project-context plan \
  --runtime <claude|codewith|agents|codex> \
  --workspace-root <absolute-path> \
  --bundle <path|-> \
  [--codewith-native-imports] [--json]

instructions project-context apply \
  --runtime <claude|codewith|agents|codex> \
  --workspace-root <absolute-path> \
  [--bundle <path|->] \
  [--expected-project-id <id>] [--allow-stale-cache] \
  [--max-stale-age-seconds <seconds>] [--codewith-native-imports] \
  [--force] [--dry-run] [--json]
```

`codex` is normalized to the `agents` runtime. `--bundle -` reads bounded JSON
from stdin. Stale-cache fallback requires `--allow-stale-cache` and the same
project ID. See [Project context](project-context.md).

## Secret checks

### `scan`

```text
instructions scan [id] [--fix] [--all] [-c, --category <cat>] [--limit <n>]
```

With no ID or `--all`, scans the known config set. `--all` scans every file
config. Findings include variable names and line numbers, never values.

### `package-manager-scan`

```text
instructions package-manager-scan [paths...] [--home] [--fail-on-findings]
  [--json] [--limit <n>]
```

When no path is supplied, the current directory is scanned. `--home` also
checks home package-manager files and shell profiles. `--fail-on-findings` sets
a nonzero exit code for CI.

## MCP registration

```text
instructions mcp install|add [--claude] [--codex] [--antigravity] [--all]
  [--profile <minimal|standard|full>]
instructions mcp uninstall|remove [--claude] [--all]
```

Install defaults to the `standard` MCP profile and writes/registers a server
named `configs`. The current installer writes no `--stdio` argument even though
the MCP binary now defaults to HTTP; for a stdio client, add `--stdio` to the
registered server arguments or register the command manually. Current
uninstall behavior removes only the Claude
registration, including when `--all` is supplied; Codex and Antigravity entries
must be removed from their config files separately.

The `instructions-mcp`/`configs-mcp` binary has its own transport flags:

```text
instructions-mcp [--http] [--port <n>|--port=<n>]
instructions-mcp --stdio
instructions-mcp --claude
```

HTTP is the default. `--claude` runs the direct Claude registration helper and
exits. See [MCP reference](mcp.md).

## Setup, diagnostics, and maintenance

- `init [--force]` syncs known configs, seeds managed reference configs,
  creates `my-setup`, and ensures platform profiles. `--force` wipes the local
  SQLite DB and is refused in API mode.
- `status [--json]` reports the metadata-only status contract, including drift,
  missing targets, unredacted findings, retired-agent rows, and counts.
- `whoami` prints active storage and a compact category/profile summary.
- `doctor` checks known paths, JSON syntax, and stored secret findings.
- `report [--json] [--markdown]` prints an ecosystem summary. Both format flags
  are accepted by current help, but the current implementation always emits
  the human report.
- `completions [zsh|bash]` emits a completion script. Omitted shell defaults to
  zsh; values other than `zsh` use the bash branch. The generated command list
  covers the older core subset and does not include every current command.
- `update [--check]` reads the latest npm version; without `--check`, it runs a
  global Bun install when an update exists.
- `feedback <message> [-e, --email <email>] [-c, --category <cat>]` stores
  feedback locally or sends it through the active `/v1` store.
- `bootstrap [--dry-run] [--skip-mcp]` globally installs the hard-coded Hasna
  ecosystem package list, optionally registers their MCP servers in Claude,
  and runs known-config initialization.

## Events and webhooks

The pinned `@hasna/events` integration adds these groups. Its data defaults to
`~/.hasna/events` and is independent of the config store.

```text
instructions events emit <type> [--source <source>] [--subject <subject>]
  [--severity <severity>] [--message <message>] [--dedupe-key <key>]
  [--data <json>] [--metadata <json>] [--no-deliver] [--no-dedupe] [-j, --json]
instructions events list [--source <source>] [--type <type>] [--limit <n>]
  [-j, --json]
instructions events replay [--id <id>] [--source <source>] [--type <type>]
  [--dry-run] [-j, --json]
```

```text
instructions webhooks add <target> --id <id> [--transport <webhook|command>]
  [--name <name>] [--type <pattern>] [--source <pattern>]
  [--subject <pattern>] [--severity <pattern>] [--secret <secret>]
  [--header <name=value...>] [--arg <arg...>] [--timeout-ms <ms>]
  [--retry-attempts <n>] [--retry-backoff-ms <ms>] [--redact <path...>]
  [--disabled] [-j, --json]
instructions webhooks list [-j, --json]
instructions webhooks remove <id> [-j, --json]
instructions webhooks test <id> [--type <type>] [--subject <subject>]
  [--message <message>] [--data <json>] [-j, --json]
```

Webhook secrets are accepted on input but redacted from list output by the
events package.
