import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_RULE_FILE_CHAR_LIMIT,
  CODEWITH_NATIVE_IMPORTS_ENV,
  SESSION_INSTRUCTION_LAYERS,
  SESSION_LAYER_RANK,
  planSessionRender,
  resolveSessionPath,
  sourcesFromIdentityExport,
  type SessionInstructionSource,
} from "./session-render";

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

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

let tmpRoot = "";
let previousRawHome: string | undefined;
let previousHome: string | undefined;
let previousCodewithNativeImports: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "open-configs-session-render-"));
  previousRawHome = process.env["HASNA_CONFIGS_HOME"];
  previousHome = process.env["HOME"];
  previousCodewithNativeImports = process.env[CODEWITH_NATIVE_IMPORTS_ENV];
  process.env["HASNA_CONFIGS_HOME"] = join(tmpRoot, "raw");
  process.env["HOME"] = join(tmpRoot, "home");
  delete process.env[CODEWITH_NATIVE_IMPORTS_ENV];
});

afterEach(() => {
  restoreEnv("HASNA_CONFIGS_HOME", previousRawHome);
  restoreEnv("HOME", previousHome);
  restoreEnv(CODEWITH_NATIVE_IMPORTS_ENV, previousCodewithNativeImports);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("session render planner", () => {
  test("defaults to an absolute raw-store session home", () => {
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      sessionId: "sess-1",
      generatedAt: "2026-07-01T00:00:00.000Z",
      sources: [globalIdentity],
    });

    expect(plan.targetHome).toBe(join(tmpRoot, "raw", "sessions", "codex", "account999", "sess-1"));
    expect(plan.targetKind).toBe("session-home");
    expect(plan.targetOwner.kind).toBe("provider-profile");
    expect(plan.writable).toBe(true);
    expect(plan.files[0]?.path).toBe(join(plan.targetHome, "AGENTS.md"));
    expect(plan.targetHome).not.toContain("~");
  });

  test("rejects empty renders unless explicitly allowed", () => {
    expect(() =>
      planSessionRender({
        tool: "codex",
        profile: "account999",
        targetHome: "/tmp/codex-account999",
        sources: [],
      })
    ).toThrow("no instruction sources");

    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      sources: [],
      allowEmptySources: true,
    });
    expect(plan.warnings).toContain("No instruction sources were provided.");
  });

  test("rejects individual empty sources unless explicitly allowed", () => {
    expect(() =>
      planSessionRender({
        tool: "codex",
        profile: "account999",
        targetHome: "/tmp/codex-account999",
        sources: [{ id: "empty-source", content: "", layer: "global" }],
      })
    ).toThrow("empty");
  });

  test("expands quoted tilde paths for apply-consumable targets", () => {
    const plan = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome: '"~/claude-account999"',
      sources: [globalIdentity],
    });

    expect(plan.targetHome).toBe(join(tmpRoot, "home", "claude-account999"));
    expect(resolveSessionPath("'{{HOME}}/sources/global.md'")).toBe(join(tmpRoot, "home", "sources", "global.md"));
  });

  test("plans Claude native imports into profile-scoped CLAUDE.md", () => {
    const plan = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome: "/tmp/claude-account999",
      generatedAt: "2026-07-01T00:00:00.000Z",
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("native-imports");
    expect(plan.env).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/claude-account999" });
    expect(plan.files[0]?.relativePath).toBe("CLAUDE.md");
    expect(plan.files[0]?.content).toContain("@./.hasna/instructions/01-global-codewith.md");
    expect(plan.files[0]?.content).toContain("@./.hasna/instructions/02-agent-marcus.md");
    expect(plan.files.filter((file) => file.role === "fragment")).toHaveLength(2);
    expect(plan.manifest.files[0]?.sha256).toBe(plan.files[0]?.sha256);
    expect(plan.manifestFile.path).toBe("/tmp/claude-account999/.hasna/session-render-manifest.json");
  });

  test("plans Codex as one flattened AGENTS.md without native imports", () => {
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("flattened-markdown");
    expect(plan.env).toEqual({ CODEX_HOME: "/tmp/codex-account999" });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.relativePath).toBe("AGENTS.md");
    expect(plan.files[0]?.content).toContain("Global Codewith Identity");
    expect(plan.files[0]?.content).toContain("Marcus Agent Identity");
    expect(plan.files[0]?.content).not.toContain("@./.hasna/instructions");
  });

  test("plans Cursor as project-owned MDC files", () => {
    const projectRoot = join(tmpRoot, "repo");
    const plan = planSessionRender({
      tool: "cursor",
      profile: "account999",
      projectRoot,
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("cursor-mdc");
    expect(plan.targetKind).toBe("project-root");
    expect(plan.targetOwner.kind).toBe("project");
    expect(plan.blocked).toBe(false);
    expect(plan.files.map((file) => file.relativePath)).toEqual([
      ".cursor/rules/01-global-codewith.mdc",
      ".cursor/rules/02-agent-marcus.mdc",
    ]);
    expect(plan.files[0]?.path).toBe(join(projectRoot, ".cursor", "rules", "01-global-codewith.mdc"));
  });

  test("plans Antigravity as project-owned .agents rules", () => {
    const projectRoot = join(tmpRoot, "repo");
    const plan = planSessionRender({
      tool: "antigravity",
      profile: "account999",
      projectRoot,
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("antigravity-rules");
    expect(plan.targetKind).toBe("project-root");
    expect(plan.targetOwner.kind).toBe("project");
    expect(plan.files.map((file) => file.relativePath)).toEqual([
      ".agents/rules/01-global-codewith.md",
      ".agents/rules/02-agent-marcus.md",
    ]);
    expect(plan.files[0]?.content).toContain("Global Codewith Identity");
  });

  test("blocks Antigravity planning until a repository root is explicit", () => {
    const plan = planSessionRender({
      tool: "antigravity",
      profile: "account999",
      targetHome: join(tmpRoot, "not-a-repo-root"),
      sources: [globalIdentity],
    });

    expect(plan.blocked).toBe(true);
    expect(plan.writable).toBe(false);
    expect(plan.targetKind).toBe("blocked");
    expect(plan.files).toEqual([]);
    expect(plan.blockers.join("\n")).toContain("Antigravity rules are project-scoped");
  });

  test("rejects Antigravity rules over the provider file-size limit", () => {
    expect(() =>
      planSessionRender({
        tool: "antigravity",
        profile: "account999",
        projectRoot: join(tmpRoot, "repo"),
        sources: [{
          id: "oversized",
          content: "x".repeat(ANTIGRAVITY_RULE_FILE_CHAR_LIMIT + 1),
          layer: "global",
        }],
      })
    ).toThrow("limits rule files");
  });

  test("blocks Cursor planning until a repository root is explicit", () => {
    const plan = planSessionRender({
      tool: "cursor",
      profile: "account999",
      targetHome: join(tmpRoot, "not-a-repo-root"),
      sources: [globalIdentity],
    });

    expect(plan.blocked).toBe(true);
    expect(plan.writable).toBe(false);
    expect(plan.targetKind).toBe("blocked");
    expect(plan.targetOwner.kind).toBe("blocked");
    expect(plan.files).toEqual([]);
    expect(plan.blockers.join("\n")).toContain("Cursor rules are project-scoped");
  });

  test("plans OpenCode as managed AGENTS.md plus opencode.json instructions and fragments", () => {
    const plan = planSessionRender({
      tool: "opencode",
      profile: "account999",
      targetHome: "/tmp/opencode-account999",
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("opencode-instructions");
    expect(plan.env).toEqual({ OPENCODE_CONFIG_DIR: "/tmp/opencode-account999" });
    expect(plan.files[0]?.relativePath).toBe("AGENTS.md");
    expect(plan.files[0]?.role).toBe("index");
    expect(plan.files[0]?.content).toContain("Managed by @hasna/configs");
    expect(plan.files[0]?.content).toContain("Global Codewith Identity");
    expect(plan.files[1]?.relativePath).toBe("opencode.json");
    const config = JSON.parse(plan.files[1]!.content) as { instructions: string[] };
    expect(config.instructions).toEqual([
      ".hasna/instructions/01-global-codewith.md",
      ".hasna/instructions/02-agent-marcus.md",
    ]);
    expect(plan.files.filter((file) => file.role === "fragment")).toHaveLength(2);
  });

  test("plans Codewith as flattened CODEWITH.md until native imports are gated on", () => {
    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("flattened-markdown");
    expect(plan.env).toEqual({ CODEWITH_HOME: "/tmp/codewith-account999" });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.relativePath).toBe("CODEWITH.md");
    expect(plan.files[0]?.content).not.toContain("@./.hasna/instructions");
    expect(plan.files[0]?.content).toContain("Global Codewith Identity");
  });

  test("orders the managed prompt hierarchy from global to local", () => {
    expect(SESSION_INSTRUCTION_LAYERS).toEqual([
      "global",
      "tool",
      "account",
      "machine",
      "division",
      "workspace",
      "repo",
      "path",
      "agent",
      "session",
      "local",
    ]);
    expect(SESSION_LAYER_RANK.global).toBeLessThan(SESSION_LAYER_RANK.machine);
    expect(SESSION_LAYER_RANK.machine).toBeLessThan(SESSION_LAYER_RANK.repo);
    expect(SESSION_LAYER_RANK.repo).toBeLessThan(SESSION_LAYER_RANK.session);
    expect(SESSION_LAYER_RANK.session).toBeLessThan(SESSION_LAYER_RANK.local);
  });

  test("normalizes legacy public layer aliases at render time", () => {
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      sources: [
        { id: "provider-alias", content: "provider alias", layer: "provider" },
        { id: "project-alias", content: "project alias", layer: "project" },
        { id: "identity-alias", content: "identity alias", layer: "identity" },
      ],
    });

    expect(plan.manifest.sources.map((source) => [source.id, source.layer])).toEqual([
      ["provider-alias", "tool"],
      ["project-alias", "repo"],
      ["identity-alias", "agent"],
    ]);
  });

  test("plans Codewith native imports only when the runtime gate is enabled", () => {
    process.env[CODEWITH_NATIVE_IMPORTS_ENV] = "1";
    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [globalIdentity, agentIdentity],
    });

    expect(plan.adapter.mode).toBe("native-imports");
    expect(plan.files[0]?.relativePath).toBe("CODEWITH.md");
    expect(plan.files[0]?.content).toContain("@./.hasna/instructions/01-global-codewith.md");
    expect(plan.files[0]?.content).toContain("@./.hasna/instructions/02-agent-marcus.md");
  });

  test("replace source preserves non-overridable safety sources", () => {
    const protectedGlobal: SessionInstructionSource = {
      ...globalIdentity,
      nonOverridable: true,
      rules: [{ id: "safety:no-secrets", path: "rules/no-secrets.md", content: "Never expose secrets." }],
    };
    const replacingAgent: SessionInstructionSource = {
      ...agentIdentity,
      merge: "replace",
    };
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      sources: [protectedGlobal, replacingAgent],
    });

    expect(plan.manifest.sources.map((source) => source.id)).toEqual(["global-codewith", "agent-marcus"]);
    expect(plan.files[0]?.content).toContain("Global Codewith Identity");
    expect(plan.files[0]?.content).toContain("Marcus Agent Identity");
  });

  test("records deterministic hashes for planned files and source graph", () => {
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      generatedAt: "2026-07-01T00:00:00.000Z",
      sources: [globalIdentity],
    });

    expect(plan.files[0]?.sha256).toBe(hash(plan.files[0]!.content));
    expect(plan.manifest.files[0]?.sha256).toBe(plan.files[0]?.sha256);
    expect(plan.manifest.sourceHash).toHaveLength(64);
  });

  test("orders identity exports by layer rank and provider filters", () => {
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "project-overlay",
          label: "Project Overlay",
          layer: "project",
          merge: "append",
          order: 700,
          content: "Project rules.",
          targetProviders: ["codewith"],
          owner: { kind: "project", id: "global-agent-rules-standard" },
        },
        {
          id: "provider-codewith",
          label: "Provider Codewith",
          layer: "tool",
          merge: "append",
          order: 200,
          content: "Codewith provider rules.",
          targetProviders: ["codewith"],
          sourcePaths: [{ path: "providers/codewith.md", editable: true, required: true }],
        },
        {
          id: "claude-only",
          label: "Claude Only",
          layer: "tool",
          merge: "append",
          order: 201,
          content: "Claude only.",
          targetProviders: ["claude"],
        },
      ],
      validation: { valid: true },
    }, { tool: "codewith", path: "/tmp/instructions.json" });

    expect(sources.map((source) => source.id)).toEqual(["project-overlay", "provider-codewith"]);
    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources,
    });

    expect(plan.manifest.sources.map((source) => source.layer)).toEqual(["tool", "repo"]);
    expect(plan.manifest.sources[0]?.sourcePaths[0]?.path).toBe("providers/codewith.md");
    expect(plan.manifest.sources[1]?.owner).toMatchObject({ kind: "project" });
  });

  test("accepts canonical OpenIdentities exports without the configs contract field", () => {
    const sources = sourcesFromIdentityExport({
      version: 1,
      package: "@hasna/identities",
      exportedAt: "2026-07-01T00:00:00.000Z",
      sources: [
        {
          id: "canonical-provider-codewith",
          kind: "provider-rules",
          title: "Canonical Provider Codewith",
          content: "Canonical Codewith provider rules.",
          owner: { kind: "provider", id: "codewith" },
          sensitivity: "internal",
          precedence: 200,
          mergePolicy: "append",
          safety: "standard",
          nonOverridable: false,
          ruleIds: [],
          targetProviders: ["codewith"],
          providerCompatibility: [],
          sourcePaths: [],
          globs: [],
          hash: "sha256:canonical",
          provenance: { createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
          metadata: {},
        },
      ],
      validation: { valid: true, sourceCount: 1, issues: [], effectiveHash: "sha256:canonical", nonOverridableSafetyRules: [] },
      metadata: {},
    }, { tool: "codewith" });

    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources,
    });

    expect(plan.manifest.sources[0]).toMatchObject({
      id: "canonical-provider-codewith",
      layer: "tool",
      merge: "append",
      order: 200,
    });
    expect(plan.files[0]?.content).toContain("Canonical Codewith provider rules.");
  });

  test("maps kind contract exports to renderer layers and merge policies", () => {
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "kind-project-overlay",
          kind: "project-overlay",
          title: "Kind Project Overlay",
          content: "Project overlay from canonical fields.",
          precedence: 700,
          mergePolicy: "replace",
          targetProviders: ["codewith"],
        },
      ],
      validation: { valid: true },
    }, { tool: "codewith" });

    expect(sources[0]).toMatchObject({
      id: "kind-project-overlay",
      label: "Kind Project Overlay",
      layer: "repo",
      merge: "replace",
      order: 700,
    });
  });

  test("resolves source-path-only identity exports relative to the export file", () => {
    const exportDir = join(tmpRoot, "identity-export");
    mkdirSync(join(exportDir, "providers"), { recursive: true });
    writeFileSync(join(exportDir, "providers", "codewith.md"), "Resolved source-path-only Codewith rules.");
    const exportPath = join(exportDir, "instructions.json");
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "path-only-codewith",
          kind: "provider-rules",
          title: "Path Only Codewith",
          precedence: 200,
          mergePolicy: "append",
          targetProviders: ["codewith"],
          sourcePaths: [{ path: "providers/codewith.md", editable: true, required: true }],
        },
      ],
      validation: { valid: true },
    }, { tool: "codewith", path: exportPath });

    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources,
    });

    expect(plan.manifest.sources[0]?.sourcePaths[0]?.path).toBe("providers/codewith.md");
    expect(plan.files[0]?.content).toContain("Source paths:");
    expect(plan.files[0]?.content).toContain("Resolved source-path-only Codewith rules.");
  });

  test("renders rule-path-only identity rules without requiring inline rule content", () => {
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "rule-path-only",
          label: "Rule Path Only",
          layer: "global",
          merge: "append",
          order: 0,
          content: "Rule path source container.",
          rules: [{ id: "safety:path-only", path: "rules/path-only.md", hash: "sha256:path-only" }],
        },
      ],
      validation: { valid: true },
    }, { tool: "claude", path: "/tmp/export.json" });

    const plan = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome: "/tmp/claude-account999",
      sources,
    });

    const ruleFile = plan.files.find((file) => file.relativePath === ".hasna/instructions/rules/rule-path-only/rules/path-only.md");
    expect(ruleFile?.content).toContain("Rule path: rules/path-only.md");
    expect(plan.manifest.sources[0]?.rules[0]).toMatchObject({ id: "safety:path-only", path: "rules/path-only.md", hash: "sha256:path-only" });
  });

  test("renders first-class identity rules and provenance", () => {
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
          rules: [{ id: "safety:no-secrets", path: "rules/no-secrets.md", content: "Never expose secrets.", hash: "sha256:test" }],
          provenance: { source: "test-fixture" },
        },
      ],
      validation: { valid: true },
    }, { tool: "claude", path: "/tmp/export.json" });

    const plan = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome: "/tmp/claude-account999",
      sources,
    });

    expect(plan.files.some((file) => file.role === "rule")).toBe(true);
    expect(plan.files.map((file) => file.relativePath)).toContain(".hasna/instructions/rules/global-no-secrets/rules/no-secrets.md");
    expect(plan.manifest.sources[0]?.rules[0]).toMatchObject({ id: "safety:no-secrets", path: "rules/no-secrets.md", hash: "sha256:test" });
    expect(plan.manifest.sources[0]?.provenance).toMatchObject({ source: "test-fixture" });
    expect(plan.files[0]?.content).toContain("@./.hasna/instructions/rules/global-no-secrets/rules/no-secrets.md");
  });

  test("filters provider-only content blocks per target tool", () => {
    const source: SessionInstructionSource = {
      id: "provider-blocks",
      layer: "tool",
      content: [
        "Shared line.",
        "<!-- @hasna-provider: codewith -->",
        "Only Codewith.",
        "<!-- @hasna-end-provider -->",
        "<!-- @hasna-provider: claude -->",
        "Only Claude.",
        "<!-- @hasna-end-provider -->",
      ].join("\n"),
    };

    const codewith = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [source],
    });
    const claude = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome: "/tmp/claude-account999",
      sources: [source],
    });

    expect(codewith.files[0]?.content).toContain("Only Codewith.");
    expect(codewith.files[0]?.content).not.toContain("Only Claude.");
    expect(claude.files.find((file) => file.role === "fragment")?.content).toContain("Only Claude.");
    expect(claude.files.find((file) => file.role === "fragment")?.content).not.toContain("Only Codewith.");
  });

  test("filters provider-only blocks in first-class rule content per target tool", () => {
    const source: SessionInstructionSource = {
      id: "provider-rule-blocks",
      layer: "tool",
      content: "Shared source.",
      rules: [
        {
          id: "rule:provider-blocks",
          content: [
            "Shared rule.",
            "<!-- @hasna-provider: claude -->",
            "Only Claude rule.",
            "<!-- @hasna-end-provider -->",
            "<!-- @hasna-provider: codewith -->",
            "Only Codewith rule.",
            "<!-- @hasna-end-provider -->",
          ].join("\n"),
        },
      ],
    };

    const codewith = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [source],
    });

    expect(codewith.files[0]?.content).toContain("Only Codewith rule.");
    expect(codewith.files[0]?.content).not.toContain("Only Claude rule.");
  });

  test("rejects duplicate identity rule paths across sources", () => {
    const sources = sourcesFromIdentityExport({
      contract: "hasna.identities.configs-instructions/v1",
      sources: [
        {
          id: "global-one",
          label: "Global One",
          layer: "global",
          merge: "append",
          order: 0,
          content: "One.",
          rules: [{ id: "rule:one", path: "rules/shared.md", content: "First." }],
        },
        {
          id: "global-two",
          label: "Global Two",
          layer: "global",
          merge: "append",
          order: 1,
          content: "Two.",
          rules: [{ id: "rule:two", path: "rules/SHARED.md", content: "Second." }],
        },
      ],
      validation: { valid: true },
    });

    expect(() =>
      planSessionRender({
        tool: "claude",
        profile: "account999",
        targetHome: "/tmp/claude-account999",
        sources,
      })
    ).toThrow("Duplicate instruction rule path");
  });
});
