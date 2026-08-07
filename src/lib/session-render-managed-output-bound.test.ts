/**
 * The writer must refuse exactly what the reader refuses.
 *
 * 0.4.23 raised the managed-output READ bound and left the WRITE unbounded, so the two agreed
 * only by headroom. Measured on origin/main @ 6091ba6 before this fix: applySessionRender wrote
 * an 8,389,869-byte AGENTS.md at rc=0 with zero conflicts, and the NEXT planSessionRender on
 * that home threw `PROJECT_CONTEXT_INPUT_TOO_LARGE: managed input exceeds 8388608 bytes` from
 * observeProjectContextSessionGuard — including the render that would have shrunk it back.
 *
 * These tests are two-sided on purpose. The oversized arms must throw and the ordinary arms must
 * stay silent: a size guard that refuses a normal render is worse than no guard, because it stops
 * every home rather than the one that outgrew the bound.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { applySessionRender } from "./session-apply";
import { planSessionRender, type SessionInstructionSource, type SessionRenderTool } from "./session-render";
import { SESSION_MANAGED_OUTPUT_MAX_BYTES, SESSION_MANAGED_OUTPUT_WARN_BYTES } from "./project-context";
import { tempRootPath } from "./test-temp-root";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = tempRootPath(`session-managed-output-bound-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function source(id: string, bytes: number): SessionInstructionSource {
  return { id, label: id, layer: "global", order: 0, content: "x".repeat(bytes) };
}

function planFor(tool: SessionRenderTool, targetHome: string, sources: SessionInstructionSource[]) {
  return planSessionRender({ tool, profile: "bound-probe", targetHome, sources });
}

/**
 * The thrown message, or the literal string "DID NOT THROW".
 *
 * Deliberately not `expect(fn).toThrow()`: on failure bun prints the returned value, and the
 * returned value here is a render plan carrying the whole 8 MiB entrypoint — measured at 48 MB
 * of test output for three failing arms. A diagnostic nobody can read is a diagnostic nobody
 * reads.
 */
function throwMessage(run: () => unknown): string {
  try {
    run();
    return "DID NOT THROW";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("managed session-render outputs are bounded at the write", () => {
  // The flattened adapters inline every source into the entrypoint, so the entrypoint is the
  // path that actually crosses the bound. codewith is included because its plan-relative path
  // (`CODEWITH.md`) differs from its workspace-relative allowlist entry (`.codewith/CODEWITH.md`)
  // — a check that compares those two strings directly passes for claude and codex and silently
  // leaves codewith unguarded.
  for (const tool of ["codex", "codewith"] as const) {
    test(`${tool}: a render past the managed read bound is refused before anything is written`, () => {
      const targetHome = join(tmpRoot, `${tool}-over`);
      const message = throwMessage(() =>
        planFor(tool, targetHome, [source("big", SESSION_MANAGED_OUTPUT_MAX_BYTES + 1024)])
      );

      expect(message).toContain("managed read bound");
      // Plan-time refusal means zero side effects: no home, no partial entrypoint, no manifest.
      expect(existsSync(targetHome)).toBe(false);
    });
  }

  test("an ordinary render is not refused and carries no headroom warning", () => {
    const targetHome = join(tmpRoot, "codex-normal");
    // 291,867 bytes was the real codex home on station01, 2026-08-08. Anchoring the negative
    // control to the measured production size is what makes its silence mean something.
    const plan = planFor("codex", targetHome, [source("real-world", 291_867)]);

    expect(plan.files.length).toBeGreaterThan(0);
    expect(plan.warnings.filter((warning) => warning.includes("Managed output"))).toEqual([]);

    const applied = applySessionRender(plan, {});
    expect(applied.applied).toBe(true);
    expect(applied.conflicts).toEqual([]);
    expect(statSync(join(targetHome, "AGENTS.md")).size).toBeGreaterThan(291_867);
  });

  test("a render past the headroom threshold warns and still applies", () => {
    const targetHome = join(tmpRoot, "codex-warn");
    const plan = planFor("codex", targetHome, [source("large", SESSION_MANAGED_OUTPUT_WARN_BYTES + 4096)]);

    const headroom = plan.warnings.filter((warning) => warning.includes("Managed output"));
    expect(headroom.length).toBeGreaterThan(0);
    expect(headroom[0]).toContain("AGENTS.md");

    // A warning that blocks the write would be a refusal wearing a warning's name.
    const applied = applySessionRender(plan, {});
    expect(applied.applied).toBe(true);
    expect(existsSync(join(targetHome, "AGENTS.md"))).toBe(true);
  });

  test("the home stays readable after the refusal — the wedge does not happen", () => {
    const targetHome = join(tmpRoot, "codex-recover");

    // A good render lands.
    const good = applySessionRender(planFor("codex", targetHome, [source("ok", 1024)]), {});
    expect(good.applied).toBe(true);
    const before = statSync(join(targetHome, "AGENTS.md")).size;

    // An oversized corpus is refused.
    expect(throwMessage(() =>
      planFor("codex", targetHome, [source("big", SESSION_MANAGED_OUTPUT_MAX_BYTES + 1024)])
    )).toContain("managed read bound");

    // The previous home is untouched, and — the property the wedge destroyed — the home can
    // still be planned and re-rendered afterwards.
    expect(statSync(join(targetHome, "AGENTS.md")).size).toBe(before);
    const recovered = applySessionRender(planFor("codex", targetHome, [source("ok2", 2048)]), {});
    expect(recovered.applied).toBe(true);
    expect(recovered.conflicts).toEqual([]);
  });
});
