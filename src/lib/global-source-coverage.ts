// Reconcile-and-warn for the global-instruction-source render gap.
//
// Root cause (todos 102d6d0a, 5dcd60ec; incident authored 2026-08-02): the fleet's
// session render spec (config `render-spec-station01-sh`) carries a hand-maintained
// `GLOBAL_CONFIGS` bash array that is the ONLY thing deciding which registered
// `global-*` sources actually reach any agent home. `planSessionRender` warns only
// when the resolved source list is empty (see `orderedSources.length === 0` in
// session-render.ts) — a source that is simply never added to the array disappears
// from every render, silently, at rc=0, forever. Measured 2026-08-02: 29 sources
// registered with a `global-` slug prefix, 16 in the array, 13 never rendered
// anywhere, 6 of them written the same day by the agent who maintains this very
// package.
//
// This module supplies the missing check. It is deliberately built so the
// "expected" side and the "actual" side come from two independent inputs:
//   - expected: a fresh read of the CONFIG REGISTRY (what SHOULD exist)
//   - actual:   the slugs actually present on a session render plan/manifest
//               (what the render DECIDED to include)
// A checker that derives both sides from the same array (e.g. counting the array
// against itself) always reports full coverage by construction and cannot ever
// observe a shortfall — see the regression test for the constructed shortfall
// this module is required to detect.

export const GLOBAL_SOURCE_SLUG_PREFIX = "global-";

// The sanctioned way to mark a source as a deliberate, JUSTIFIED omission from
// every render's --config list — a true fossil kept registered for history/audit,
// like an owner-ruled withdrawal (see `global-hasna-deployment-terms`, knowledge
// `k_ms5a5hmy_hllrbg`). This constant exists only as the name of that tag so
// callers do not have to guess the string.
//
// CORRECTED 2026-08-02, during PR #51's own remediation (P1 #1: this tag had no
// way to be applied at all — see `instructions tag` in src/cli/index.tsx). This
// comment previously also claimed `global-agent-rules-standard` (and its dupes)
// belong here because the base slug "backstops the agent-operating-rules payload
// resolver ... and is never meant to be included directly". That is false:
// `ensureGlobalAgentRulesStandardConfig` (global-agent-rules-standard.ts) only
// seeds/repairs the STORED row's content on publish — it does not inject that
// row into any render, so there is no "different path" for a render-coverage
// check to defer to. Measured 2026-08-02: `global-agent-rules-standard-1/-2/-3`
// are BYTE-IDENTICAL duplicate rows minted by a live, still-open defect
// (`43d0c1c0`, `instructions add` re-inserting instead of updating an existing
// target_path) that fired twice in one evening. Tagging bug output "retired"
// would hide the bug from the one surface built to catch exactly this, and the
// family is unbounded — a `-4` would arrive untagged and this checker would
// (correctly) flag it, which is the point: NEVER special-case a slug by name
// here. If a source's exclusion is genuinely deliberate, tag that specific row
// with a reason a human can point to; if it's not deliberate, let it show up
// as a gap. Only `global-hasna-deployment-terms` carries this tag today.
export const RETIRED_GLOBAL_SOURCE_TAG = "retired-global-source";

export interface GlobalSourceCoverageConfig {
  slug: string;
  category: string;
  tags?: string[] | null;
}

/** The set of global sources that SHOULD be present in any render that claims
 * global coverage: registered, slug-prefixed `global-`, and not tagged retired. */
export function expectedGlobalSourceSlugs(
  registryConfigs: readonly GlobalSourceCoverageConfig[],
): string[] {
  return registryConfigs
    .filter((c) => c.slug.startsWith(GLOBAL_SOURCE_SLUG_PREFIX))
    .filter((c) => !(c.tags ?? []).includes(RETIRED_GLOBAL_SOURCE_TAG))
    .map((c) => c.slug)
    .sort();
}

export interface GlobalSourceCoverageResult {
  /** Registered, active global sources — the independent "should exist" side. */
  expectedSlugs: string[];
  /** Slugs actually present on the render plan/manifest being audited. */
  configuredSlugs: string[];
  /** Expected but absent from the render — the actual defect this exists to catch. */
  missingSlugs: string[];
  /** Present on the render but not a currently-expected global source (renamed,
   * retired since the render was built, or simply not a `global-*` slug at all —
   * informational only, never blocking). */
  unexpectedSlugs: string[];
  /** True only when every expected slug is present. */
  complete: boolean;
}

export interface GlobalSourceCoverageManifest {
  sources: readonly { id: string }[];
  skippedSources: readonly { id: string }[];
}

/** Global config ids the caller supplied to a render, whether they survived
 * composition or were deliberately reported as skipped. A skipped source was
 * configured and accounted for; treating it as absent recreates the exact
 * false-positive this coverage check exists to distinguish from a real gap. */
export function accountedGlobalSourceSlugs(
  manifest: GlobalSourceCoverageManifest,
): string[] {
  return [...manifest.sources, ...manifest.skippedSources]
    .map((source) => source.id)
    .filter((id) => id.startsWith(GLOBAL_SOURCE_SLUG_PREFIX));
}

export function computeGlobalSourceCoverage(
  registryConfigs: readonly GlobalSourceCoverageConfig[],
  configuredSlugs: Iterable<string>,
): GlobalSourceCoverageResult {
  const expected = expectedGlobalSourceSlugs(registryConfigs);
  const expectedSet = new Set(expected);
  const configuredSet = new Set(configuredSlugs);
  const missing = expected.filter((slug) => !configuredSet.has(slug));
  const unexpected = [...configuredSet]
    .filter((slug) => slug.startsWith(GLOBAL_SOURCE_SLUG_PREFIX) && !expectedSet.has(slug))
    .sort();
  return {
    expectedSlugs: expected,
    configuredSlugs: [...configuredSet].sort(),
    missingSlugs: missing,
    unexpectedSlugs: unexpected,
    complete: missing.length === 0,
  };
}

/** Human-readable warning lines for CLI/manifest output. Empty array means clean. */
export function formatGlobalSourceCoverageWarnings(result: GlobalSourceCoverageResult): string[] {
  if (result.complete) return [];
  return [
    `Global source coverage: ${result.expectedSlugs.length - result.missingSlugs.length}/${result.expectedSlugs.length} registered global-* sources are in this render. Missing: ${result.missingSlugs.join(", ")}`,
  ];
}
