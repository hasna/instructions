import { describe, expect, test } from "bun:test";
import { planSessionRender, type SessionInstructionSource } from "./session-render";

/**
 * Regression cover for todos 0c7ffd33 — `session plan` / `session apply` discarded
 * instruction sources with NO trace: exit 0, `warnings: []`, `skippedSources: []`.
 *
 * The reported symptom was "more than 15 sources loses one", and the count was a red
 * herring. Two independent code paths drop sources by design, and BOTH were silent:
 *
 *  1. `deduplicateSemanticPolicySources` collapses every payload carrying the
 *     `hasna:agent-operating-rules` sentinel down to one.
 *  2. `composeSources` drops every non-`nonOverridable` source that precedes a
 *     `merge: "replace"` source.
 *
 * Collapsing is CORRECT — one instruction home must not be stamped with two
 * contradictory rule-set versions. Doing it invisibly is the defect: an operator
 * comparing the slugs they passed against `manifest.sources` sees a source vanish and
 * has no surface that says so. These tests assert the loss is REPORTED, not that it
 * stops happening.
 */

/**
 * Both fixtures sit ABOVE the embedded baseline version on purpose. Below-baseline
 * content is rewritten by the currency floor, which also stamps it with the
 * agent-operating-rules role — that changes the collapse's priority tie-break and would
 * couple this regression to selection semantics it is not testing. Above the baseline
 * both payloads pass through untouched, so the survivor is decided by version alone and
 * these tests assert only what they are about: that the loser is REPORTED.
 */
const OLDER = "9.9.8";
const NEWER = "9.9.9";
const OLDER_ID = `rules-${OLDER}`;
const NEWER_ID = `rules-${NEWER}`;

const OPERATING_RULES_SENTINEL = (version: string) => `<!-- hasna:agent-operating-rules v=${version} -->`;

function rulesPayload(version: string, body: string): string {
  return [
    `# Hasna Agent Operating Rules — v${version} (2026-08-02)`,
    OPERATING_RULES_SENTINEL(version),
    body,
  ].join("\n");
}

function plan(sources: SessionInstructionSource[]) {
  return planSessionRender({
    tool: "claude",
    profile: "octavia-regression",
    targetHome: "/tmp/octavia-regression-home",
    generatedAt: "2026-08-02T00:00:00.000Z",
    sources,
  });
}

describe("session render reports every source it discards (todos 0c7ffd33)", () => {
  /**
   * The PASSING state of the whole probe. Two ordinary sources must survive untouched
   * with both reporting surfaces empty — without this, a fix that simply appended a
   * warning to every render would look green while telling operators nothing.
   */
  test("negative control — nothing is dropped, so nothing is reported", () => {
    const result = plan([
      { id: "plain-a", label: "Plain A", layer: "global", order: 0, content: "Alpha guidance." },
      { id: "plain-b", label: "Plain B", layer: "global", order: 1, content: "Beta guidance." },
    ]);

    expect(result.manifest.sources.map((source) => source.id)).toEqual(["plain-a", "plain-b"]);
    expect(result.manifest.skippedSources).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.manifest.warnings).toEqual([]);
  });

  test("a semantic-policy collapse names the discarded source in skippedSources", () => {
    const result = plan([
      { id: OLDER_ID, label: `Rules v${OLDER}`, layer: "global", order: 0, content: rulesPayload(OLDER, "Older policy body.") },
      { id: NEWER_ID, label: `Rules v${NEWER}`, layer: "global", order: 1, content: rulesPayload(NEWER, "Newer policy body.") },
    ]);

    // The collapse itself is intended and is preserved: exactly one policy survives.
    expect(result.manifest.sources.map((source) => source.id)).toEqual([NEWER_ID]);

    // ...and the loser is now visible instead of vanishing.
    const skipped = result.manifest.skippedSources;
    expect(skipped.map((entry) => entry.id)).toEqual([OLDER_ID]);
    expect(skipped[0]!.label).toBe(`Rules v${OLDER}`);
    expect(skipped[0]!.reason).toContain("hasna:agent-operating-rules");
  });

  test("a semantic-policy collapse also raises a warning an operator can see", () => {
    const result = plan([
      { id: OLDER_ID, label: `Rules v${OLDER}`, layer: "global", order: 0, content: rulesPayload(OLDER, "Older policy body.") },
      { id: NEWER_ID, label: `Rules v${NEWER}`, layer: "global", order: 1, content: rulesPayload(NEWER, "Newer policy body.") },
    ]);

    // `warnings` is the surface the human CLI output prints; the manifest copy is what
    // an automated consumer reads. A fix that populated only one of them would leave
    // half the fleet's callers still blind.
    expect(result.warnings.some((warning) => warning.includes(OLDER_ID))).toBe(true);
    expect(result.manifest.warnings.some((warning) => warning.includes(OLDER_ID))).toBe(true);
  });

  test("the collapse is reported whichever source wins, so the report is not position-keyed", () => {
    // Reversed argument order: the newer payload now comes FIRST, so the discarded
    // source is not the last one passed. The originally reported symptom included
    // exactly this ("lost a config that was NOT the last"), which is why the reporter
    // could not steer it by appending a sacrificial slug.
    const result = plan([
      { id: NEWER_ID, label: `Rules v${NEWER}`, layer: "global", order: 0, content: rulesPayload(NEWER, "Newer policy body.") },
      { id: OLDER_ID, label: `Rules v${OLDER}`, layer: "global", order: 1, content: rulesPayload(OLDER, "Older policy body.") },
    ]);

    expect(result.manifest.sources.map((source) => source.id)).toEqual([NEWER_ID]);
    expect(result.manifest.skippedSources.map((entry) => entry.id)).toEqual([OLDER_ID]);
  });

  test("a replace-merge source reports the earlier sources it supersedes", () => {
    const result = plan([
      { id: "superseded", label: "Superseded", layer: "global", order: 0, content: "Replaced guidance." },
      { id: "protected", label: "Protected", layer: "global", order: 1, content: "Kept guidance.", nonOverridable: true },
      { id: "replacer", label: "Replacer", layer: "global", order: 2, merge: "replace", content: "Authoritative guidance." },
    ]);

    // `nonOverridable` sources survive a replace; ordinary earlier ones do not.
    expect(result.manifest.sources.map((source) => source.id)).toEqual(["protected", "replacer"]);

    const skipped = result.manifest.skippedSources;
    expect(skipped.map((entry) => entry.id)).toEqual(["superseded"]);
    expect(skipped[0]!.reason).toContain("replace");
    expect(result.warnings.some((warning) => warning.includes("superseded"))).toBe(true);
  });

  test("caller-supplied skipped sources survive alongside render-time ones", () => {
    // `instructions session apply --profile` feeds provider-filtered configs in through
    // `input.skippedSources`. Those entries predate this fix and must not be clobbered
    // by the render-time list.
    const result = planSessionRender({
      tool: "claude",
      profile: "octavia-regression",
      targetHome: "/tmp/octavia-regression-home",
      generatedAt: "2026-08-02T00:00:00.000Z",
      skippedSources: [
        { id: "provider-filtered", label: "Provider Filtered", targetProviders: ["opencode"], reason: "rule targets a different provider" },
      ],
      sources: [
        { id: OLDER_ID, label: `Rules v${OLDER}`, layer: "global", order: 0, content: rulesPayload(OLDER, "Older policy body.") },
        { id: NEWER_ID, label: `Rules v${NEWER}`, layer: "global", order: 1, content: rulesPayload(NEWER, "Newer policy body.") },
      ],
    });

    expect(result.manifest.skippedSources.map((entry) => entry.id)).toEqual(["provider-filtered", OLDER_ID]);
  });

  test("many sources are not themselves a cause of loss", () => {
    // The bug was reported as a cap at 15. It is not a cap: 24 ordinary sources all
    // survive. This asserts the count is irrelevant so the false diagnosis cannot
    // quietly return.
    const sources: SessionInstructionSource[] = Array.from({ length: 24 }, (_, index) => ({
      id: `bulk-${String(index).padStart(2, "0")}`,
      label: `Bulk ${index}`,
      layer: "global" as const,
      order: index,
      content: `Guidance number ${index}.`,
    }));

    const result = plan(sources);

    expect(result.manifest.sources).toHaveLength(24);
    expect(result.manifest.skippedSources).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
