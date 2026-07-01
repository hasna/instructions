import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySessionRender, checkSessionRenderDrift } from "./session-apply";
import { planSessionRender, sourcesFromIdentityExport, type SessionInstructionSource, type SessionRenderTool } from "./session-render";

let tmpRoot = "";

const globalIdentity: SessionInstructionSource = {
  id: "global-codewith",
  label: "Global Codewith Identity",
  layer: "global",
  order: 0,
  content: "Use the shared Hasna engineering rules.",
};

const agentIdentity: SessionInstructionSource = {
  id: "agent-marcus",
  label: "Marcus Agent Identity",
  layer: "agent",
  order: 10,
  content: "Prefer repository-local evidence and focused tests.",
};

beforeEach(() => {
  tmpRoot = join(tmpdir(), `open-configs-session-apply-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function targetFor(name: string): string {
  return join(tmpRoot, name);
}

describe("session apply writer", () => {
  test("dry-run reports creates without writing files", () => {
    const targetHome = targetFor("codex");
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [globalIdentity],
    });

    const result = applySessionRender(plan, { dryRun: true });

    expect(result.applied).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.files.map((file) => file.action)).toEqual(["create", "create"]);
    expect(result.snapshotPath).toBeNull();
    expect(existsSync(join(targetHome, "AGENTS.md"))).toBe(false);
  });

  test("writes Claude, Codex, Cursor, OpenCode, and Codewith adapter files", () => {
    const adapters: Array<{ tool: SessionRenderTool; targetHome: string; expected: string[]; projectRoot?: string }> = [
      {
        tool: "claude",
        targetHome: targetFor("claude"),
        expected: ["CLAUDE.md", ".hasna/instructions/01-global-codewith.md", ".hasna/instructions/02-agent-marcus.md"],
      },
      {
        tool: "codex",
        targetHome: targetFor("codex"),
        expected: ["AGENTS.md"],
      },
      {
        tool: "cursor",
        targetHome: targetFor("cursor-project"),
        projectRoot: targetFor("cursor-project"),
        expected: [".cursor/rules/01-global-codewith.mdc", ".cursor/rules/02-agent-marcus.mdc"],
      },
      {
        tool: "opencode",
        targetHome: targetFor("opencode"),
        expected: ["AGENTS.md", "opencode.json", ".hasna/instructions/01-global-codewith.md", ".hasna/instructions/02-agent-marcus.md"],
      },
      {
        tool: "codewith",
        targetHome: targetFor("codewith"),
        expected: ["CODEWITH.md"],
      },
    ];

    for (const adapter of adapters) {
      const plan = planSessionRender({
        tool: adapter.tool,
        profile: "account999",
        targetHome: adapter.targetHome,
        projectRoot: adapter.projectRoot,
        sources: [globalIdentity, agentIdentity],
      });
      const result = applySessionRender(plan);

      expect(result.applied).toBe(true);
      expect(result.conflicts).toEqual([]);
      for (const file of adapter.expected) {
        expect(existsSync(join(adapter.targetHome, ...file.split("/")))).toBe(true);
      }
      expect(existsSync(join(adapter.targetHome, ".hasna", "session-render-manifest.json"))).toBe(true);
    }
  });

  test("blocks unmanaged file conflicts unless forced", () => {
    const targetHome = targetFor("codex-conflict");
    mkdirSync(targetHome, { recursive: true });
    writeFileSync(join(targetHome, "AGENTS.md"), "human-owned content\n");
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [globalIdentity],
    });

    const conflict = applySessionRender(plan);
    expect(conflict.applied).toBe(false);
    expect(conflict.conflicts).toHaveLength(1);
    expect(readFileSync(join(targetHome, "AGENTS.md"), "utf-8")).toBe("human-owned content\n");

    const forced = applySessionRender(plan, { force: true });
    expect(forced.applied).toBe(true);
    expect(readFileSync(join(targetHome, "AGENTS.md"), "utf-8")).toContain("Global Codewith Identity");
  });

  test("does not silently adopt identical unmanaged files", () => {
    const targetHome = targetFor("codex-identical-unmanaged");
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [globalIdentity],
    });
    mkdirSync(targetHome, { recursive: true });
    writeFileSync(join(targetHome, "AGENTS.md"), plan.files[0]!.content);

    const conflict = applySessionRender(plan);
    expect(conflict.applied).toBe(false);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]?.reason).toContain("existing unmanaged file");
    expect(existsSync(join(targetHome, ".hasna", "session-render-manifest.json"))).toBe(false);
  });

  test("allows managed updates and writes a snapshot", () => {
    const targetHome = targetFor("codex-managed");
    const first = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [globalIdentity],
      generatedAt: "2026-07-01T00:00:00.000Z",
    });
    applySessionRender(first);

    const second = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [{ ...globalIdentity, content: "Updated managed content." }],
      generatedAt: "2026-07-01T00:01:00.000Z",
    });
    const result = applySessionRender(second);

    expect(result.conflicts).toEqual([]);
    expect(typeof result.snapshotPath).toBe("string");
    expect(existsSync(result.snapshotPath!)).toBe(true);
    expect(readFileSync(result.snapshotPath!, "utf-8")).toContain("Use the shared Hasna engineering rules.");
    expect(result.files.find((file) => file.relativePath === "AGENTS.md")?.action).toBe("update");
    expect(readFileSync(join(targetHome, "AGENTS.md"), "utf-8")).toContain("Updated managed content.");
  });

  test("detects drift from previous manifest before apply", () => {
    const targetHome = targetFor("codex-drift");
    const first = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [globalIdentity],
    });
    applySessionRender(first);
    writeFileSync(join(targetHome, "AGENTS.md"), "Human edit after manifest.\n");

    const drift = checkSessionRenderDrift(targetHome);
    expect(drift.checked).toBe(true);
    expect(drift.clean).toBe(false);
    expect(drift.drifted[0]?.relativePath).toBe("AGENTS.md");

    const second = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      sources: [{ ...globalIdentity, content: "Updated managed content." }],
    });
    const conflict = applySessionRender(second);
    expect(conflict.applied).toBe(false);
    expect(conflict.conflicts[0]?.reason).toContain("existing unmanaged file");
    expect(conflict.drift.clean).toBe(false);
  });

  test("removes stale managed Cursor rules from the previous manifest", () => {
    const targetHome = targetFor("cursor-stale");
    const first = planSessionRender({
      tool: "cursor",
      profile: "account999",
      projectRoot: targetHome,
      sources: [globalIdentity, agentIdentity],
      generatedAt: "2026-07-01T00:00:00.000Z",
    });
    applySessionRender(first);
    const stalePath = join(targetHome, ".cursor", "rules", "02-agent-marcus.mdc");
    expect(existsSync(stalePath)).toBe(true);

    const second = planSessionRender({
      tool: "cursor",
      profile: "account999",
      projectRoot: targetHome,
      sources: [globalIdentity],
      generatedAt: "2026-07-01T00:01:00.000Z",
    });
    const result = applySessionRender(second);

    expect(result.conflicts).toEqual([]);
    expect(typeof result.snapshotPath).toBe("string");
    expect(result.files.find((file) => file.relativePath === ".cursor/rules/02-agent-marcus.mdc")?.action).toBe("delete");
    expect(existsSync(stalePath)).toBe(false);
  });

  test("conflicts before removing stale managed files that changed", () => {
    const targetHome = targetFor("cursor-stale-edited");
    const first = planSessionRender({
      tool: "cursor",
      profile: "account999",
      projectRoot: targetHome,
      sources: [globalIdentity, agentIdentity],
    });
    applySessionRender(first);
    const stalePath = join(targetHome, ".cursor", "rules", "02-agent-marcus.mdc");
    writeFileSync(stalePath, `${readFileSync(stalePath, "utf-8")}\nHuman edit.\n`);

    const second = planSessionRender({
      tool: "cursor",
      profile: "account999",
      projectRoot: targetHome,
      sources: [globalIdentity],
    });
    const result = applySessionRender(second);

    expect(result.applied).toBe(false);
    expect(result.conflicts[0]?.relativePath).toBe(".cursor/rules/02-agent-marcus.mdc");
    expect(existsSync(stalePath)).toBe(true);
  });

  test("rejects symlink escapes inside the target home", () => {
    const targetHome = targetFor("claude-symlink");
    const outside = targetFor("outside");
    mkdirSync(targetHome, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(targetHome, ".hasna"), "dir");
    const plan = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome,
      sources: [globalIdentity],
    });

    expect(() => applySessionRender(plan)).toThrow("symlink");
    expect(existsSync(join(outside, "instructions"))).toBe(false);
  });

  test("writes identity export rules and provenance into manifest", () => {
    const targetHome = targetFor("claude-identity-export");
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "global-no-secrets",
          label: "Global No Secrets",
          layer: "global",
          merge: "append",
          order: 0,
          content: "Use safe defaults.",
          targetProviders: ["claude"],
          rules: [{ id: "safety:no-secrets", path: "rules/no-secrets.md", content: "Never expose secrets." }],
          provenance: { source: "test-fixture" },
        },
      ],
      validation: { valid: true },
    }, { tool: "claude", path: join(tmpRoot, "identities-export.json") });
    const plan = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome,
      sources,
    });

    applySessionRender(plan);

    const rulePath = join(targetHome, ".hasna", "instructions", "rules", "global-no-secrets", "rules", "no-secrets.md");
    expect(readFileSync(rulePath, "utf-8")).toContain("Never expose secrets.");
    const manifest = JSON.parse(readFileSync(join(targetHome, ".hasna", "session-render-manifest.json"), "utf-8")) as {
      sources: Array<{ provenance: unknown; rules: unknown[] }>;
    };
    expect(manifest.sources[0]?.provenance).toMatchObject({ source: "test-fixture" });
    expect(manifest.sources[0]?.rules).toHaveLength(1);
  });

  test("applies source-path-only sources and rule-path-only rules", () => {
    const targetHome = targetFor("codewith-path-only-export");
    const exportDir = targetFor("identity-export-paths");
    mkdirSync(join(exportDir, "providers"), { recursive: true });
    writeFileSync(join(exportDir, "providers", "codewith.md"), "Resolved path-only apply content.");
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "path-only-apply",
          kind: "provider-rules",
          title: "Path Only Apply",
          precedence: 200,
          mergePolicy: "append",
          targetProviders: ["codewith"],
          sourcePaths: [{ path: "providers/codewith.md", editable: true, required: true }],
          rules: [{ id: "rule:path-only-apply", path: "rules/path-only-apply.md" }],
        },
      ],
      validation: { valid: true },
    }, { tool: "codewith", path: join(exportDir, "instructions.json") });
    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome,
      sources,
    });

    applySessionRender(plan);

    const codewith = readFileSync(join(targetHome, "CODEWITH.md"), "utf-8");
    expect(codewith).toContain("Resolved path-only apply content.");
    expect(codewith).toContain("Rule path: rules/path-only-apply.md");
  });
});
