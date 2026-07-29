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
