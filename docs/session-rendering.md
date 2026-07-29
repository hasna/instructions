# Session instruction rendering

`instructions session plan|apply` composes instruction sources into
provider-native files. It is separate from config `apply`: the session renderer
owns the files it generates, records their hashes in a manifest, and takes
rollback snapshots before mutations.

## Source inputs

Sources can come from:

- `--source <layer:id=path>` for a regular file;
- `--config <layer:id-or-slug>` for a stored config;
- `--identity-export <path>` for either supported OpenIdentities export shape.

Each option is repeatable. A source without an explicit layer defaults to
`agent`; a stored global-agent config defaults to `global`.

OpenIdentities exports must identify either
`hasna.identities.configs-instructions/v1` or the canonical version-1
`@hasna/identities` shape. Provider filters, source paths, nested rules,
ownership, hashes, provenance, merge policy, and non-overridable state are
preserved. Required source paths must exist below the export directory and may
not escape it through absolute paths or symlinks.

Empty sources and an entirely empty render fail unless
`--allow-empty-sources` is explicit.

## Layer order

Sources render from lowest to highest precedence:

1. `global`
2. `tool` (`provider` alias)
3. `account`
4. `machine`
5. `division`
6. `workspace`
7. `repo` (`project` alias)
8. `path`
9. `agent` (`identity` alias)
10. `session`
11. `local`

Within a layer, explicit order then source ID determines stable ordering.
`--replace-source <id>` marks the named source as `replace`. Composition starts
at the last ordered replace source while retaining earlier non-overridable
sources.

Provider-only HTML marker blocks are filtered for the selected tool. Duplicate
source slugs, duplicate nested rule paths, malformed markers, and conflicting
same-version managed operating rules are rejected. Managed operating rules are
also checked against the embedded currency floor regardless of whether they
arrived from a file, stored config, or identity export.

## Targets and adapters

The default profile target is:

```text
${HASNA_CONFIGS_HOME:-~/.hasna/configs}/sessions/<tool>/<profile>/<session-id-or-latest>
```

`--target-home` overrides it for profile-scoped tools. Cursor and Antigravity
are project-scoped and require `--project-root`; `--target-home` is not accepted
as a substitute for their repository root.

| Tool | Mode | Managed output | Environment returned by the plan |
| --- | --- | --- | --- |
| Claude | native imports | `CLAUDE.md`, `.hasna/instructions/*.md` | `CLAUDE_CONFIG_DIR` |
| Codex | flattened Markdown | `AGENTS.md` | `CODEX_HOME` |
| Codewith | flattened by default | `CODEWITH.md` | `CODEWITH_HOME` |
| Cursor | project MDC | `.cursor/rules/*.mdc` | none |
| OpenCode | config + fragments | `AGENTS.md`, `opencode.json`, `.hasna/instructions/*.md` | `OPENCODE_CONFIG_DIR` |
| Qwen | flattened Markdown | `QWEN.md` | `QWEN_HOME` |
| AI Copilot | flattened Markdown | `AICOPILOT.md` | `AICOPILOT_CONFIG_DIR` |
| Antigravity | project rules | `.agents/rules/*.md` | none |

Codewith native imports are selected by `--codewith-native-imports` or
`HASNA_CONFIGS_CODEWITH_NATIVE_IMPORTS=1|true`. Native mode writes managed
fragments below `.hasna/instructions` and imports them from `CODEWITH.md`.

OpenCode preserves existing non-managed `instructions` entries. If a profile
contains OpenCode config rows, the newest equivalent provider config is used;
conflicting provider configs fail.

Cursor generates always-applied MDC files and honors nested-rule globs.
Antigravity generates numbered Markdown files and rejects any generated rule
over 12,000 characters.

Every successful plan also contains
`.hasna/session-render-manifest.json`. JSON CLI output omits generated file
content but retains paths, roles, hashes, source IDs, provenance, warnings, and
ownership metadata.

## Plan and apply

`session plan` never writes. `session apply --dry-run` runs the same conflict
and drift checks without writing.

Before a real apply, the renderer:

1. rejects blocked plans, unsafe roots, filesystem roots, and symlinked path
   segments;
2. reads the previous compatible manifest and checks its recorded files for
   missing/hash-mismatch drift;
3. rejects existing unmanaged files unless `--force` adopts them;
4. rejects changed stale managed files unless `--force` permits removal;
5. writes a version-2 snapshot when there are before-images;
6. writes provider files, removes safe stale files, and writes the manifest
   last.

Files are compared again immediately before mutation, so a path changed after
planning fails rather than being overwritten. Managed writes coordinate with
the project-context lock when durable project context is present.

Snapshots are stored below `.hasna/session-render-snapshots/`, use mode 0600,
and include before-images plus the expected post-apply state.

## Restore

```bash
instructions session restore <snapshot> --dry-run
instructions session restore <snapshot>
```

Restore accepts supported v1/v2 snapshot schemas, validates all paths and
hashes, and refuses to write if any applied file has drifted from the state the
snapshot expects. The snapshot must be a regular file inside its target home
and no larger than 32 MiB. A dry run reports actions but sets `restored: false`.

## Ownership boundary

Regular config apply and `sync --to-disk` skip session-renderer-owned targets.
Ownership comes from:

- exclusive managed directories defined by the adapters;
- the render manifest and snapshot locations;
- files claimed by an ancestor target home's session manifest;
- provider entrypoints reserved for current or legacy renderer output.

`.cursor/rules` is shared with config fan-out, so the directory is not reserved
as a whole; only manifest-claimed Cursor files are protected.

Single-config CLI apply can cross the boundary only with
`--allow-renderer-owned`. That opt-in is deliberately separate from `--force`.

## Durable project context

When a compatible managed project-context manifest exists, later Claude,
Codex, or Codewith session renders recompose its canonical fragment into the
new plan and use the project-context lock during apply. The reserved source ID
`project-context-bundle` cannot be supplied as an ordinary session source. See
[Project context](project-context.md).
