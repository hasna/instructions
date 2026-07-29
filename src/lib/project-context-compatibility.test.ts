import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PROJECT_CONTEXT_FRAGMENT_PATH,
  PROJECT_CONTEXT_MANAGED_COMMENT,
  PROJECT_CONTEXT_MANIFEST_PATH,
  ProjectContextError,
  applyProjectContext,
  computeProjectContextSourceHash,
  parseProjectContextBundle,
  planProjectContext,
  removeProjectContextCoordinatedFile,
  type ProjectContextBundleV1,
  type ProjectContextRuntime,
} from "./project-context";
import { CODEWITH_NATIVE_IMPORTS_ENV, planSessionRender, type SessionRenderTool } from "./session-render";
import { applySessionRender } from "./session-apply";
import { makeTempRoot } from "./test-temp-root";

let tmpRoot = "";
let previousCodewithNativeImports: string | undefined;

beforeEach(() => {
  previousCodewithNativeImports = process.env[CODEWITH_NATIVE_IMPORTS_ENV];
  delete process.env[CODEWITH_NATIVE_IMPORTS_ENV];
  tmpRoot = makeTempRoot("instructions-project-context-");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (previousCodewithNativeImports === undefined) delete process.env[CODEWITH_NATIVE_IMPORTS_ENV];
  else process.env[CODEWITH_NATIVE_IMPORTS_ENV] = previousCodewithNativeImports;
});

function makeBundle(overrides: Partial<ProjectContextBundleV1> = {}): ProjectContextBundleV1 {
  const bundle: ProjectContextBundleV1 = {
    schema: "hasna.projects.project_context_bundle.v1",
    generated_at: "2026-07-22T10:00:00.000Z",
    hash: "",
    revision: "rev-7",
    freshness: "fresh",
    resolution: {
      source: "marker",
      conflict: false,
      create_allowed: false,
    },
    authority: {
      owner: "projects",
      mode: "api",
      storage: "cloud",
      availability: "available",
    },
    project: {
      id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      slug: "agent-executive-assistant",
      name: "Executive Assistant",
      kind: "project",
      status: "active",
      path: "/home/hasna/.hasna/projects/workspaces/wks_ZXg7liK4CFJ1KZjC_Fg_b",
      updated_at: "2026-07-22T09:59:00.000Z",
    },
    links: {
      todos: {
        state: "linked",
        project_id: "fbe046b7-a364-4f1c-8658-81e7234d8025",
        task_list_id: "17ffb138-8db7-485b-ae3f-d5d1852ef815",
      },
      conversations: {
        state: "linked",
        channel: "internal-ea",
      },
      mementos: {
        state: "linked",
        project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
        scope: "project",
      },
    },
    station: {
      machine_id: "447614a0-1639-44e1-87a4-f396f8502a96",
      station_id: "station01",
    },
    commands: [
      { name: "show", argv: ["projects", "show", "wks_ZXg7liK4CFJ1KZjC_Fg_b", "--json"] },
      { name: "why", argv: ["projects", "why", "wks_ZXg7liK4CFJ1KZjC_Fg_b", "--json"] },
    ],
    ...overrides,
  };
  bundle.hash = computeProjectContextSourceHash(bundle);
  return bundle;
}

function bundleJson(bundle = makeBundle()): string {
  return `${JSON.stringify(bundle)}\n`;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectContextError);
    expect((error as ProjectContextError).code).toBe(code);
  }
}

describe("legacy migration and compatibility", () => {
  test("keeps the configs executable and service contract aliases additive", () => {
    const repoRoot = join(import.meta.dir, "../..");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name: string; bin: Record<string, string> };
    const contract = JSON.parse(readFileSync(join(repoRoot, "hasna.contract.json"), "utf8")) as { bins: string[] };
    expect(pkg.name).toBe("@hasna/instructions");
    expect(pkg.bin.configs).toBe("dist/cli/index.js");
    expect(contract.bins).toContain("configs");
  });

  test("dual-reads the pre-canonical BEGIN/END marker form without adding a second block", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const target = join(tmpRoot, "AGENTS.md");
    const legacy = readFileSync(target, "utf8")
      .replace("<!-- Managed by @hasna/configs project context BEGIN", "<!-- BEGIN @hasna/configs project context")
      .replace("<!-- Managed by @hasna/configs project context END", "<!-- END @hasna/configs project context");
    writeFileSync(target, legacy);
    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);

    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const rendered = readFileSync(target, "utf8");
    expect(rendered.match(/project context BEGIN/g)).toHaveLength(1);
    expect(rendered).not.toContain("BEGIN @hasna/configs");
    expect(rendered).toContain("revision=rev-8");
  });

  test("replaces the stale EA workspace section and durable-izes /dev/fd provenance without a contradictory second block", () => {
    const target = join(tmpRoot, ".codewith", "CODEWITH.md");
    const manifestPath = join(tmpRoot, ".codewith", ".hasna", "session-render-manifest.json");
    mkdirSync(join(tmpRoot, ".codewith", ".hasna"), { recursive: true });
    const stale = [
      "<!-- Managed by @hasna/configs session render. Do not edit this generated file directly. -->",
      "# codewith session instructions",
      "",
      "Profile: live-codewith",
      "",
      "# friday",
      "",
      "Source: /dev/fd/63",
      "",
      "## Workspace",
      "",
      "- The local marker is `.project.json`, with project id `wks_ZXg7liK4CFJ1KZjC_Fg_b`, slug `ea`, name `EA`, and kind `project`.",
      "- Use `internal-ea` as the project conversations channel.",
      "",
      "## Modus Operandi",
      "",
      "Keep unrelated generated instructions.",
      "",
    ].join("\n");
    writeFileSync(target, stale);
    const staleSha = new Bun.CryptoHasher("sha256").update(stale).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify({
      schema: "hasna.configs.session-render/v1",
      tool: "codewith",
      adapterMode: "flattened-markdown",
      profile: "live-codewith",
      targetOwner: { ownedBy: "open-configs" },
      sourceHash: "legacy",
      sources: [
        { id: "friday", path: "/dev/fd/63", provenance: null },
        { id: "global-rules", path: "/durable/global-rules.md", provenance: null },
      ],
      files: [
        { relativePath: "CODEWITH.md", sha256: staleSha, role: "index", sourceIds: ["friday"] },
        { relativePath: ".hasna/instructions/01-global.md", sha256: "a".repeat(64), role: "fragment", sourceIds: ["global-rules"] },
      ],
    }, null, 2)}\n`);

    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "project-context.json"),
    });

    const rendered = readFileSync(target, "utf8");
    expect(rendered).toContain("Keep unrelated generated instructions.");
    expect(rendered).toContain("Project: `Executive Assistant` (`agent-executive-assistant`)");
    expect(rendered).not.toContain("slug `ea`, name `EA`");
    expect(rendered.match(/project context BEGIN/g)).toHaveLength(1);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      profile: string;
      targetOwner: { ownedBy: string; canonicalOwner: string };
      sources: Array<{ id: string; path: string | null }>;
      files: Array<{ relativePath: string; sourceIds: string[] }>;
      projectContext: { projectId: string };
    };
    expect(manifest.profile).toBe("live-codewith");
    expect(manifest.targetOwner).toMatchObject({ ownedBy: "open-configs", canonicalOwner: "instructions" });
    expect(manifest.sources).toContainEqual(expect.objectContaining({ id: "friday", path: "/dev/fd/63" }));
    expect(manifest.sources).toContainEqual(expect.objectContaining({ id: "global-rules", path: "/durable/global-rules.md" }));
    const projectSource = manifest.sources.find((source) => source.id === "project-context-bundle");
    expect(projectSource?.path?.endsWith("project-context-cache.json")).toBe(true);
    expect(manifest.files.find((file) => file.relativePath === "CODEWITH.md")?.sourceIds).toEqual(["friday", "project-context-bundle"]);
    expect(manifest.files).toContainEqual(expect.objectContaining({ relativePath: ".hasna/instructions/01-global.md", sourceIds: ["global-rules"] }));
    expect(manifest.projectContext.projectId).toBe("wks_ZXg7liK4CFJ1KZjC_Fg_b");
  });

  test("validates an existing legacy Codewith manifest before changing managed outputs", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const fragmentPath = join(tmpRoot, ...PROJECT_CONTEXT_FRAGMENT_PATH.split("/"));
    const targetPath = join(tmpRoot, ".codewith", "CODEWITH.md");
    const cachePath = join(tmpRoot, ".hasna", "project-context-cache.json");
    const before = [fragmentPath, targetPath, cachePath].map((path) => readFileSync(path, "utf8"));
    const legacyPath = join(tmpRoot, ".codewith", ".hasna", "session-render-manifest.json");
    mkdirSync(join(tmpRoot, ".codewith", ".hasna"), { recursive: true });
    writeFileSync(legacyPath, "{malformed\n");
    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "next.json"),
    }), "PROJECT_CONTEXT_MANIFEST_INVALID");
    expect([fragmentPath, targetPath, cachePath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  test("rejects credential-like metadata retained from a legacy session manifest", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const fragmentPath = join(tmpRoot, ...PROJECT_CONTEXT_FRAGMENT_PATH.split("/"));
    const targetPath = join(tmpRoot, ".codewith", "CODEWITH.md");
    const cachePath = join(tmpRoot, ".hasna", "project-context-cache.json");
    const before = [fragmentPath, targetPath, cachePath].map((path) => readFileSync(path, "utf8"));
    const sessionManifestPath = join(tmpRoot, ".codewith", ".hasna", "session-render-manifest.json");
    const sessionManifest = JSON.parse(readFileSync(sessionManifestPath, "utf8")) as Record<string, unknown>;
    sessionManifest.warnings = [["sk", "ant", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("-")];
    writeFileSync(sessionManifestPath, `${JSON.stringify(sessionManifest)}\n`);
    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "next.json"),
    }), "PROJECT_CONTEXT_MANIFEST_INVALID");
    expect([fragmentPath, targetPath, cachePath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  test("keeps project context composed across routine Claude, Codewith, and Codex session rerenders", () => {
    const cases: Array<{ runtime: ProjectContextRuntime; tool: SessionRenderTool; targetHome: (root: string) => string; target: (root: string) => string }> = [
      { runtime: "claude", tool: "claude", targetHome: (root) => root, target: (root) => join(root, "CLAUDE.md") },
      { runtime: "codewith", tool: "codewith", targetHome: (root) => join(root, ".codewith"), target: (root) => join(root, ".codewith", "CODEWITH.md") },
      { runtime: "agents", tool: "codex", targetHome: (root) => root, target: (root) => join(root, "AGENTS.md") },
    ];

    for (const item of cases) {
      const root = join(tmpRoot, item.runtime);
      mkdirSync(item.targetHome(root), { recursive: true });
      const first = planSessionRender({
        tool: item.tool,
        profile: "live-codewith",
        targetHome: item.targetHome(root),
        sources: [{
          id: "global-rules",
          layer: "global",
          content: "Original session rules.",
          provenance: { source: "test-fixture", generatedAt: "2026-07-22T09:00:00.000Z" },
        }],
      });
      expect(applySessionRender(first).applied).toBe(true);
      const sessionManifestPath = item.runtime === "codewith"
        ? join(root, ".codewith", ".hasna", "session-render-manifest.json")
        : join(root, ".hasna", "session-render-manifest.json");
      const beforeContext = JSON.parse(readFileSync(sessionManifestPath, "utf8")) as Record<string, unknown>;
      beforeContext.warnings = ["pre-existing session warning"];
      writeFileSync(sessionManifestPath, `${JSON.stringify(beforeContext, null, 2)}\n`);

      applyProjectContext({
        workspace_root: root,
        runtime: item.runtime,
        bundle_json: bundleJson(),
        source_path: join(root, "bundle.json"),
      });
      const compatibilityManifest = JSON.parse(readFileSync(sessionManifestPath, "utf8")) as {
        env: Record<string, string>;
        warnings: string[];
        sources: Array<{ id: string; provenance: unknown }>;
      };
      expect(Object.values(compatibilityManifest.env)).toContain(item.targetHome(root));
      expect(compatibilityManifest.warnings).toContain("pre-existing session warning");
      expect(compatibilityManifest.sources.find((source) => source.id === "global-rules")?.provenance).toEqual({
        source: "test-fixture",
        generatedAt: "2026-07-22T09:00:00.000Z",
      });

      const rerender = planSessionRender({
        tool: item.tool,
        profile: "live-codewith",
        targetHome: item.targetHome(root),
        sources: [{ id: "global-rules", layer: "global", content: "Updated session rules." }],
      });
      const index = rerender.files.find((file) => file.role === "index");
      expect(index?.content).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
      expect(rerender.manifest.sources.map((source) => source.id)).toContain("project-context-bundle");
      expect(rerender.manifest.projectContext?.projectId).toBe("wks_ZXg7liK4CFJ1KZjC_Fg_b");

      const result = applySessionRender(rerender);
      expect(result.applied).toBe(true);
      expect(result.conflicts).toEqual([]);
      const updatedRules = rerender.files.find((file) => file.content.includes("Updated session rules."));
      expect(updatedRules).toBeDefined();
      expect(readFileSync(updatedRules!.path, "utf8")).toContain("Updated session rules.");
      const rendered = readFileSync(item.target(root), "utf8");
      expect(rendered).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
      expect(rendered.match(/project context BEGIN/g)).toHaveLength(1);
    }
  });

  test("rejects a stale session plan instead of downgrading newer durable project context", () => {
    const first = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Original session rules." }],
    });
    expect(applySessionRender(first).applied).toBe(true);
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const stalePlan = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Stale planned rules." }],
    });
    const newer = makeBundle({ revision: "rev-8" });
    newer.hash = computeProjectContextSourceHash(newer);
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(newer),
      source_path: join(tmpRoot, "newer.json"),
    });

    expectCode(() => applySessionRender(stalePlan), "PROJECT_CONTEXT_SESSION_STALE");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("revision=rev-8");
    expect(readFileSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")), "utf8")).toContain('"revision": "rev-8"');
    expect(existsSync(join(tmpRoot, ".hasna", "project-context.lock"))).toBe(false);

    const freshPlan = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Fresh planned rules." }],
    });
    expect(applySessionRender(freshPlan).applied).toBe(true);
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("Fresh planned rules.");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("revision=rev-8");
  });

  test("rejects a session plan created before the first project-context activation", () => {
    const stalePlan = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Pre-activation session rules." }],
    });
    expect(stalePlan.projectContextGuard).toBeDefined();

    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    expectCode(() => applySessionRender(stalePlan), "PROJECT_CONTEXT_SESSION_STALE");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
    expect(readFileSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")), "utf8")).toContain('"revision": "rev-7"');

    const freshPlan = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Post-activation session rules." }],
    });
    expect(applySessionRender(freshPlan).applied).toBe(true);
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("Post-activation session rules.");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
  });

  test("preserves an ordinary edit made after session guard validation", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const target = join(tmpRoot, "AGENTS.md");
    const sessionManifest = join(tmpRoot, ".hasna", "session-render-manifest.json");
    const manifestBefore = readFileSync(sessionManifest, "utf8");
    const plan = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "New planned session rules." }],
    });
    const concurrentEdit = `${readFileSync(target, "utf8")}ordinary concurrent edit\n`;

    expect(() => applySessionRender(plan, {
      test_hooks: {
        before_apply_writes: () => writeFileSync(target, concurrentEdit),
      },
    })).toThrow("changed after planning");

    expect(readFileSync(target, "utf8")).toBe(concurrentEdit);
    expect(readFileSync(sessionManifest, "utf8")).toBe(manifestBefore);
    expect(existsSync(join(tmpRoot, ".hasna", "project-context.lock"))).toBe(false);
  });

  test("rejects Codewith rerenders when an override shadows the managed target", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const targetHome = join(tmpRoot, ".codewith");
    const stalePlan = planSessionRender({
      tool: "codewith",
      profile: "live-codewith",
      targetHome,
      sources: [{ id: "global-rules", layer: "global", content: "Session rules." }],
    });

    writeFileSync(join(targetHome, "CODEWITH.override.md"), "shadowing user override\n");
    expectCode(() => applySessionRender(stalePlan), "PROJECT_CONTEXT_SESSION_STALE");
    expectCode(() => planSessionRender({
      tool: "codewith",
      profile: "live-codewith",
      targetHome,
      sources: [{ id: "global-rules", layer: "global", content: "Fresh session rules." }],
    }), "PROJECT_CONTEXT_SHADOWED");
    expect(readFileSync(join(targetHome, "CODEWITH.md"), "utf8")).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
  });

  test("rejects a mismatched Codewith project root instead of bypassing context guards", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const unrelatedRoot = join(tmpRoot, "unrelated");
    mkdirSync(unrelatedRoot);
    expectCode(() => planSessionRender({
      tool: "codewith",
      profile: "live-codewith",
      targetHome: join(tmpRoot, ".codewith"),
      projectRoot: unrelatedRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Session rules." }],
    }), "PROJECT_CONTEXT_PATH_INVALID");
    expect(readFileSync(join(tmpRoot, ".codewith", "CODEWITH.md"), "utf8")).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
  });

  test("keeps the durable Codewith adapter mode authoritative across session rerenders", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      codewith_native_imports: true,
    });
    const targetHome = join(tmpRoot, ".codewith");
    expect(readFileSync(join(targetHome, "CODEWITH.md"), "utf8")).toContain(`@../${PROJECT_CONTEXT_FRAGMENT_PATH}`);

    expectCode(() => planSessionRender({
      tool: "codewith",
      profile: "live-codewith",
      targetHome,
      sources: [{ id: "global-rules", layer: "global", content: "Mismatched mode rules." }],
    }), "PROJECT_CONTEXT_ADAPTER_MISMATCH");

    process.env[CODEWITH_NATIVE_IMPORTS_ENV] = "1";
    const matchingPlan = planSessionRender({
      tool: "codewith",
      profile: "live-codewith",
      targetHome,
      sources: [{ id: "global-rules", layer: "global", content: "Matching mode rules." }],
    });
    expect(applySessionRender(matchingPlan).applied).toBe(true);
    expect(readFileSync(join(targetHome, "CODEWITH.md"), "utf8")).toContain(`@../${PROJECT_CONTEXT_FRAGMENT_PATH}`);
    const sessionManifest = JSON.parse(readFileSync(join(targetHome, ".hasna", "session-render-manifest.json"), "utf8")) as { adapterMode: string };
    expect(sessionManifest.adapterMode).toBe("native-imports");
  });

  test("creates an adoption manifest when project context arrives before the first session render", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    expect(existsSync(join(tmpRoot, ".hasna", "session-render-manifest.json"))).toBe(true);

    const firstSession = planSessionRender({
      tool: "codex",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "First session rules." }],
    });
    const applied = applySessionRender(firstSession);
    expect(applied.applied).toBe(true);
    expect(applied.conflicts).toEqual([]);
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("First session rules.");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
  });

  test("uses a separate bounded reader for valid session manifests larger than 32 KiB", () => {
    const first = planSessionRender({
      tool: "claude",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Session rules." }],
    });
    expect(applySessionRender(first).applied).toBe(true);
    const sessionManifestPath = join(tmpRoot, ".hasna", "session-render-manifest.json");
    const manifest = JSON.parse(readFileSync(sessionManifestPath, "utf8")) as Record<string, unknown>;
    manifest.compatibilityPadding = "x".repeat(40 * 1024);
    writeFileSync(sessionManifestPath, `${JSON.stringify(manifest)}\n`);
    expect(statSync(sessionManifestPath).size).toBeGreaterThan(32 * 1024);

    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }).applied).toBe(true);
    const updated = JSON.parse(readFileSync(sessionManifestPath, "utf8")) as Record<string, unknown>;
    expect(updated.compatibilityPadding).toBeUndefined();
    expect((updated.projectContext as { projectId: string }).projectId).toBe("wks_ZXg7liK4CFJ1KZjC_Fg_b");
  });

  test("does not inject context into a provider runtime that was not selected", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const claude = planSessionRender({
      tool: "claude",
      profile: "live-codewith",
      targetHome: tmpRoot,
      sources: [{ id: "global-rules", layer: "global", content: "Claude rules." }],
    });
    expect(claude.manifest.projectContext).toBeUndefined();
    expect(claude.manifest.sources.map((source) => source.id)).not.toContain("project-context-bundle");
    expect(claude.files[0]?.content).not.toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
  });
});

