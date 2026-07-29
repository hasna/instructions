import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEGACY_CONFIGS_COMPAT_VERSION, LEGACY_CONFIGS_EXECUTABLE, LEGACY_CONFIGS_PACKAGE,
  PROJECT_CONTEXT_CACHE_PATH, PROJECT_CONTEXT_CACHE_SCHEMA, PROJECT_CONTEXT_FRAGMENT_PATH,
  PROJECT_CONTEXT_LOCK_PATH, PROJECT_CONTEXT_LOCK_STALE_MS, PROJECT_CONTEXT_MANAGED_COMMENT,
  PROJECT_CONTEXT_MANIFEST_PATH, PROJECT_CONTEXT_MAX_APPROX_TOKENS,
  PROJECT_CONTEXT_MAX_RENDERED_BYTES, PROJECT_CONTEXT_MAX_WARNINGS, PROJECT_CONTEXT_SCHEMA,
  PROJECT_CONTEXT_SNAPSHOT_DIR, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES,
  ProjectContextError, ProjectContextHashRace, compareRevisions, computeProjectContextSourceHash,
  isRecord, parseProjectContextBundle, revisionKey, scanGeneratedContent, sha256, stableStringify,
  type ManagedBlock, type ProjectContextApplyOptions, type ProjectContextApplyResult,
  type ProjectContextBundleV1, type ProjectContextCache, type ProjectContextManifest,
  type ProjectContextManifestObservation, type ProjectContextPhase, type ProjectContextPlan,
  type ProjectContextPlanInput, type ProjectContextRuntime, type ProjectContextSessionGuard,
  type ProjectContextSessionRenderComposition, type ProjectContextSessionRenderInput,
  type ProjectContextStatus, type ProjectContextWriteCoordination, type WorkspaceLock,
  projectContextCacheSchema, storedManifestObservationSchema,
} from "./project-context-model.js";
import {
  ageInSeconds, assertCodewithTargetIsConsumed, assertNoSymlinkAncestors,
  assertNoSymlinkSegments, assertSafeWorkspaceRoot, currentFileHash, durableSourcePath,
  ensureTrailingNewline, escapeText, fragmentMatchesBundle, hashesStillMatch, inlineCode,
  inlineNullable, manifestTool, normalizeMaxStaleAge, preferredEol, projectContextRuntimeForSessionTool,
  projectContextSessionGuardPaths, projectContextWorkspaceForSession, relativePosix,
  runtimePaths, runtimeUsesNativeImports, safeFilename, shellQuote, staleCacheAgeInSeconds,
  statusLabel,
} from "./project-context-runtime.js";
import {
  readProjectContextCache, readProjectContextManifest, writeMetadataSnapshot, buildCache,
  buildManifest, buildSessionCompatibilityManifest,
} from "./project-context-manifest.js";

import { atomicWriteFile } from "./project-context-files.js";
import {
  acquireWorkspaceLock, assertWorkspaceLockHeld, ensureSafeDirectory, releaseWorkspaceLock,
} from "./project-context-lock.js";
import {
  assertRenderedOutputsStable, assertRevisionOrdering, expectedPlanHash, planProjectContext,
  resolveBundleForApply, resultForPlan,
} from "./project-context-planner.js";
export function applyProjectContext(options: ProjectContextApplyOptions): ProjectContextApplyResult {
  const workspaceRoot = assertSafeWorkspaceRoot(options.workspace_root);
  const now = options.now ?? new Date();
  const lockPath = resolve(workspaceRoot, ...PROJECT_CONTEXT_LOCK_PATH.split("/"));
  const lock = options.dry_run
    ? null
    : acquireWorkspaceLock(
      workspaceRoot,
      lockPath,
      options.test_hooks?.after_lock_open,
      options.test_hooks?.before_stale_lock_remove,
      options.test_hooks?.process_start_identity,
    );
  try {
    const resolved = resolveBundleForApply(options, workspaceRoot, now);
    let raceRetries = 0;
    let snapshotPath: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = planProjectContext({
        workspace_root: workspaceRoot,
        runtime: options.runtime,
        bundle: resolved.bundle,
        source_path: resolved.sourcePath,
        status: resolved.status,
        age_seconds: resolved.ageSeconds,
        now,
        force: options.force,
        codewith_native_imports: options.codewith_native_imports,
      });
      assertRevisionOrdering(plan, options.force === true);
      const cacheContent = `${JSON.stringify(buildCache(plan, now), null, 2)}\n`;
      const sessionManifest = buildSessionCompatibilityManifest(plan, now);
      const sessionOutput = {
        path: runtimePaths(workspaceRoot, plan.runtime).sessionManifest,
        content: `${JSON.stringify(sessionManifest, null, 2)}\n`,
      };
      options.test_hooks?.before_compare?.({ attempt, plan });
      if (!hashesStillMatch(plan.expected_hashes, workspaceRoot)) {
        if (attempt === 0) {
          raceRetries++;
          continue;
        }
        throw new ProjectContextError("PROJECT_CONTEXT_HASH_RACE", "workspace files changed during both compare-and-render attempts");
      }
      if (options.dry_run) return resultForPlan(plan, true, raceRetries, null);

      assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
      try {
        snapshotPath = writeMetadataSnapshot(plan, now);
        atomicWriteFile(
          plan.fragment_path,
          plan.fragment,
          workspaceRoot,
          0o644,
          expectedPlanHash(plan, plan.fragment_path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
          undefined,
          options.test_hooks?.portable_create_only,
        );
        options.test_hooks?.after_fragment?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        atomicWriteFile(
          plan.target_path,
          plan.target_content,
          workspaceRoot,
          0o644,
          expectedPlanHash(plan, plan.target_path),
          () => options.test_hooks?.after_target_exchange?.({ attempt, plan }),
          options.test_hooks?.atomic_exchange_unavailable,
          (tempPath) => options.test_hooks?.before_target_install?.({ attempt, plan, temp_path: tempPath }),
          options.test_hooks?.portable_create_only,
        );
        options.test_hooks?.after_target?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        atomicWriteFile(
          plan.cache_path,
          cacheContent,
          workspaceRoot,
          0o600,
          expectedPlanHash(plan, plan.cache_path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
          undefined,
          options.test_hooks?.portable_create_only,
        );
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        atomicWriteFile(
          sessionOutput.path,
          sessionOutput.content,
          workspaceRoot,
          0o600,
          expectedPlanHash(plan, sessionOutput.path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
          undefined,
          options.test_hooks?.portable_create_only,
        );
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);

        options.test_hooks?.before_manifest?.({ attempt, plan });
        assertWorkspaceLockHeld(lockPath, lock!, workspaceRoot);
        assertRenderedOutputsStable(plan, cacheContent, sessionOutput);
        const manifest = buildManifest(plan, now);
        atomicWriteFile(
          plan.manifest_path,
          `${JSON.stringify(manifest, null, 2)}\n`,
          workspaceRoot,
          0o600,
          expectedPlanHash(plan, plan.manifest_path),
          undefined,
          options.test_hooks?.atomic_exchange_unavailable,
          undefined,
          options.test_hooks?.portable_create_only,
        );
        return resultForPlan(plan, false, raceRetries, snapshotPath);
      } catch (error) {
        if (error instanceof ProjectContextHashRace && attempt === 0) {
          raceRetries++;
          continue;
        }
        if (error instanceof ProjectContextHashRace) {
          throw new ProjectContextError("PROJECT_CONTEXT_HASH_RACE", "workspace files changed during both compare-and-render attempts");
        }
        throw error;
      }
    }
    throw new ProjectContextError("PROJECT_CONTEXT_HASH_RACE", "workspace files changed during both compare-and-render attempts");
  } finally {
    if (lock !== null) releaseWorkspaceLock(lockPath, lock, workspaceRoot);
  }
}
