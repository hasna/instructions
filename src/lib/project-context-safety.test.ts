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

});
