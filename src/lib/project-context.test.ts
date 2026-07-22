import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

let tmpRoot = "";
let previousCodewithNativeImports: string | undefined;

beforeEach(() => {
  previousCodewithNativeImports = process.env[CODEWITH_NATIVE_IMPORTS_ENV];
  delete process.env[CODEWITH_NATIVE_IMPORTS_ENV];
  tmpRoot = mkdtempSync(join(tmpdir(), "instructions-project-context-"));
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

describe("project context bundle validation", () => {
  test("accepts the strict allowlisted v1 contract and validates its source hash", () => {
    const parsed = parseProjectContextBundle(bundleJson());

    expect(parsed.project.slug).toBe("agent-executive-assistant");
    expect(parsed.revision).toBe("rev-7");
    expect(parsed.commands).toHaveLength(2);
  });

  test("rejects additional properties, inconsistent hashes, bad enums, and too many argv commands", () => {
    const extra = { ...makeBundle(), metadata: { arbitrary: true } };
    expectCode(() => parseProjectContextBundle(JSON.stringify(extra)), "PROJECT_CONTEXT_INVALID");

    const badHash = makeBundle();
    badHash.project.name = "Changed after hashing";
    expectCode(() => parseProjectContextBundle(JSON.stringify(badHash)), "PROJECT_CONTEXT_HASH_MISMATCH");

    const badEnum = makeBundle({ authority: { owner: "projects", mode: "api", storage: "unknown" as "cloud", availability: "available" } });
    badEnum.hash = computeProjectContextSourceHash(badEnum);
    expectCode(() => parseProjectContextBundle(JSON.stringify(badEnum)), "PROJECT_CONTEXT_INVALID");

    const commands = Array.from({ length: 7 }, () => ({
      name: "show" as const,
      argv: ["projects", "show", "wks_ZXg7liK4CFJ1KZjC_Fg_b", "--json"],
    }));
    const tooMany = makeBundle({ commands });
    tooMany.hash = computeProjectContextSourceHash(tooMany);
    expectCode(() => parseProjectContextBundle(JSON.stringify(tooMany)), "PROJECT_CONTEXT_INVALID");
  });

  test("rejects parseable non-ISO and impossible calendar timestamps", () => {
    const nonIso = makeBundle({ generated_at: "July 22, 2026 10:00:00 UTC" });
    nonIso.hash = computeProjectContextSourceHash(nonIso);
    expectCode(() => parseProjectContextBundle(nonIso), "PROJECT_CONTEXT_INVALID");

    const impossible = makeBundle({
      project: { ...makeBundle().project, updated_at: "2026-02-30T09:59:00.000Z" },
    });
    impossible.hash = computeProjectContextSourceHash(impossible);
    expectCode(() => parseProjectContextBundle(impossible), "PROJECT_CONTEXT_INVALID");
  });

  test("rejects a future-dated live bundle instead of reporting it as fresh age zero", () => {
    const future = makeBundle({ generated_at: "2026-07-22T10:03:00.000Z" });
    future.hash = computeProjectContextSourceHash(future);
    expectCode(() => planProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle: future,
      now: new Date("2026-07-22T10:02:00.000Z"),
    }), "PROJECT_CONTEXT_INVALID");
  });

  test("enforces the 8 KiB encoded input limit before parsing", () => {
    expectCode(() => parseProjectContextBundle(`{"padding":"${"x".repeat(8_192)}"}`), "PROJECT_CONTEXT_INPUT_TOO_LARGE");
  });

  test("normalizes non-serializable in-process inputs to a stable validation error", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectCode(() => parseProjectContextBundle(undefined), "PROJECT_CONTEXT_INVALID");
    expectCode(() => parseProjectContextBundle(circular), "PROJECT_CONTEXT_INVALID");
  });

  test("rejects credential canaries and shell-shaped command arguments", () => {
    const secret = makeBundle({
      project: {
        ...makeBundle().project,
        name: ["sk", "ant", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("-"),
      },
    });
    secret.hash = computeProjectContextSourceHash(secret);
    expectCode(() => parseProjectContextBundle(JSON.stringify(secret)), "PROJECT_CONTEXT_SECRET_REJECTED");

    const shell = makeBundle({
      commands: [{ name: "show", argv: ["projects", "show", "$(touch /tmp/nope)"] }],
    });
    shell.hash = computeProjectContextSourceHash(shell);
    expectCode(() => parseProjectContextBundle(JSON.stringify(shell)), "PROJECT_CONTEXT_INVALID");

  });

  test("accepts producer-valid name and slug punctuation without Markdown injection", () => {
    const bundle = makeBundle({
      project: {
        ...makeBundle().project,
        slug: "Test.Slug",
        name: "Release `v2`\n**still data**",
      },
    });
    bundle.hash = computeProjectContextSourceHash(bundle);
    expect(parseProjectContextBundle(bundle).project.slug).toBe("Test.Slug");
    const plan = planProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle,
      source_path: join(tmpRoot, "bundle.json"),
    });
    expect(plan.fragment).toContain("Release \\u0060v2\\u0060\\n**still data**");
    expect(plan.fragment).toContain("`Test.Slug`");
    expect(plan.fragment).not.toContain("Release `v2`");
  });

  test("accepts an explicitly linked Mementos project with an independent workspace-shaped ID", () => {
    const bundle = makeBundle({
      links: {
        ...makeBundle().links,
        mementos: { state: "linked", project_id: "wks_mementos_independent", scope: "project" },
      },
    });
    bundle.hash = computeProjectContextSourceHash(bundle);

    expect(parseProjectContextBundle(bundle).links.mementos.project_id).toBe("wks_mementos_independent");
  });
});

describe("project context planning", () => {
  test("builds one bounded canonical fragment and drops optional commands before core identity", () => {
    const projectId = `wks_${"a".repeat(300)}`;
    const commands = Array.from({ length: 6 }, () => ({
      name: "show" as const,
      argv: ["projects", "show", projectId, "--json"],
    }));
    const bundle = makeBundle({
      freshness: "stale",
      authority: { owner: "projects", mode: "api", storage: "cloud", availability: "unavailable" },
      project: {
        ...makeBundle().project,
        id: projectId,
        name: "N".repeat(250),
        path: `/${"segment/".repeat(80)}project`,
      },
      links: {
        ...makeBundle().links,
        todos: { state: "partial", project_id: "todo", task_list_id: null },
        mementos: { state: "linked", project_id: "memory", scope: "project" },
      },
      commands,
    });
    bundle.hash = computeProjectContextSourceHash(bundle);

    const plan = planProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle,
      source_path: join(tmpRoot, "bundle.json"),
    });

    expect(Buffer.byteLength(plan.fragment, "utf8")).toBeLessThanOrEqual(4_096);
    expect(Math.ceil(plan.fragment.length / 4)).toBeLessThanOrEqual(1_000);
    expect(plan.fragment).toContain(projectId);
    expect(plan.fragment).toContain("Status: `active`");
    expect(plan.included_commands).toBeLessThan(6);
    expect(plan.warnings).toHaveLength(3);
  });

  test("drops the final optional command when core identity alone fits", () => {
    let plan: ReturnType<typeof planProjectContext> | null = null;
    for (let nameLength = 1_200; nameLength <= 3_200 && plan === null; nameLength += 25) {
      const bundle = makeBundle({
        project: { ...makeBundle().project, name: "N".repeat(nameLength) },
        commands: [{ name: "show", argv: ["projects", "show", "wks_ZXg7liK4CFJ1KZjC_Fg_b", "--json"] }],
      });
      bundle.hash = computeProjectContextSourceHash(bundle);
      try {
        const candidate = planProjectContext({
          workspace_root: tmpRoot,
          runtime: "agents",
          bundle,
          source_path: join(tmpRoot, "bundle.json"),
        });
        if (candidate.included_commands === 0) plan = candidate;
      } catch (error) {
        expect((error as ProjectContextError).code).toBe("PROJECT_CONTEXT_RENDER_TOO_LARGE");
      }
    }
    expect(plan).not.toBeNull();
    expect(plan!.fragment).not.toContain("## Safe Next Commands");
  });

  test("returns PROJECT_CONTEXT_SHADOWED when Codewith would ignore its managed target", () => {
    mkdirSync(join(tmpRoot, ".codewith"), { recursive: true });
    writeFileSync(join(tmpRoot, ".codewith", "CODEWITH.override.md"), "override\n");

    expectCode(() => planProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle: makeBundle(),
      source_path: join(tmpRoot, "bundle.json"),
    }), "PROJECT_CONTEXT_SHADOWED");
  });

  test("creates the consumed .codewith target ahead of root CODEWITH and AGENTS fallbacks without editing them", () => {
    const rootOverride = join(tmpRoot, "CODEWITH.override.md");
    const rootCodewith = join(tmpRoot, "CODEWITH.md");
    const rootAgents = join(tmpRoot, "AGENTS.md");
    writeFileSync(rootOverride, "root override fallback bytes\n");
    writeFileSync(rootCodewith, "root CODEWITH fallback bytes\n");
    writeFileSync(rootAgents, "legacy AGENTS fallback bytes\n");

    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    expect(readFileSync(rootOverride, "utf8")).toBe("root override fallback bytes\n");
    expect(readFileSync(rootCodewith, "utf8")).toBe("root CODEWITH fallback bytes\n");
    expect(readFileSync(rootAgents, "utf8")).toBe("legacy AGENTS fallback bytes\n");
    expect(readFileSync(join(tmpRoot, ".codewith", "CODEWITH.md"), "utf8")).toContain("Executive Assistant");
  });
});

describe("project context adapters and managed edits", () => {
  const cases: Array<{ runtime: ProjectContextRuntime; target: string; imported: boolean }> = [
    { runtime: "claude", target: "CLAUDE.md", imported: true },
    { runtime: "codewith", target: ".codewith/CODEWITH.md", imported: false },
    { runtime: "agents", target: "AGENTS.md", imported: false },
  ];

  for (const adapter of cases) {
    test(`preserves user bytes and applies the deterministic ${adapter.runtime} adapter`, () => {
      const target = join(tmpRoot, ...adapter.target.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      const before = "USER PREFIX\r\n\r\n";
      const after = "\r\nUSER SUFFIX\r\n";
      writeFileSync(target, `${before}${after}`);
      chmodSync(target, 0o640);

      const result = applyProjectContext({
        workspace_root: tmpRoot,
        runtime: adapter.runtime,
        bundle_json: bundleJson(),
        source_path: join(tmpRoot, "project-context.json"),
      });

      const rendered = readFileSync(target, "utf8");
      expect(rendered.startsWith(`${before}${after}`)).toBe(true);
      expect(rendered).toContain("Managed by @hasna/configs project context");
      expect(rendered.includes("@" + (adapter.runtime === "codewith" ? "../" : "") + PROJECT_CONTEXT_FRAGMENT_PATH)).toBe(adapter.imported);
      expect(rendered).toContain(adapter.imported ? "project-context.md" : "Executive Assistant");
      expect(statSync(target).mode & 0o777).toBe(0o640);
      expect(result.applied).toBe(true);
      expect(existsSync(join(tmpRoot, ...PROJECT_CONTEXT_FRAGMENT_PATH.split("/")))).toBe(true);
      expect(existsSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")))).toBe(true);
    });
  }

  test("uses the existing Codewith native-import gate when it is enabled", () => {
    process.env[CODEWITH_NATIVE_IMPORTS_ENV] = "1";
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    const rendered = readFileSync(join(tmpRoot, ".codewith", "CODEWITH.md"), "utf8");
    expect(rendered).toContain(`@../${PROJECT_CONTEXT_FRAGMENT_PATH}`);
    expect(rendered).not.toContain("# Managed Project Context");
  });

  test("replaces only the managed block while retaining later user edits byte-for-byte", () => {
    const first = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    expect(first.applied).toBe(true);
    const target = join(tmpRoot, "AGENTS.md");
    const current = readFileSync(target, "utf8");
    writeFileSync(target, `prefix\n${current}suffix without final newline`);

    const nextBundle = makeBundle({ revision: "rev-8", project: { ...makeBundle().project, name: "Executive Assistant Canonical" } });
    nextBundle.hash = computeProjectContextSourceHash(nextBundle);
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(nextBundle),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const updated = readFileSync(target, "utf8");
    expect(updated.startsWith("prefix\n")).toBe(true);
    expect(updated.endsWith("suffix without final newline")).toBe(true);
    expect(updated).toContain("Executive Assistant Canonical");
    expect(updated).not.toContain("Project: `Executive Assistant` (`agent-executive-assistant`)");
  });

  test("fails duplicate, nested, malformed, and mismatched markers without force", () => {
    const target = join(tmpRoot, "AGENTS.md");
    const begin = "<!-- Managed by @hasna/configs project context BEGIN id=wks_other revision=1 hash=sha256:abc -->";
    const end = "<!-- Managed by @hasna/configs project context END id=wks_different revision=1 hash=sha256:abc -->";
    writeFileSync(target, `${begin}\n${begin}\ntext\n${end}\n`);

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }), "MANAGED_BLOCK_INVALID");

    const forced = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      force: true,
    });
    expect(forced.applied).toBe(true);
    expect(readFileSync(target, "utf8").match(/project context BEGIN/g)).toHaveLength(1);
  });

  test("rejects a well-formed managed block for another project even with force", () => {
    const target = join(tmpRoot, "AGENTS.md");
    writeFileSync(target, [
      "before",
      "<!-- Managed by @hasna/configs project context BEGIN id=wks_other revision=1 hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
      "other project",
      "<!-- Managed by @hasna/configs project context END id=wks_other revision=1 hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
      "after",
    ].join("\n"));

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }), "MANAGED_BLOCK_CONFLICT");
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      force: true,
    }), "MANAGED_BLOCK_CONFLICT");
  });

  test("rejects symlinked workspace targets and managed paths", () => {
    const outside = join(tmpRoot, "outside.md");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(tmpRoot, "AGENTS.md"));

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }), "PROJECT_CONTEXT_SYMLINK_REJECTED");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("works in a non-git coordination workspace", () => {
    expect(existsSync(join(tmpRoot, ".git"))).toBe(false);
    const result = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    expect(result.applied).toBe(true);
  });
});

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

describe("cache, revision, crash, and race safety", () => {
  test("uses only a compatible same-ID bounded stale cache with a visible age", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      now: new Date("2026-07-22T10:00:30.000Z"),
    });

    const cached = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      allow_stale_cache: true,
      expected_project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      max_stale_age_seconds: 300,
      now: new Date("2026-07-22T10:02:00.000Z"),
    });

    expect(cached.status).toBe("stale-cache");
    expect(cached.age_seconds).toBe(120);
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("stale cache (age 120s)");

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      allow_stale_cache: true,
      expected_project_id: "wks_other",
      max_stale_age_seconds: 300,
      now: new Date("2026-07-22T10:02:00.000Z"),
    }), "PROJECT_CONTEXT_CACHE_ID_MISMATCH");

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      allow_stale_cache: true,
      expected_project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      max_stale_age_seconds: 30,
      now: new Date("2026-07-22T10:02:00.000Z"),
    }), "PROJECT_CONTEXT_CACHE_EXPIRED");
  });

  test("rejects future-dated cache metadata and bundle timestamps", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      now: new Date("2026-07-22T10:00:30.000Z"),
    });

    const cachePath = join(tmpRoot, ".hasna", "project-context-cache.json");
    const original = readFileSync(cachePath, "utf8");
    const futureCache = JSON.parse(original) as {
      cached_at: string;
      hash: string;
      bundle: ProjectContextBundleV1;
    };
    futureCache.cached_at = "2026-07-22T10:03:00.000Z";
    writeFileSync(cachePath, `${JSON.stringify(futureCache)}\n`);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      allow_stale_cache: true,
      expected_project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      max_stale_age_seconds: 300,
      now: new Date("2026-07-22T10:02:00.000Z"),
    }), "PROJECT_CONTEXT_CACHE_INVALID");

    const futureBundleCache = JSON.parse(original) as {
      cached_at: string;
      hash: string;
      bundle: ProjectContextBundleV1;
    };
    futureBundleCache.bundle.generated_at = "2026-07-22T10:03:00.000Z";
    futureBundleCache.bundle.hash = computeProjectContextSourceHash(futureBundleCache.bundle);
    futureBundleCache.hash = futureBundleCache.bundle.hash;
    writeFileSync(cachePath, `${JSON.stringify(futureBundleCache)}\n`);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      allow_stale_cache: true,
      expected_project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      max_stale_age_seconds: 300,
      now: new Date("2026-07-22T10:02:00.000Z"),
    }), "PROJECT_CONTEXT_CACHE_INVALID");
  });

  test("fails closed on malformed manifests and cache metadata", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const manifestPath = join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.files = [{ relativePath: "../../user-file", role: "fragment", sha256: "0".repeat(64) }];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "next.json"),
    }), "PROJECT_CONTEXT_MANIFEST_INVALID");

    rmSync(manifestPath);
    const cachePath = join(tmpRoot, ".hasna", "project-context-cache.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    cache.untrusted = "must not be accepted";
    writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      allow_stale_cache: true,
      expected_project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      max_stale_age_seconds: 300,
      now: new Date("2026-07-22T10:02:00.000Z"),
    }), "PROJECT_CONTEXT_CACHE_INVALID");
  });

  test("fails unknown majors by default and can fall back only to an explicit same-ID cache", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      now: new Date("2026-07-22T10:00:30.000Z"),
    });
    const future = { ...makeBundle(), schema: "hasna.projects.project_context_bundle.v2" };

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: JSON.stringify(future),
      source_path: join(tmpRoot, "future.json"),
    }), "PROJECT_CONTEXT_UNSUPPORTED_VERSION");

    const fallback = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: JSON.stringify(future),
      source_path: join(tmpRoot, "future.json"),
      allow_stale_cache: true,
      expected_project_id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      max_stale_age_seconds: 300,
      now: new Date("2026-07-22T10:02:00.000Z"),
    });
    expect(fallback.status).toBe("stale-cache");
  });

  test("prevents older revisions and equal-revision hash conflicts but permits a higher-revision rollback payload", () => {
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const older = makeBundle({ revision: "rev-6" });
    older.hash = computeProjectContextSourceHash(older);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(older),
      source_path: join(tmpRoot, "older.json"),
    }), "PROJECT_CONTEXT_REVISION_STALE");

    const conflict = makeBundle({ project: { ...makeBundle().project, name: "Conflicting Same Revision" } });
    conflict.hash = computeProjectContextSourceHash(conflict);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(conflict),
      source_path: join(tmpRoot, "conflict.json"),
    }), "PROJECT_CONTEXT_REVISION_CONFLICT");

    const rollback = makeBundle({
      revision: "rev-8",
      project: { ...makeBundle().project, name: "Rollback Target Identity" },
    });
    rollback.hash = computeProjectContextSourceHash(rollback);
    const result = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(rollback),
      source_path: join(tmpRoot, "rollback.json"),
    });
    expect(result.revision).toBe("rev-8");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("Rollback Target Identity");
  });

  test("orders producer-default timestamp revisions and encodes them safely in markers", () => {
    const current = makeBundle({ revision: "2026-07-22 10:00:00" });
    current.hash = computeProjectContextSourceHash(current);
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(current),
      source_path: join(tmpRoot, "bundle.json"),
    });
    expect(readFileSync(join(tmpRoot, ".codewith", "CODEWITH.md"), "utf8")).toContain("revision=2026-07-22%2010%3A00%3A00");

    const older = makeBundle({ revision: "2026-07-22 09:59:59" });
    older.hash = computeProjectContextSourceHash(older);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(older),
      source_path: join(tmpRoot, "older.json"),
    }), "PROJECT_CONTEXT_REVISION_STALE");

    const newer = makeBundle({ revision: "2026-07-22 10:00:01" });
    newer.hash = computeProjectContextSourceHash(newer);
    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(newer),
      source_path: join(tmpRoot, "newer.json"),
    }).revision).toBe("2026-07-22 10:00:01");
  });

  test("holds a per-workspace lock and retries one observed hash race", () => {
    const target = join(tmpRoot, "AGENTS.md");
    writeFileSync(target, "user text\n");
    let raced = false;
    const result = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_compare: ({ attempt }) => {
          if (attempt === 0 && !raced) {
            raced = true;
            writeFileSync(target, "user text changed concurrently\n");
          }
        },
      },
    });
    expect(result.race_retries).toBe(1);
    expect(readFileSync(target, "utf8")).toContain("user text changed concurrently");

    expect(existsSync(join(tmpRoot, ".hasna", "project-context.lock"))).toBe(false);
  });

  test("rechecks target CAS immediately before replacement and before committing the manifest", () => {
    const target = join(tmpRoot, "AGENTS.md");
    writeFileSync(target, "initial user bytes\n");
    let changedBeforeReplacement = false;
    const first = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        after_fragment: ({ attempt }) => {
          if (attempt === 0 && !changedBeforeReplacement) {
            changedBeforeReplacement = true;
            writeFileSync(target, "concurrent bytes before replacement\n");
          }
        },
      },
    });
    expect(first.race_retries).toBe(1);
    expect(readFileSync(target, "utf8")).toContain("concurrent bytes before replacement");

    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);
    let changedBeforeManifest = false;
    const second = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_manifest: ({ attempt }) => {
          if (attempt === 0 && !changedBeforeManifest) {
            changedBeforeManifest = true;
            writeFileSync(target, `${readFileSync(target, "utf8")}concurrent bytes before manifest\n`);
          }
        },
      },
    });
    expect(second.race_retries).toBe(1);
    expect(readFileSync(target, "utf8")).toContain("concurrent bytes before manifest");
    expect(readFileSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")), "utf8")).toContain('"revision": "rev-8"');

    const finalBundle = makeBundle({ revision: "rev-9" });
    finalBundle.hash = computeProjectContextSourceHash(finalBundle);
    let changedAfterExchange = false;
    const third = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(finalBundle),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        after_target_exchange: ({ attempt }) => {
          if (attempt === 0 && !changedAfterExchange) {
            changedAfterExchange = true;
            writeFileSync(target, `${readFileSync(target, "utf8")}concurrent bytes after atomic exchange\n`);
          }
        },
      },
    });
    expect(third.race_retries).toBe(1);
    expect(readFileSync(target, "utf8")).toContain("concurrent bytes after atomic exchange");
    expect(readFileSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")), "utf8")).toContain('"revision": "rev-9"');
  });

  test("never installs a tampered displaced temp file during exchange recovery", () => {
    const target = join(tmpRoot, "AGENTS.md");
    writeFileSync(target, "authoritative user bytes\n");
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        after_target_exchange: () => {
          const displaced = readdirSync(tmpRoot).find((entry) => /^\.project-context-.*\.tmp$/.test(entry));
          if (!displaced) throw new Error("expected displaced target temp");
          writeFileSync(join(tmpRoot, displaced), "tampered displaced bytes\n");
        },
      },
    }), "PROJECT_CONTEXT_ATOMIC_REPLACE_CONFLICT");

    const rendered = readFileSync(target, "utf8");
    expect(rendered).toContain("authoritative user bytes");
    expect(rendered).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);
    expect(rendered).not.toContain("tampered displaced bytes");
    expect(existsSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")))).toBe(false);
    expect(readdirSync(tmpRoot).some((entry) => /^\.project-context-.*\.tmp$/.test(entry))).toBe(true);
  });

  test("rejects prepared temp tampering before creating or replacing a target", () => {
    for (const existingTarget of [false, true]) {
      const workspaceRoot = join(tmpRoot, existingTarget ? "existing" : "new");
      mkdirSync(workspaceRoot, { recursive: true });
      const target = join(workspaceRoot, "AGENTS.md");
      const original = "authoritative existing bytes\n";
      if (existingTarget) writeFileSync(target, original);

      expectCode(() => applyProjectContext({
        workspace_root: workspaceRoot,
        runtime: "agents",
        bundle_json: bundleJson(),
        source_path: join(workspaceRoot, "bundle.json"),
        test_hooks: {
          before_target_install: ({ temp_path: tempPath }) => {
            writeFileSync(tempPath, "tampered prepared bytes\n");
          },
        },
      }), "PROJECT_CONTEXT_HASH_RACE");

      if (existingTarget) expect(readFileSync(target, "utf8")).toBe(original);
      else expect(existsSync(target)).toBe(false);
      expect(existsSync(join(workspaceRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")))).toBe(false);
    }
  });

  test("never follows a managed parent replaced by a symlink during installation", () => {
    const managedParent = join(tmpRoot, ".codewith");
    const displacedParent = join(tmpRoot, ".codewith-displaced");
    const outside = join(tmpRoot, "outside");
    mkdirSync(outside);
    let swapped = false;

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "codewith",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_target_install: () => {
          if (swapped) return;
          swapped = true;
          renameSync(managedParent, displacedParent);
          symlinkSync(outside, managedParent, "dir");
        },
      },
    }), "PROJECT_CONTEXT_SYMLINK_REJECTED");

    expect(existsSync(join(outside, "CODEWITH.md"))).toBe(false);
    expect(existsSync(join(displacedParent, "CODEWITH.md"))).toBe(false);
    expect(existsSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")))).toBe(false);
  });

  test("fails closed before replacing an existing target without atomic exchange support", () => {
    const target = join(tmpRoot, "AGENTS.md");
    const original = "existing user target bytes\n";
    writeFileSync(target, original);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: { atomic_exchange_unavailable: true },
    }), "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE");

    expect(readFileSync(target, "utf8")).toBe(original);
    expect(existsSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")))).toBe(false);
    expect(existsSync(join(tmpRoot, ".hasna", "project-context.lock"))).toBe(false);
  });

  test("keeps first-time rendering available on create-only platforms and fails closed on replacement", () => {
    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: { portable_create_only: true },
    }).applied).toBe(true);
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain(PROJECT_CONTEXT_MANAGED_COMMENT);

    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "next.json"),
      test_hooks: { portable_create_only: true },
    }), "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE");
    expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf8")).toContain("revision=rev-7");
  });

  test("never overwrites a concurrently recreated target while recovering a displaced deletion", () => {
    for (const forcePortableFileOps of [false, true]) {
      const target = join(tmpRoot, forcePortableFileOps ? "portable-delete.md" : "anchored-delete.md");
      const original = "managed-before-delete\n";
      const concurrent = "concurrent-recreation\n";
      let displacedPath = "";
      writeFileSync(target, original);

      expect(() => removeProjectContextCoordinatedFile({
        path: target,
        workspace_root: tmpRoot,
        expected_hash: createHash("sha256").update(original).digest("hex"),
        allow_portable_removal: true,
        force_portable_file_ops: forcePortableFileOps,
        test_hooks: {
          after_displace: (path) => {
            displacedPath = path;
            writeFileSync(target, concurrent);
          },
        },
      })).toThrow("changed during");
      expect(readFileSync(target, "utf8")).toBe(concurrent);
      expect(displacedPath).not.toBe("");
      expect(readFileSync(displacedPath, "utf8")).toBe(original);
    }
  });

  test("removes only its own lock inode when lock initialization fails", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    expect(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        after_lock_open: () => {
          throw new Error("simulated lock initialization failure");
        },
      },
    })).toThrow("simulated lock initialization failure");
    expect(existsSync(lockPath)).toBe(false);
    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }).applied).toBe(true);
  });

  test("recovers a stale malformed lock left by a pre-atomic renderer crash", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, "");
    const stale = new Date(Date.now() - (10 * 60 * 1_000));
    utimesSync(lockPath, stale, stale);
    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }).applied).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("recovers an old lock whose PID has been reused by a live process", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: "crashed-owner-with-reused-pid",
      created_at: new Date(Date.now() - (10 * 60 * 1_000)).toISOString(),
    })}\n`);

    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }).applied).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does not evict a genuine live renderer solely because its lock is old", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    let processStartId: string | null = null;
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        after_lock_open: () => {
          const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { process_start_id?: unknown };
          processStartId = typeof lock.process_start_id === "string" ? lock.process_start_id : null;
        },
      },
    });
    expect(processStartId).not.toBeNull();
    writeFileSync(lockPath, `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: "genuine-long-running-owner",
      created_at: new Date(Date.now() - (10 * 60 * 1_000)).toISOString(),
      process_start_id: processStartId,
    })}\n`);

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    }), "PROJECT_CONTEXT_LOCKED");
    expect(existsSync(lockPath)).toBe(true);
  });

  test("falls back to bounded lock age when process-start inspection is unavailable", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: "stale-owner-hidden-by-process-policy",
      created_at: new Date(Date.now() - (10 * 60 * 1_000)).toISOString(),
      process_start_id: "recorded-owner-start",
    })}\n`);

    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        process_start_identity: () => null,
      },
    }).applied).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does not remove a new owner that replaces a stale lock during takeover", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: 99_999_999,
      nonce: "stale-owner",
    })}\n`);
    const replacement = `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: "new-owner",
    })}\n`;

    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_stale_lock_remove: (path) => {
          rmSync(path);
          writeFileSync(path, replacement);
        },
      },
    }), "PROJECT_CONTEXT_LOCKED");
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(existsSync(join(tmpRoot, "CLAUDE.md"))).toBe(false);
  });

  test("fails without removing a lock file replaced by another renderer", () => {
    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    const replacement = `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: "replacement-owner",
    })}\n`;
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_compare: () => {
          rmSync(lockPath);
          writeFileSync(lockPath, replacement);
        },
      },
    }), "PROJECT_CONTEXT_LOCK_LOST");
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(existsSync(join(tmpRoot, "CLAUDE.md"))).toBe(false);
  });

  test("rejects a concurrent renderer, recovers a dead-process lock, and fails safely after the second hash race", () => {
    let concurrentCode = "";
    const first = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_compare: () => {
          try {
            applyProjectContext({
              workspace_root: tmpRoot,
              runtime: "claude",
              bundle_json: bundleJson(),
              source_path: join(tmpRoot, "bundle.json"),
            });
          } catch (error) {
            concurrentCode = (error as ProjectContextError).code;
          }
        },
      },
    });
    expect(first.applied).toBe(true);
    expect(concurrentCode).toBe("PROJECT_CONTEXT_LOCKED");

    const lockPath = join(tmpRoot, ".hasna", "project-context.lock");
    writeFileSync(lockPath, `${JSON.stringify({ schema: "hasna.instructions.project-context-lock/v1", pid: 99_999_999 })}\n`);
    const next = makeBundle({ revision: "rev-8" });
    next.hash = computeProjectContextSourceHash(next);
    expect(applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(next),
      source_path: join(tmpRoot, "bundle.json"),
    }).revision).toBe("rev-8");

    const target = join(tmpRoot, "CLAUDE.md");
    const newest = makeBundle({ revision: "rev-9" });
    newest.hash = computeProjectContextSourceHash(newest);
    expectCode(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(newest),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        before_compare: ({ attempt }) => writeFileSync(target, `${readFileSync(target, "utf8")}race-${attempt}\n`),
      },
    }), "PROJECT_CONTEXT_HASH_RACE");
    expect(readFileSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")), "utf8")).toContain('"revision": "rev-8"');
  });

  test("leaves the manifest last on an injected crash and safely repairs on rerun", () => {
    expect(() => applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
      test_hooks: {
        after_target: () => {
          throw new Error("simulated crash");
        },
      },
    })).toThrow("simulated crash");

    expect(existsSync(join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")))).toBe(false);
    const repaired = applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "claude",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });
    expect(repaired.applied).toBe(true);
  });

  test("stores only bounded managed metadata and hashes in manifests and snapshots", () => {
    writeFileSync(join(tmpRoot, "AGENTS.md"), "PRIVATE USER PROSE THAT MUST NOT ENTER MANIFESTS\n");
    applyProjectContext({
      workspace_root: tmpRoot,
      runtime: "agents",
      bundle_json: bundleJson(),
      source_path: join(tmpRoot, "bundle.json"),
    });

    const manifestPath = join(tmpRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/"));
    const manifest = readFileSync(manifestPath, "utf8");
    expect(manifest).not.toContain("PRIVATE USER PROSE");
    expect(manifest).not.toContain("content");
    const parsed = JSON.parse(manifest) as {
      schema: string;
      targetOwner: { ownedBy: string; canonicalOwner: string };
      compatibility: { legacyPackage: string; legacyVersion: string; legacyExecutable: string; managedBy: string };
    };
    expect(parsed.schema).toBe("hasna.configs.session-render/v1");
    expect(parsed.targetOwner).toMatchObject({ ownedBy: "open-configs", canonicalOwner: "instructions" });
    expect(parsed.compatibility).toMatchObject({
      legacyPackage: "@hasna/configs",
      legacyVersion: "0.2.45",
      legacyExecutable: "configs",
      managedBy: "@hasna/configs",
    });

    const snapshotsDir = join(tmpRoot, ".hasna", "project-context-snapshots");
    if (existsSync(snapshotsDir)) {
      for (const entry of Array.from(new Bun.Glob("*.json").scanSync(snapshotsDir))) {
        expect(readFileSync(join(snapshotsDir, entry), "utf8")).not.toContain("PRIVATE USER PROSE");
      }
    }
  });
});
