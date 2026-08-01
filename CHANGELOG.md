# Changelog

## 0.4.16

Closes **relocation**, the third and last credential-destruction route, which
0.4.15 shipped with and named as still open in its own entry above.

**What was destroying, and why both guards missed it.** `wouldDestroyACredential`
scanned with the config's *declared* `ConfigFormat`. That union has no `shell`
member, and `detectFormat` returns `text` for any extensionless path — so
`~/.zshrc`, `~/.bashrc` and `~/.npmrc`, the three files most likely to hold a
literal credential, all arrived declared `text`. `text` routes to
`redactGeneric`, which matches token *shapes* only and never key names, so a
credential with a secret-class KEY and a shapeless VALUE was invisible to the
scan arm on exactly those files. Pair that with a relocation — the placeholder
moved from prose onto the live slot, total count conserved — and the count
backstop does not fire either. Both arms blind, and the write proceeded **at
rc=0 printing `✓ (changed)`**. It destroys on 0.4.14 and 0.4.15 alike; it is not
a regression from #40, which closed the `toml`/`json`/`ini` instances of the same
shape and stopped at the format boundary.

**The fix** resolves the redaction dialect from the TARGET PATH rather than from
the declared format, via `redactFormatForTarget` — promoted from a private
function in `sync.ts` to a shared export so `diff` (the last read before a value
reaches a transcript) and the `apply` guard (the last check before a value is
overwritten) cannot drift apart. It is path-keyed rather than a widening of the
format union, deliberately: `.md` still resolves to `markdown`, so a rules file
documenting a token assignment in prose is not mistaken for a shell config and
frozen from ever shipping an edit. There is a negative control for exactly that,
and **it was vacuous until this release repaired it**: its fixture buried the
assignment mid-prose (`never write NPM_TOKEN=… anywhere`), which `redactShell`
does not match, so both dialects returned nothing and the control passed
whichever one was selected — it stayed green under the exact regression it
names. The fixture now puts the assignment at line start, as the real rules files
do. Verified by mutation: forcing `.md` to resolve to `shell` now fails that test
(9/10), where before the repair it left the suite 10/10.

**Measured in both directions, on the same probe, rather than asserted.** The
relocation suite run unchanged against 0.4.15 fails 3 of 10 with the live value
replaced by the placeholder on `.zshrc`, `.npmrc` and `.bashrc`; against 0.4.16
it passes 10 of 10 with the value intact and the write refused as
`unresolved-secret-placeholder`. Every assertion is on the SURVIVING BYTES on
disk, never on an exit code — the whole defect is that the destroying path exits
0 and reports success, so a status assertion cannot see it.

**What is NOT closed, named rather than left to be discovered.**

- **The dialect map is a fixed list of paths, and that is the axis this fix does
  not vary.** `.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile`, `.profile`,
  `.zshenv`, `*.env` resolve to `shell`; `.npmrc`, `.yarnrc`, `.curlrc`,
  `.netrc` resolve to `ini`. **Any other extensionless credential-bearing file
  still resolves to `text` and is still blind on the scan arm.** The sharpest
  case is **`~/.aws/credentials`**: the `ini` dialect *would* catch
  `aws_secret_access_key`, so that one is blind only because the path is not
  listed. **`~/.pgpass` is a different and worse shape** — colon-delimited with
  no key at all, so neither `shell` nor `ini` detects it and adding it to the map
  would not rescue it. For both, the count backstop is the only thing standing
  behind the write, exactly as before this release. Measured against the 143 live
  config rows: **zero target any uncovered credential path**, so nothing in the
  current fleet state reaches this residual.
- **A bare `_authToken=` is matched by neither `ini` branch** (the registry branch
  needs the `//host/:` prefix; the generic branch requires the key to start with
  a letter). A separate detector gap, filed rather than widened here.
- **`diff` still redacts only the disk side of a hunk.** A stored row that itself
  holds a literal will print it; that is blocked on the ingest defect and is
  unchanged by this release.

## 0.4.15

Ships the two already-merged fixes that stop `apply` destroying live credentials,
and lifts `PUBLISH_HOLD` under that file's own condition (both named defects
fixed and merged, with the sha, never one of the two).

**Read this before assuming you were safe.** `PUBLISH_HOLD` stated *"Exposure is
currently ZERO: installed and npm-latest are both 0.4.14, which predates the #38
merge."* That is **false**, measured on station01 and station02 rather than
argued. 0.4.14 carries **no guard at all**, so it destroys on every shape — and
0.4.12 destroys identically. The route is the one #38 was *fixing*, not the one
it introduced: ingest redacts a live value to `{{AUTHORIZATION}}` in the stored
row, and `apply` writes that stored row to disk, exits 0, and prints
`OK (changed)`. Anyone who ran `instructions apply` against a credential-bearing
config on 0.4.12 or 0.4.14 lost that value.

**What is closed, and what is NOT.** The common case is closed: a write that
would put a secret-class placeholder over a live credential is refused, visibly,
via skip owner `unresolved-secret-placeholder`. **Relocation is still open**
(todos `e4d9c22e`): when the target carries the placeholder in one slot and a
live value in another, and the file's declared format is `text` — which
`detectFormat` returns for any extensionless path such as `~/.zshrc`, `~/.bashrc`
or `~/.npmrc` — the count backstop is defeated and the value is still destroyed.
Reproduced by reviewer `tullius` on this candidate. Do not read this release as
"credential destruction is closed".

The guard is targeted rather than blanket, verified with drifted disk content so
a write was genuinely required: ordinary configs, non-secret `{{VAR}}` prose, and
a rules file that *documents* `{{NPM_TOKEN}}` all still apply.

- fix(apply): refuse to overwrite live config with a secret-class placeholder
  (#40, `06ff066`, todos `e043e6df`). Decides from `scanSecrets` — the same
  detector that creates these placeholders on ingest — rather than from counting
  placeholder occurrences, closing the relocation and `{{NAME:default}}` bypasses
  that defeated a scalar count.
- fix(apply): refuse a write that would destroy live codex/Claude auth (#39,
  `e5462f9`, todos `26caf1b9`, incident 620939 from `numitor`). `profile apply`
  is not a separate code path — it funnels through `applyConfigsWithReport` into
  the same guard, so one guard closes both verbs.

## 0.4.14

Carries one fix, merged to `main` on 2026-08-01 (UTC) as #36, with no release
behind it — so the guard existed in `main` and on no machine. Measured in the
installed 0.4.13 bundle before this release: `findConfigsByTargetPath` appears
**0** times in `dist/mcp/index.js`, against a positive control of 327
occurrences of `config` in the same file, proving the probe read the bundle.

**Operator note — behaviour change on the MCP surface.** `create_config` on a
path some config row already targets now returns an ERROR, where it previously
returned a created config. Any agent or script calling `create_config`
idempotently starts failing on this version; call `update_config` on the owning
row to refresh it in place, or `delete_config` first. This is the same refusal
`instructions add` has enforced since 0.4.13 — but the [BREAKING] notice for
that release described the CLI only, and MCP callers were never covered by it.

- fix(mcp): `create_config` enforces the duplicate-target-path guard the CLI
  added (#36). 0.4.13 made `instructions add` refuse a path the store already
  tracked, because two rows on one `target_path` make `apply` race itself, last
  writer wins, and nothing reports the conflict. The MCP's `create_config`
  handler kept minting twins silently — so the CLI's refusal read as fleet-wide
  protection while the surface agents actually reach through
  (`hasna-configs-mcp.service` runs it) was still unguarded. A guard that covers
  the human path and not the agent path is close to no guard at all, given which
  one writes more rows.

  Routed through `findConfigsByTargetPath`, the CLI's own helper, rather than a
  reimplementation, so both surfaces collapse symlinked ancestors and alternate
  spellings of a path identically — a guard that differs subtly between two
  surfaces is its own defect. Reference configs own no target path and stay
  exempt, matching the CLI. Refusing rather than updating is deliberate and
  matches `add`: the stored row may hold redacted or templatized content that the
  literal bytes on disk would flatten, so overwriting it is the caller's explicit
  choice, not a side effect of `create`.

  The regression test drives the real MCP server over a client transport rather
  than re-implementing the handler — a test that re-implements the handler proves
  only that the test agrees with itself, which is exactly why the existing suite
  could never have caught this. Controlled in both directions: 3 fail / 2 pass
  against the pre-fix bytes, 5 pass / 0 fail against the fix.

## 0.4.13

Cuts two fixes that were both merged to `main` on 2026-07-31 (UTC) and had no
release carrying them, so neither reached a single machine. One patch covers both.

**Operator note — behaviour change.** `instructions add` on a path some config
row already targets now EXITS 1, where it previously exited 0 and silently
created a duplicate row. Any script or loop that re-runs `add` idempotently will
start failing on this version; pass `--update` to refresh the existing row in
place. Announced as [BREAKING] before the release landed.

- fix(configs): one `target_path`, one row; dry-run reports the primary's own
  verdict (#32). Two defects with one root: a config's `target_path` was not
  treated as its identity on disk.

  `instructions add` on a file the store already tracked INSERTED a twin row
  rather than refusing — `uniqueSlug` appended `-1` and both rows survived. Two
  rows on one path make `apply` race itself, last writer wins, and nothing
  reports the conflict. `add` now refuses by default and names the owning rows;
  `--update` refreshes the existing row in place. Refusing rather than silently
  updating is deliberate: the stored row may hold redacted or templateized
  content that the literal bytes on disk would flatten, so overwriting it is the
  operator's call and not a side effect of re-running `add`. Matching is on the
  NORMALIZED path, because the same file is spelled several ways across the store
  — `~/.claude/CLAUDE.md` from `sync`, an absolute path from `add`, or either
  through a symlinked ancestor — and matching the raw string is what let a twin
  in through a different spelling of a path that was already owned.

  Separately, every display line is labelled with a path but read `changed`,
  which ORs in the config's OUTPUTS. A config whose primary file was
  byte-identical while an output had drifted therefore printed the primary as
  "changed" — a dry-run reporting work it was not going to do, which is the
  failure mode that makes a dry-run worth less than not running one. `ApplyResult`
  now carries `primary_changed`, that target's own verdict, alongside the
  deliberately-unchanged `changed` aggregate that profile/sync counters and the
  MCP surface consume. Display surfaces read `primary_changed`; counters keep
  reading `changed`.

- fix(sync): discover project-root `CODEWITH.md`, not just nested (#33).
  `PROJECT_CONFIG_FILES` listed `.codewith/CODEWITH.md` but not `CODEWITH.md` at
  the project root, so a project keeping its instructions in the root file — the
  common layout — synced nothing and reported success. `syncProject` also walked
  `.claude/rules` and `.agents/rules` but never `.cursor/rules`, so Cursor rule
  directories were invisible to project sync; they are now discovered under the
  `cursor-rules` prefix.

## 0.4.12

- fix(diff): stop printing credential values from disk (#30, #31). `instructions
  diff` rendered the stored `${VAR}` placeholder against the literal value on
  disk, so the comparison manufactured plaintext that existed in neither side
  alone. Backfilled here — 0.4.12 shipped without a changelog entry.

## 0.4.11

- feat(session-render): accept `@hasna/personas` alongside `@hasna/identities`
  (#27, #29). Backfilled here — 0.4.11 shipped without a changelog entry.

## 0.4.10

Release cutting #20, the fix for `instructions session apply` being unable to write
any managed file on macOS. This is the only change since 0.4.9 and the reason to cut
it immediately is that 14 of the 16 fleet machines are macOS and none of them could
receive a rules render; station03 had been frozen at rules `v1.1.0` since 2026-07-01.

- fix(project-context): stage managed files without the variadic `openat` mode (#20).
  `openat(2)` is variadic — `int openat(int, const char *, int, ...)` — and `mode` is
  the variadic argument the kernel reads only under `O_CREAT`. `bun:ffi` can declare
  only fixed arguments, and a fixed fourth argument happens to match the Linux integer
  calling convention while it does not match arm64 macOS, where variadic arguments are
  passed on the stack. The kernel there read an uninitialised slot: a create asking for
  `0o644` produced `0o140` in one measurement on station03 and `0o000` in another —
  never a mode carrying the owner-read bit — so every readback returned −1 and the
  failure surfaced as `prepared bytes changed before installation`, a hash race that
  never happened. That misleading message is why the defect survived a month.

  Creation no longer travels through the FFI declaration at all; it uses the compiled
  `fs` binding, which builds the variadic call correctly on every platform, and the
  directory anchor is re-established by verifying the created inode through the pinned
  directory fd rather than assumed from the call. The remaining FFI `openat` omits
  `O_CREAT`, so the kernel never reads its variadic slot. One code path on every
  platform, so the Linux suite now exercises what macOS runs.

  Two guards were added so a recurrence cannot present as a phantom race again: an
  unusable staged mode raises `PROJECT_CONTEXT_PREPARED_FILE_MODE_REJECTED`, and a
  staged file that cannot be read back raises `PROJECT_CONTEXT_PREPARED_FILE_UNREADABLE`
  on both the anchored and portable paths.

Note on the CI matrix: the `build` job now runs on `ubuntu-latest` and `macos-latest`.
The reviewer established that the Linux suite cannot catch this defect class —
restoring the broken FFI create leaves Linux at 10 pass / 0 fail — so `macos-latest`
is the sole barrier against recurrence. `main` branch protection was updated in the
same change to require `build (ubuntu-latest)` and `build (macos-latest)`; the previous
single required context `build` no longer matches any job the matrix emits.

The managed-workspace suites were also re-rooted at a symlink-free temp dir, because
`os.tmpdir()` on macOS resolves under `/var/folders/…`, `/var` is a symlink to
`/private/var`, and the renderer's symlink guard rejected it — which is why these
suites had never actually run on a Mac.

## 0.4.9

Release cutting the three PRs landed on `main` since 0.4.8 with no prior version
bump. The reason to cut it now is operational: a standing fleet warning — *never
run `instructions apply` on any `04-hasna-agent-operating-rules-md*` slug* — exists
because of a defect that #18 fixes, and that warning cannot be retired while the
fix is unpublished.

- fix(apply): extend the session-renderer ownership guard to managed fragments (#18).
  The guard protected four provider entrypoint files by exact-path equality, so
  `<home>/.hasna/instructions/**` — written by the same `instructions-session-renderer`
  writer and `@`-included by the generated entrypoint — was writable by any config row
  that resolved to it. Reproduced on 0.4.8 against the live station01 registry:
  `instructions apply claude-md --dry-run` reports `[owned] … instructions-session-renderer`
  while `instructions apply 01-hasna-global-coding-agent-non-overridable-rules-md --dry-run`
  reports `(changed)`. Same binary, same minute, opposite verdicts — so the fragment path
  really was unguarded, and the check that shows it is not vacuous. Ownership is now derived
  from the renderer's own definitions rather than a second hardcoded list, and intentional
  writes into renderer-owned space need an explicit `--allow-renderer-owned` flag kept
  separate from `--force`.
- fix(session-render): apply the rules currency floor on every render route (#17).
- fix(session-render): stop discarding stored agent operating rules content, and enforce the
  rules currency floor at its own boundary (#16).

Note on the embedded floor: `AGENT_OPERATING_RULES_VERSION` in
`src/lib/global-agent-rules-standard.ts` is still `1.1.6`, pinned to upstream
`hasnaxyz/iapp-identities@48168c54`, while `@hasna/identities` now ships `1.1.16`. That
copy is reachable only via `--config global-agent-rules-standard`, which no live render
invocation passes, so it is inert today — but nothing in either repository's CI compares
the two, and both suites are green while ten versions apart. Tracked separately; not fixed
here.

## 0.4.8

Release cutting the PR-drain landed on `main` since 0.4.7 (three merged PRs, no
prior version bump):

- fix(cli): surface an actionable re-auth message when a cloud API key is revoked (#11).
- feat: add the managed project-context renderer (#12).
- fix: align managed agent rules to v1.1.6 (#14).

## 0.4.7

- Prior published release (2026-07-13); managed dangerous-operation guard standard (#10).
