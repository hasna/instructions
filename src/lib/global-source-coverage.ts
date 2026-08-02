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

// Slugs of true fossils, kept registered for history/audit but never rendered:
//   - superseded content that has an explicit successor (see the `retired` tag
//     convention below), or
//   - a config that exists only to feed a DIFFERENT render path programmatically
//     (e.g. `global-agent-rules-standard` backstops the agent-operating-rules
//     payload resolver in global-agent-rules-standard.ts; it is never meant to be
//     included directly in a tool's GLOBAL_CONFIGS list).
// A tag is the sanctioned way to mark a source retired; this constant exists only
// as the name of that tag so callers do not have to guess the string.
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
