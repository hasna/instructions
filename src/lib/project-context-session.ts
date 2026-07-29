import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionRenderFile, SessionRenderManifest } from "./session-render-model.js";
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
import { readUtf8RegularFile } from "./project-context-runtime.js";
import {
  readProjectContextCache, readProjectContextManifest, writeMetadataSnapshot, buildCache,
  buildManifest, manifestCompatibility, projectContextManifestSource,
} from "./project-context-manifest.js";
import {
  buildManagedBlock, parseManagedBlock, replaceOrAppendManagedBlock,
} from "./project-context-planner.js";
import {
  acquireWorkspaceLock, assertWorkspaceLockHeld, releaseWorkspaceLock,
} from "./project-context-lock.js";

export function composeProjectContextSessionRender(
  input: ProjectContextSessionRenderInput,
): ProjectContextSessionRenderComposition | null {
  const guard = observeProjectContextSessionGuard(input);
  if (guard === null) return null;
  const { runtime, workspace_root: workspaceRoot, observed_hashes: observedHashes } = guard;
  const paths = runtimePaths(workspaceRoot, runtime);
  if (!existsSync(paths.manifest)) return null;
  assertCodewithTargetIsConsumed(workspaceRoot, runtime);

  const manifest = readProjectContextManifest(paths.manifest, workspaceRoot);
  if (!manifest) return null;
  if (manifest.tool !== manifestTool(runtime)) return null;
  const nativeImports = input.adapter_mode === "native-imports";
  const expectedAdapterMode = nativeImports ? "native-import" : "managed-block";
  if (manifest.adapterMode !== expectedAdapterMode) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ADAPTER_MISMATCH",
      "the active project-context adapter mode differs from the selected session runtime mode",
    );
  }
  const targetEntries = manifest.files.filter((file) => file.role === "index");
  const fragmentEntry = manifest.files.find((file) => file.relativePath === PROJECT_CONTEXT_FRAGMENT_PATH && file.role === "fragment");
  if (
    targetEntries.length !== 1 ||
    targetEntries[0]!.path !== paths.target ||
    fragmentEntry?.path !== paths.fragment
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "project-context manifest paths do not match the selected runtime workspace");
  }

  const cache = readProjectContextCache(paths.cache, workspaceRoot);
  if (!cache) throw new ProjectContextError("PROJECT_CONTEXT_CACHE_MISSING", "durable project-context cache is missing");
  if (
    cache.project_id !== manifest.projectContext.projectId ||
    cache.revision !== manifest.projectContext.revision ||
    cache.hash !== manifest.projectContext.hash
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "project-context manifest and durable cache identities differ");
  }
  if (currentFileHash(paths.fragment, workspaceRoot) !== fragmentEntry.sha256 || !fragmentMatchesBundle(paths.fragment, cache.bundle, workspaceRoot)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "canonical project-context fragment differs from its durable manifest");
  }
  const fragment = readUtf8RegularFile(paths.fragment, workspaceRoot, PROJECT_CONTEXT_MAX_RENDERED_BYTES);
  scanGeneratedContent(fragment);

  if (!existsSync(paths.target)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "project-context provider target is missing while durable context is active");
  }
  const currentTarget = readUtf8RegularFile(paths.target, workspaceRoot);
  const currentMarkers = parseManagedBlock(currentTarget, false);
  if (!currentMarkers.block) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "project-context provider target lost its managed block");
  }
  if (
    currentMarkers.block.id !== cache.project_id ||
    currentMarkers.block.revision !== cache.revision ||
    currentMarkers.block.hash !== cache.hash
  ) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "project-context provider markers differ from the durable cache");
  }

  const plannedIndexes = input.files.filter((file) => file.role === "index" && resolve(file.path) === paths.target);
  if (plannedIndexes.length !== 1) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "session renderer does not own the selected project-context provider target");
  }
  const index = plannedIndexes[0]!;
  const baseMarkers = parseManagedBlock(index.content, false);
  const body = nativeImports
    ? `@${runtime === "codewith" ? "../" : ""}${PROJECT_CONTEXT_FRAGMENT_PATH}`
    : fragment.trimEnd();
  const managedBlock = buildManagedBlock(cache.bundle, body, preferredEol(index.content));
  scanGeneratedContent(managedBlock);
  const content = ensureTrailingNewline(replaceOrAppendManagedBlock(index.content, managedBlock, baseMarkers, null));
  const files = input.files.map((file) => file === index
    ? {
      ...file,
      content,
      sha256: sha256(content),
      sourceIds: [...new Set([...file.sourceIds, "project-context-bundle"])],
    }
    : file);
  if (observedHashes.some((observed) => currentFileHash(observed.path, workspaceRoot) !== observed.sha256)) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_SESSION_STALE",
      "durable project context changed while the session plan was being created; create a fresh session render plan",
    );
  }

  return {
    files,
    source: projectContextManifestSource(paths.cache, runtime, cache.bundle),
    project_context: {
      ...manifest.projectContext,
    },
    compatibility: manifestCompatibility(),
    guard,
  };
}

export function observeProjectContextSessionGuard(
  input: Pick<ProjectContextSessionRenderInput, "tool" | "target_home" | "project_root">,
): ProjectContextSessionGuard | null {
  const runtime = projectContextRuntimeForSessionTool(input.tool);
  if (runtime === null) return null;
  const workspaceRoot = projectContextWorkspaceForSession(input, runtime);
  if (workspaceRoot === null) return null;
  const paths = runtimePaths(workspaceRoot, runtime);
  return {
    workspace_root: workspaceRoot,
    runtime,
    observed_hashes: projectContextSessionGuardPaths(paths, runtime)
      .map((path) => ({ path, sha256: currentFileHash(path, workspaceRoot) })),
  };
}

export function withProjectContextSessionGuard<T>(
  guard: ProjectContextSessionGuard | undefined,
  action: (coordination: ProjectContextWriteCoordination | null) => T,
  options: { dry_run?: boolean } = {},
): T {
  if (!guard) return action(null);
  const validated = validateProjectContextSessionGuard(guard);
  const verify = () => {
    for (const observed of validated.observed_hashes) {
      if (currentFileHash(observed.path, validated.workspace_root) !== observed.sha256) {
        throw new ProjectContextError(
          "PROJECT_CONTEXT_SESSION_STALE",
          "durable project context changed after the session plan was created; create a fresh session render plan",
        );
      }
    }
  };
  if (options.dry_run) {
    verify();
    return action(null);
  }

  const lockPath = resolve(validated.workspace_root, ...PROJECT_CONTEXT_LOCK_PATH.split("/"));
  const lock = acquireWorkspaceLock(validated.workspace_root, lockPath);
  try {
    verify();
    const assertHeld = () => assertWorkspaceLockHeld(lockPath, lock, validated.workspace_root);
    assertHeld();
    return action({ workspace_root: validated.workspace_root, assert_held: assertHeld });
  } finally {
    releaseWorkspaceLock(lockPath, lock, validated.workspace_root);
  }
}

export function validateProjectContextSessionGuard(guard: ProjectContextSessionGuard): ProjectContextSessionGuard {
  const workspaceRoot = assertSafeWorkspaceRoot(guard.workspace_root);
  if (!(["claude", "codewith", "agents"] as const).includes(guard.runtime)) {
    throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard has an invalid runtime");
  }
  const paths = runtimePaths(workspaceRoot, guard.runtime);
  const allowedPaths = new Set(projectContextSessionGuardPaths(paths, guard.runtime));
  if (!Array.isArray(guard.observed_hashes) || guard.observed_hashes.length !== allowedPaths.size) {
    throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard has an incomplete hash inventory");
  }
  const observedPaths = new Set<string>();
  const observedHashes = guard.observed_hashes.map((observed) => {
    if (!isRecord(observed) || typeof observed.path !== "string") {
      throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard contains malformed hash metadata");
    }
    const path = resolve(observed.path);
    if (!allowedPaths.has(path) || observedPaths.has(path)) {
      throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard contains an unexpected or duplicate path");
    }
    if (observed.sha256 !== null && (typeof observed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(observed.sha256))) {
      throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard contains an invalid hash");
    }
    observedPaths.add(path);
    return { path, sha256: observed.sha256 };
  });
  if (observedPaths.size !== allowedPaths.size) {
    throw new ProjectContextError("PROJECT_CONTEXT_SESSION_STALE", "session project-context guard does not cover every durable context path");
  }
  return {
    workspace_root: workspaceRoot,
    runtime: guard.runtime,
    observed_hashes: observedHashes,
  };
}
