# Changelog

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
