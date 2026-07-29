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
