# Changelog

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
