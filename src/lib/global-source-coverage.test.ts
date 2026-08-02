import { describe, expect, test } from "bun:test";
import {
  computeGlobalSourceCoverage,
  expectedGlobalSourceSlugs,
  formatGlobalSourceCoverageWarnings,
  RETIRED_GLOBAL_SOURCE_TAG,
} from "./global-source-coverage.js";

// Regression fixture for todos 102d6d0a / 5dcd60ec: 29 registered `global-*`
// sources on station01, 16 of them in the hand-maintained GLOBAL_CONFIGS array,
// 13 silently unrendered (1 deliberately retired, 2 fossils feeding another
// render path, 10 live gaps). This fixture mirrors that exact shape at reduced
// scale so the test documents the real incident rather than a synthetic one.
const REGISTRY = [
  { slug: "global-fix-on-sight", category: "agent", tags: [] },
  { slug: "global-credential-exposure-hygiene", category: "agent", tags: [] },
  { slug: "global-mementos-discipline", category: "agent", tags: [] },
  // Deliberately withdrawn (owner ruling, 2026-07-29) — tagged so the checker
  // does not perpetually flag an intentional omission as a defect.
  { slug: "global-hasna-deployment-terms", category: "agent", tags: [RETIRED_GLOBAL_SOURCE_TAG] },
  // Registered today, never added to any render's config list — the live gap.
  { slug: "global-capture-path-command-instrument", category: "agent", tags: [] },
  { slug: "global-paste-the-control-output", category: "agent", tags: [] },
  // Not a global-* slug at all — must never enter the expected set.
  { slug: "agent-ceo-charter-codewith", category: "agent", tags: [] },
];

describe("expectedGlobalSourceSlugs", () => {
  test("includes only slug-prefixed, non-retired sources", () => {
    const expected = expectedGlobalSourceSlugs(REGISTRY);
    expect(expected).toEqual([
      "global-capture-path-command-instrument",
      "global-credential-exposure-hygiene",
      "global-fix-on-sight",
      "global-mementos-discipline",
      "global-paste-the-control-output",
    ].sort());
  });

  test("retired sources are excluded even though they carry the global- prefix", () => {
    const expected = expectedGlobalSourceSlugs(REGISTRY);
    expect(expected).not.toContain("global-hasna-deployment-terms");
  });
});

describe("computeGlobalSourceCoverage — the constructed-shortfall requirement", () => {
  // This is the acceptance test fabricius/Maecenas specified: the denominator
  // (registry) and numerator (render) must be independent enough that removing
  // one configured source measurably moves the fraction. A checker that derives
  // both sides from the same list cannot fail this test — it always reports
  // full coverage, because there is nothing else to compare against.

  const fullRenderSlugs = [
    "global-fix-on-sight",
    "global-credential-exposure-hygiene",
    "global-mementos-discipline",
    "global-capture-path-command-instrument",
    "global-paste-the-control-output",
  ];

  test("a render carrying every expected source reports complete coverage", () => {
    const result = computeGlobalSourceCoverage(REGISTRY, fullRenderSlugs);
    expect(result.complete).toBe(true);
    expect(result.missingSlugs).toEqual([]);
    expect(formatGlobalSourceCoverageWarnings(result)).toEqual([]);
  });

  test("removing ONE --config entry from the render moves the fraction: 0 missing -> 1 missing", () => {
    const before = computeGlobalSourceCoverage(REGISTRY, fullRenderSlugs);
    expect(before.missingSlugs.length).toBe(0);

    // Simulate exactly the real defect: a source registered in the DB (the
    // registry) but never added to a render's --config list (the array).
    const shortRenderSlugs = fullRenderSlugs.filter(
      (slug) => slug !== "global-capture-path-command-instrument",
    );
    const after = computeGlobalSourceCoverage(REGISTRY, shortRenderSlugs);

    expect(after.missingSlugs.length).toBe(1);
    expect(after.missingSlugs).toEqual(["global-capture-path-command-instrument"]);
    expect(after.complete).toBe(false);
    expect(before.missingSlugs.length).not.toBe(after.missingSlugs.length);

    const warnings = formatGlobalSourceCoverageWarnings(after);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("global-capture-path-command-instrument");
    expect(warnings[0]).toContain("4/5");
  });

  test("removing all configured sources reports every expected slug missing", () => {
    const result = computeGlobalSourceCoverage(REGISTRY, []);
    expect(result.missingSlugs).toEqual(expectedGlobalSourceSlugs(REGISTRY));
    expect(result.complete).toBe(false);
  });

  test("a render source that is not in the registry (renamed/removed) is reported as unexpected, not swallowed", () => {
    const result = computeGlobalSourceCoverage(REGISTRY, [
      ...fullRenderSlugs,
      "global-some-renamed-or-deleted-source",
    ]);
    expect(result.unexpectedSlugs).toEqual(["global-some-renamed-or-deleted-source"]);
    // Being unexpected must never mask a real omission elsewhere.
    expect(result.complete).toBe(true);
  });

  test("a retired source configured accidentally does not count against completeness or as unexpected non-global noise", () => {
    // Deployment-terms is retired; if some stale render still lists it that is
    // not this checker's concern (it does not appear in `expected`, and since
    // it IS a global-* slug it is reported as unexpected, which is correct: the
    // render is carrying a source the registry no longer wants rendered).
    const result = computeGlobalSourceCoverage(REGISTRY, [
      ...fullRenderSlugs,
      "global-hasna-deployment-terms",
    ]);
    expect(result.complete).toBe(true);
    expect(result.unexpectedSlugs).toEqual(["global-hasna-deployment-terms"]);
  });
});
