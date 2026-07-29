import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  observeProjectContextSessionGuard, removeProjectContextCoordinatedFile,
  withProjectContextSessionGuard, writeProjectContextCoordinatedFile,
  type ProjectContextWriteCoordination,
} from "./project-context.js";
import {
  SESSION_RENDER_MANAGED_MARKER, SESSION_RENDER_SCHEMA, type SessionRenderFile,
  type SessionRenderFileRole, type SessionRenderManifest, type SessionRenderPlan,
} from "./session-render.js";
import {
  SessionApplyError, type SessionApplyFileResult, type SessionApplyOptions,
  type SessionApplyResult, type SessionDriftCheck, type SessionDriftEntry,
  type SessionRenderSnapshot, type SessionRestoreConflict, type SessionRestoreFileResult,
  type SessionRestoreOptions, type SessionRestoreResult, type StoredSessionRenderSnapshot,
  type SessionSnapshotAction,
} from "./session-apply-contract.js";
import {
  applyPlannedFile, assertExpectedSessionFileHash, assertNoSymlinkSegments,
  assertSafeTargetHome, currentSessionFileHash, planFileResult, planStaleFileResults,
  readPreviousManifest, requiredPreviousHash, resolveManifestRelativePath,
  resolvePlannedFilePath, resolveSnapshotFilePath, sha256, writeSessionSnapshot,
} from "./session-apply-files.js";

export function applySessionRender(
  plan: SessionRenderPlan,
  options: SessionApplyOptions = {},
): SessionApplyResult {
  return withProjectContextSessionGuard(
    plan.projectContextGuard,
    (coordination) => applySessionRenderUnlocked(plan, options, coordination),
    { dry_run: options.dryRun },
  );
}

function applySessionRenderUnlocked(
  plan: SessionRenderPlan,
  options: SessionApplyOptions,
  coordination: ProjectContextWriteCoordination | null,
): SessionApplyResult {
  if (plan.blocked || !plan.writable) {
    throw new SessionApplyError(`Session render plan is blocked: ${plan.blockers.join("; ")}`);
  }

  const targetHome = assertSafeTargetHome(plan.targetHome);
  const files = [...plan.files, plan.manifestFile];
  const manifestPath = resolvePlannedFilePath(plan, plan.manifestFile, targetHome);
  const previousManifest = readPreviousManifest(manifestPath);
  const previousHashes = previousManifest
    ? new Map(previousManifest.files.map((file) => [file.relativePath, file.sha256]))
    : new Map<string, string>();
  const currentRelativePaths = new Set(files.map((file) => file.relativePath));
  const drift = checkSessionRenderDrift(targetHome, manifestPath);

  const results = [
    ...files.map((file) => planFileResult(plan, file, targetHome, previousHashes, previousManifest, options)),
    ...planStaleFileResults(plan, targetHome, previousManifest, currentRelativePaths, options),
  ];
  const conflicts = results.filter((result) => result.action === "conflict");
  if (conflicts.length > 0) {
    return {
      dryRun: options.dryRun ?? false,
      applied: false,
      targetHome,
      manifestPath,
      snapshotPath: null,
      env: plan.env,
      files: results,
      conflicts,
      drift,
    };
  }

  let snapshotPath: string | null = null;
  if (!options.dryRun) {
    const allowPortableFallback = coordination === null;
    const forcePortableFileOps = options.test_hooks?.force_portable_file_ops ?? false;
    ensureSessionTargetHome(targetHome);
    snapshotPath = writeSessionSnapshot(
      plan,
      targetHome,
      manifestPath,
      results,
      previousManifest,
      coordination,
      allowPortableFallback,
      forcePortableFileOps,
    );
    options.test_hooks?.before_apply_writes?.({ plan, results });
    const resultsByPath = new Map(results.map((result) => [result.path, result]));
    for (const file of plan.files) {
      applyPlannedFile(
        plan,
        file,
        targetHome,
        resultsByPath,
        coordination,
        allowPortableFallback,
        forcePortableFileOps,
      );
    }
    for (const result of results) {
      if (result.action !== "delete") continue;
      coordination?.assert_held();
      assertExpectedSessionFileHash(result.path, targetHome, result.previousSha256);
      removeProjectContextCoordinatedFile({
        path: result.path,
        workspace_root: targetHome,
        expected_hash: requiredPreviousHash(result),
        max_observed_bytes: null,
        allow_portable_removal: allowPortableFallback,
        force_portable_file_ops: forcePortableFileOps,
      });
      coordination?.assert_held();
    }
    applyPlannedFile(
      plan,
      plan.manifestFile,
      targetHome,
      resultsByPath,
      coordination,
      allowPortableFallback,
      forcePortableFileOps,
    );
  }

  return {
    dryRun: options.dryRun ?? false,
    applied: !(options.dryRun ?? false),
    targetHome,
    manifestPath,
    snapshotPath,
    env: plan.env,
    files: results,
    conflicts,
    drift,
  };
}

function ensureSessionTargetHome(targetHome: string): void {
  if (!existsSync(targetHome)) mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  assertSafeTargetHome(targetHome);
}

export function checkSessionRenderDrift(targetHome: string, manifestPath?: string): SessionDriftCheck {
  const safeTargetHome = assertSafeTargetHome(targetHome);
  const resolvedManifestPath = manifestPath
    ? resolveManifestRelativePath(relative(safeTargetHome, resolve(manifestPath)), safeTargetHome)
    : resolve(safeTargetHome, ".hasna", "session-render-manifest.json");
  const checkedAt = new Date().toISOString();
  const previousManifest = readPreviousManifest(resolvedManifestPath);
  if (!previousManifest) {
    return {
      checked: false,
      clean: true,
      manifestPath: resolvedManifestPath,
      checkedAt,
      missing: [],
      drifted: [],
    };
  }

  const missing: SessionDriftEntry[] = [];
  const drifted: SessionDriftEntry[] = [];
  for (const file of previousManifest.files) {
    const target = resolveManifestRelativePath(file.relativePath, safeTargetHome);
    if (!existsSync(target)) {
      missing.push({
        path: target,
        relativePath: file.relativePath,
        expectedSha256: file.sha256,
        actualSha256: null,
        reason: "missing",
      });
      continue;
    }
    const actualSha256 = sha256(readFileSync(target, "utf-8"));
    if (actualSha256 !== file.sha256) {
      drifted.push({
        path: target,
        relativePath: file.relativePath,
        expectedSha256: file.sha256,
        actualSha256,
        reason: "hash_mismatch",
      });
    }
  }

  return {
    checked: true,
    clean: missing.length === 0 && drifted.length === 0,
    manifestPath: resolvedManifestPath,
    checkedAt,
    missing,
    drifted,
  };
}

