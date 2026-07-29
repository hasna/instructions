# Managed project context

`instructions project-context` is the sole writer for the strict
`hasna.projects.project_context_bundle.v1` bundle emitted by Projects. It
validates bounded JSON and renders durable project identity into Claude,
Codewith, or Codex instruction files without invoking Projects, Todos,
Conversations, or Mementos itself.

## Typical workflow

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

`--bundle -` reads stdin. Input is capped at 8 KiB before JSON parsing. The
workspace root must be an existing absolute non-root directory with no symlink
ancestors.

## Strict bundle contract

Unknown fields are rejected. A v1 bundle contains:

- schema, strict timestamp, canonical SHA-256 hash, monotonic revision, and
  freshness;
- resolution source/conflict/create state;
- Projects authority mode, storage, and availability;
- project ID, slug, name, kind, status, optional absolute path, and update time;
- consistent Todos, Conversations, and Mementos link states;
- optional station/machine IDs;
- at most six allowlisted Projects commands.

Allowed project kinds are `open-source`, `internal-app`, `platform`,
`company-website`, `scaffold`, `community`, `project`, `experiment`, `docs`,
`remote-only`, and `generic`. Project status is `active`, `archived`, or
`deleted`.

Every command must be exactly:

```text
projects <show|context|why|context-bundle> <same-project-id> --json
```

The parser verifies the canonical hash, revision shape (`rev-N`/numeric or a
timestamp), link consistency, identity consistency, and timestamps. It rejects
URLs, environment interpolation, credential-like keys, known secret formats,
unsafe command arguments, and resolution conflicts.

## Outputs

All runtimes write the canonical fragment:

```text
.hasna/instructions/project-context.md
```

Runtime entrypoints are:

| Runtime option | Normalized runtime | Entrypoint |
| --- | --- | --- |
| `claude` | `claude` | `CLAUDE.md` native import |
| `codewith` | `codewith` | `.codewith/CODEWITH.md` managed block, or native import when gated |
| `agents` | `agents` | `AGENTS.md` managed block |
| `codex` | `agents` | `AGENTS.md` managed block |

Codewith native imports require `--codewith-native-imports` or
`HASNA_CONFIGS_CODEWITH_NATIVE_IMPORTS=1|true`. An existing
`.codewith/CODEWITH.override.md` causes `PROJECT_CONTEXT_SHADOWED`, because it
would hide the managed `CODEWITH.md` content.

The renderer preserves all bytes outside its marker pair. It also writes:

- `.hasna/project-context-manifest.json` (0600, committed last);
- `.hasna/project-context-cache.json` (0600);
- a compatible session render manifest;
- metadata snapshots below `.hasna/project-context-snapshots/` when replacing
  previous managed context.

Generated context is capped at 4 KiB and approximately 1,000 tokens. Commands
are removed from the end until the bounded fragment fits; core identity that
cannot fit fails. At most three warnings are emitted.

Compatibility metadata deliberately retains
`hasna.configs.session-render/v1`, `Managed by @hasna/configs`, legacy package
`@hasna/configs` 0.2.45, executable `configs`, and `ownedBy: open-configs`, while
also recording `canonicalOwner: instructions`.

## Apply guarantees

A real apply takes a per-workspace lock and uses compare-and-swap hashes for
every observed managed file. It retries one complete plan when files race, then
fails with `PROJECT_CONTEXT_HASH_RACE`.

Writes use same-directory prepared files, fsync, and rename. Replacing an
existing file requires an atomic exchange primitive (`renameat2` on supported
Linux or `renameatx_np` on macOS). Platforms without safe exchange can create
new files but fail closed before replacing existing ones. Windows therefore
cannot replace an existing managed file with the current implementation.

The manifest is written only after the fragment, entrypoint, cache, and session
compatibility manifest have been re-read and matched to their planned hashes.
Symlinks, path escapes, non-regular managed files, unusable prepared-file modes,
and unreadable prepared files are rejected.

Incoming revisions may not be older than the manifest, cache, or managed
marker. Equal revisions must have equal hashes. `--force` repairs/adopts
malformed or externally changed managed ranges while preserving outside bytes;
it does not permit project-ID changes, revision rollback, hash conflicts, path
escapes, or unsafe filesystem replacement.

## Last-known-good cache

Fallback is explicit and same-project only:

```bash
instructions project-context apply \
  --runtime agents \
  --workspace-root /absolute/workspace \
  --allow-stale-cache \
  --expected-project-id <id> \
  --max-stale-age-seconds 3600
```

Fallback is used when input is absent or has a newer unsupported bundle schema.
The cache's project ID, revision, hash, and embedded bundle are revalidated.
Maximum age defaults to 3600 seconds and must be between 1 second and 7 days.
The resulting status is `stale-cache`; normal non-fresh input renders as
`stale-source`.

## Session-render coordination

Later Claude, Codewith, or Codex session renders observe compatible durable
project context, add it to their planned files and manifest, and acquire the
same workspace lock. This prevents routine session regeneration from silently
discarding the managed fragment or entrypoint block.

Failures use stable `PROJECT_CONTEXT_*` error codes. With `--json`, the CLI
returns `{ ok: false, error: { code, message } }` and sets a nonzero exit code.
