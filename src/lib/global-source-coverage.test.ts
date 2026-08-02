import { describe, expect, test } from "bun:test";
import {
  computeGlobalSourceCoverage,
  expectedGlobalSourceSlugs,
  formatGlobalSourceCoverageWarnings,
  GLOBAL_SOURCE_SLUG_PREFIX,
  RETIRED_GLOBAL_SOURCE_TAG,
} from "./global-source-coverage.js";
import { planSessionRender, sourceFromConfig } from "./session-render.js";

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

describe("computeGlobalSourceCoverage — skipped sources do not contradict PR #50's skip-reporting", () => {
  // PR #51 review, P1 #2: passing global-agent-rules-standard-1 and -2 together
  // produced ONE JSON response in which manifest.skippedSources correctly said
  // "-2 superseded by design" while this checker's missingSlugs said "-2 is a
  // gap" — two subsystems disagreeing about the same source in the same output.
  // These fixtures reproduce that shape at reduced scale: a source that WAS
  // passed to --config but that the render's own dedup logic then discarded.

  const fullRenderSlugs = [
    "global-fix-on-sight",
    "global-credential-exposure-hygiene",
    "global-mementos-discipline",
    "global-capture-path-command-instrument",
    "global-paste-the-control-output",
  ];

  test("a configured-but-render-discarded source is NOT counted as missing", () => {
    // "-mementos-discipline" stands in for the loser of a semantic-policy dedup:
    // it was passed to --config (present in the render's input) but the render
    // itself removed it and recorded why in skippedSources.
    const configured = fullRenderSlugs.filter((slug) => slug !== "global-mementos-discipline");
    const result = computeGlobalSourceCoverage(REGISTRY, configured, ["global-mementos-discipline"]);
    expect(result.missingSlugs).not.toContain("global-mementos-discipline");
    expect(result.skippedSlugs).toEqual(["global-mementos-discipline"]);
    expect(result.complete).toBe(true);
  });

  test("skipping does not mask a DIFFERENT, genuinely forgotten source in the same render", () => {
    // Regression proof this bucket cannot be used to silence real gaps: drop
    // "capture-path-command-instrument" for real (never passed, never skipped)
    // while "-mementos-discipline" is legitimately skipped-by-design.
    const configured = fullRenderSlugs.filter(
      (slug) => slug !== "global-mementos-discipline" && slug !== "global-capture-path-command-instrument",
    );
    const result = computeGlobalSourceCoverage(REGISTRY, configured, ["global-mementos-discipline"]);
    expect(result.skippedSlugs).toEqual(["global-mementos-discipline"]);
    expect(result.missingSlugs).toEqual(["global-capture-path-command-instrument"]);
    expect(result.complete).toBe(false);
  });

  test("a skip reason for a slug that IS configured does not double-count it as skipped", () => {
    // A stale/late skip report naming a slug that ended up configured anyway
    // must not appear in skippedSlugs — it is simply configured.
    const result = computeGlobalSourceCoverage(REGISTRY, fullRenderSlugs, ["global-mementos-discipline"]);
    expect(result.skippedSlugs).toEqual([]);
    expect(result.configuredSlugs).toContain("global-mementos-discipline");
  });

  test("a skip reason for a slug the registry does not expect is ignored, not surfaced as skipped", () => {
    const configured = fullRenderSlugs.filter((slug) => slug !== "global-mementos-discipline");
    const result = computeGlobalSourceCoverage(REGISTRY, configured, [
      "global-mementos-discipline",
      "global-some-renamed-or-deleted-source",
    ]);
    expect(result.skippedSlugs).toEqual(["global-mementos-discipline"]);
  });

  test("formatGlobalSourceCoverageWarnings reports skipped sources on a separate line, never silently", () => {
    const configured = fullRenderSlugs.filter((slug) => slug !== "global-mementos-discipline");
    // Force a real gap too, so `complete` is false and warnings actually render
    // (the formatter short-circuits to [] when complete).
    const configuredWithGap = configured.filter((slug) => slug !== "global-paste-the-control-output");
    const result = computeGlobalSourceCoverage(REGISTRY, configuredWithGap, ["global-mementos-discipline"]);
    const warnings = formatGlobalSourceCoverageWarnings(result);
    expect(warnings.some((line) => line.includes("global-paste-the-control-output"))).toBe(true);
    expect(warnings.some((line) => line.includes("deliberately discarded") && line.includes("global-mementos-discipline"))).toBe(true);
  });
});

describe("computeGlobalSourceCoverage — production-shaped reconciliation (P1 #1, CORRECTED)", () => {
  // Live production shape measured 2026-08-02. IMPORTANT CORRECTION mid-remediation
  // (fabricius, relaying a second agent's measurement): global-agent-rules-standard-1/
  // -2/-3 are NOT a static, intentionally-excluded "backstop family". They are
  // byte-identical (sha256 8b236086b82e) output of a LIVE, currently-unfixed defect
  // (`43d0c1c0`: `instructions add` mints a duplicate row for an existing target_path)
  // that fired twice in the 40 minutes before this test was written. Tagging them
  // `retired-global-source` would mark the OUTPUT OF AN ACTIVE BUG as intentional
  // design — hiding it from exactly the surface this checker exists to surface it on
  // — and the family is unbounded (a `-4`, `-5`, ... will keep minting untagged).
  //
  // The claim this task's original brief carried — "the base slug
  // global-agent-rules-standard feeds the embedded-baseline fallback via a different
  // render path, so it never needs to be in --config" — was checked against
  // `ensureGlobalAgentRulesStandardConfig` (global-agent-rules-standard.ts) and does
  // NOT hold: that function only maintains the STORED row's content (seed/repair on
  // publish), it does not inject the row into any render bypassing the --config list.
  // A sibling claim that it renders via three homes' rendered fragments was
  // independently refuted. So the base slug's exclusion from GLOBAL_CONFIGS is an
  // UNVERIFIED design choice, not a confirmed one — it is left as a visible gap
  // rather than silently exempted, so a human resolves it instead of this checker
  // guessing.
  //
  // Only ONE row in this family gets the tag: global-hasna-deployment-terms, which is
  // a genuine, dated, owner-ruled withdrawal (knowledge k_ms5a5hmy_hllrbg) — the exact
  // case RETIRED_GLOBAL_SOURCE_TAG's own doc comment describes, and the only row in
  // this whole set with a real justification behind it rather than an inherited,
  // unverified assumption.
  const PROD_SHAPED_REGISTRY = [
    { slug: "global-hasna-deployment-terms", category: "agent", tags: [RETIRED_GLOBAL_SOURCE_TAG] },
    { slug: "global-agent-rules-standard", category: "agent", tags: ["global", "mandatory"] },
    { slug: "global-agent-rules-standard-1", category: "agent", tags: [] },
    { slug: "global-agent-rules-standard-2", category: "agent", tags: [] },
    { slug: "global-agent-rules-standard-3", category: "agent", tags: [] },
    { slug: "global-fix-once", category: "agent", tags: [] },
    { slug: "global-no-mcp-use-clis", category: "agent", tags: [] },
  ];
  const liveArrayConfiguredSlugs = ["global-fix-once", "global-no-mcp-use-clis"];

  test("the owner-withdrawn source alone is excluded from expected; the mint-bug family and base slug remain VISIBLE GAPS", () => {
    const result = computeGlobalSourceCoverage(PROD_SHAPED_REGISTRY, liveArrayConfiguredSlugs);
    expect(result.expectedSlugs).not.toContain("global-hasna-deployment-terms");
    // These four are deliberately NOT suppressed: they are either active-bug output
    // or an unverified exclusion, and this checker's job is to surface them, not
    // hide them behind a tag nobody can justify.
    expect(result.missingSlugs.sort()).toEqual([
      "global-agent-rules-standard",
      "global-agent-rules-standard-1",
      "global-agent-rules-standard-2",
      "global-agent-rules-standard-3",
    ].sort());
    expect(result.complete).toBe(false);
  });

  test("a NEWLY MINTED duplicate (-4, from the same live defect) shows up as a gap with zero code changes here", () => {
    // This is the property that rules out a hardcoded slug list as a fix: the
    // checker must not need to know the family's membership to correctly report
    // an as-yet-unseen member as missing. Registering -4 and re-running proves it.
    const registryWithMint = [
      ...PROD_SHAPED_REGISTRY,
      { slug: "global-agent-rules-standard-4", category: "agent", tags: [] },
    ];
    const result = computeGlobalSourceCoverage(registryWithMint, liveArrayConfiguredSlugs);
    expect(result.missingSlugs).toContain("global-agent-rules-standard-4");
  });

  test("an unrelated genuine gap in the same registry still reports missing (the check has not gone vacuous)", () => {
    const registryWithGenuineGap = [
      ...PROD_SHAPED_REGISTRY,
      { slug: "global-a-tenth-genuine-gap", category: "agent", tags: [] },
    ];
    const result = computeGlobalSourceCoverage(registryWithGenuineGap, liveArrayConfiguredSlugs);
    expect(result.missingSlugs).toContain("global-a-tenth-genuine-gap");
    expect(result.complete).toBe(false);
  });
});

describe("end-to-end via planSessionRender — reproduces the exact PR #51 review contradiction (P1 #2)", () => {
  // The reviewer's exact repro: pass BOTH global-agent-rules-standard-1 and -2 in the
  // same render. The real deduplication logic in session-render.ts (not a mock) collapses
  // them because both carry the AGENT_OPERATING_RULES_SENTINEL_PATTERN comment, which is
  // the actual mechanism that produced the contradiction under review — not a stand-in.
  const SENTINEL_CONTENT = [
    "<!-- hasna:agent-operating-rules v=1.0.0 -->",
    "Some duplicate semantic-policy content, byte-identical on both sources.",
  ].join("\n");

  function planWithBothDuplicates() {
    const configA = {
      slug: "global-agent-rules-standard-1",
      name: "global-agent-rules-standard-1",
      content: SENTINEL_CONTENT,
      agent: "global" as const,
      target_path: null,
    };
    const configB = {
      slug: "global-agent-rules-standard-2",
      name: "global-agent-rules-standard-2",
      content: SENTINEL_CONTENT,
      agent: "global" as const,
      target_path: null,
    };
    const sources = [sourceFromConfig(configA, 0), sourceFromConfig(configB, 1)];
    return planSessionRender({
      tool: "claude",
      profile: "test-profile",
      sources,
    });
  }

  test("the render itself discards -2 and records why in manifest.skippedSources", () => {
    const plan = planWithBothDuplicates();
    const skipped = plan.manifest.skippedSources.find((s) => s.id === "global-agent-rules-standard-2");
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toContain("superseded by");
    // -1 survives and is on the render's own configured/rendered source list.
    expect(plan.manifest.sources.some((s) => s.id === "global-agent-rules-standard-1")).toBe(true);
    expect(plan.manifest.sources.some((s) => s.id === "global-agent-rules-standard-2")).toBe(false);
  });

  test("wiring skippedSources into the coverage check removes the contradiction: -2 is not ALSO reported missing", () => {
    const plan = planWithBothDuplicates();
    const registry = [
      { slug: "global-agent-rules-standard-1", category: "agent", tags: [] },
      { slug: "global-agent-rules-standard-2", category: "agent", tags: [] },
    ];
    const configuredSlugs = plan.manifest.sources
      .map((s) => s.id)
      .filter((id) => id.startsWith(GLOBAL_SOURCE_SLUG_PREFIX));
    const skippedSlugs = plan.manifest.skippedSources
      .map((s) => s.id)
      .filter((id) => id.startsWith(GLOBAL_SOURCE_SLUG_PREFIX));

    // The pre-fix behaviour (what the reviewer flagged as P1 #2): computing coverage
    // from `configuredSlugs` alone, ignoring skippedSources, reports -2 as missing
    // WHILE manifest.warnings/skippedSources says it was superseded by design — two
    // subsystems disagreeing in the same JSON response.
    const withoutSkipWiring = computeGlobalSourceCoverage(registry, configuredSlugs);
    expect(withoutSkipWiring.missingSlugs).toContain("global-agent-rules-standard-2");

    // The fix: pass skippedSlugs through, exactly as checkGlobalSourceCoverage in
    // src/cli/index.tsx now does.
    const withSkipWiring = computeGlobalSourceCoverage(registry, configuredSlugs, skippedSlugs);
    expect(withSkipWiring.missingSlugs).not.toContain("global-agent-rules-standard-2");
    expect(withSkipWiring.skippedSlugs).toContain("global-agent-rules-standard-2");
    expect(withSkipWiring.complete).toBe(true);

    // And the render's own warnings still say so, in the same response — no
    // contradiction between the two surfaces any more.
    expect(plan.warnings.some((w) => w.includes("global-agent-rules-standard-2") && w.includes("superseded by"))).toBe(true);
  });
});
