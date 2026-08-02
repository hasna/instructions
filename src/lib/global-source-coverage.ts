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
// CORRECTED 2026-08-02, during PR #51's own remediation: this tag is for a
// decision someone can actually justify, not a label of convenience for
// whatever the current render array happens to leave out. The original version
// of this comment claimed `global-agent-rules-standard` (and its dupes) belong
// here because the base slug "backstops the agent-operating-rules payload
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
// as a gap.
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
  /** Expected slugs that WERE passed to this render but that the render itself
   * discarded during planning (semantic-policy dedup, provider mismatch, etc —
   * see `manifest.skippedSources`). Excluded from `missingSlugs`: a source the
   * render actually considered and made a deliberate decision about is not the
   * "silently never remembered" defect this check exists to catch, and reporting
   * it as missing would contradict the render's own skip-reporting (PR #50) in
   * the same JSON response. Still worth surfacing separately so a genuine
   * skip-reason regression (e.g. two live sources wrongly deduped) stays visible
   * rather than being swallowed into a silent "complete". */
  skippedSlugs: string[];
  /** Expected but absent from the render, AND not accounted for by a skip
   * reason above — the actual defect this exists to catch. */
  missingSlugs: string[];
  /** Present on the render but not a currently-expected global source (renamed,
   * retired since the render was built, or simply not a `global-*` slug at all —
   * informational only, never blocking). */
  unexpectedSlugs: string[];
  /** True only when every expected slug is present or accounted for by a skip. */
  complete: boolean;
}

export function computeGlobalSourceCoverage(
  registryConfigs: readonly GlobalSourceCoverageConfig[],
  configuredSlugs: Iterable<string>,
  skippedSlugs: Iterable<string> = [],
): GlobalSourceCoverageResult {
  const expected = expectedGlobalSourceSlugs(registryConfigs);
  const expectedSet = new Set(expected);
  const configuredSet = new Set(configuredSlugs);
  // Only an EXPECTED slug that was NOT actually configured can be "skipped" —
  // a slug present in both sets is simply configured, and a skip reason for a
  // slug nobody expects is not this check's concern (it may still show up via
  // manifest.warnings, which this module does not replace).
  const skippedSet = new Set(
    [...new Set(skippedSlugs)].filter((slug) => expectedSet.has(slug) && !configuredSet.has(slug)),
  );
  const missing = expected.filter((slug) => !configuredSet.has(slug) && !skippedSet.has(slug));
  const unexpected = [...configuredSet]
    .filter((slug) => slug.startsWith(GLOBAL_SOURCE_SLUG_PREFIX) && !expectedSet.has(slug))
    .sort();
  return {
    expectedSlugs: expected,
    configuredSlugs: [...configuredSet].sort(),
    skippedSlugs: [...skippedSet].sort(),
    missingSlugs: missing,
    unexpectedSlugs: unexpected,
    complete: missing.length === 0,
  };
}

/** Human-readable warning lines for CLI/manifest output. Empty array means clean. */
export function formatGlobalSourceCoverageWarnings(result: GlobalSourceCoverageResult): string[] {
  if (result.complete) return [];
  const covered = result.expectedSlugs.length - result.missingSlugs.length;
  const lines = [
    `Global source coverage: ${covered}/${result.expectedSlugs.length} registered global-* sources are in this render. Missing: ${result.missingSlugs.join(", ")}`,
  ];
  if (result.skippedSlugs.length > 0) {
    lines.push(
      `Global source coverage: ${result.skippedSlugs.length} expected source(s) were passed to this render and deliberately discarded by it (see manifest.skippedSources), not counted as missing: ${result.skippedSlugs.join(", ")}`,
    );
  }
  return lines;
}
