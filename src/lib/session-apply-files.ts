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

export function resolveSnapshotFilePath(relativePath: string, recordedPath: string, targetHome: string): string {
  const path = resolveManifestRelativePath(relativePath, targetHome);
  if (resolve(recordedPath) !== path) {
    throw new SessionApplyError(`Session snapshot file path mismatch for ${relativePath}`);
  }
  return path;
}

export function planFileResult(
  plan: SessionRenderPlan,
  file: SessionRenderFile,
  targetHome: string,
  previousHashes: Map<string, string>,
  previousManifest: SessionRenderManifest | null,
  options: SessionApplyOptions,
): SessionApplyFileResult {
  const target = resolvePlannedFilePath(plan, file, targetHome);
  const previousContent = existsSync(target) ? readFileSync(target, "utf-8") : null;
  const previousSha256 = previousContent === null ? null : sha256(previousContent);
  const previouslyManaged = isPreviouslyManaged(file, previousSha256, previousHashes, previousManifest);
  const changed = previousContent !== file.content;
  if (previousContent !== null && !options.force && !previouslyManaged) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "conflict",
      changed,
      previousSha256,
      newSha256: file.sha256,
      reason: "existing unmanaged file; pass force to overwrite or adopt",
    };
  }
  if (!changed && options.force && !previouslyManaged) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "update",
      changed: false,
      previousSha256,
      newSha256: file.sha256,
      reason: "force",
    };
  }
  if (!changed) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "unchanged",
      changed: false,
      previousSha256,
      newSha256: file.sha256,
      reason: null,
    };
  }
  if (previousContent === null) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "create",
      changed: true,
      previousSha256,
      newSha256: file.sha256,
      reason: null,
    };
  }
  if (options.force || previouslyManaged) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "update",
      changed: true,
      previousSha256,
      newSha256: file.sha256,
      reason: options.force ? "force" : "previous manifest hash matched",
    };
  }
  return {
    path: target,
    relativePath: file.relativePath,
    role: file.role,
    action: "conflict",
    changed: true,
    previousSha256,
    newSha256: file.sha256,
    reason: "existing unmanaged file differs; pass force to overwrite",
  };
}

export function planStaleFileResults(
  plan: SessionRenderPlan,
  targetHome: string,
  previousManifest: SessionRenderManifest | null,
  currentRelativePaths: Set<string>,
  options: SessionApplyOptions,
): SessionApplyFileResult[] {
  if (!previousManifest) return [];
  const managedPrefix = `${plan.adapter.managedDir}/`;
  return previousManifest.files
    .filter((file) => !currentRelativePaths.has(file.relativePath))
    .filter((file) => file.relativePath === plan.adapter.managedDir || file.relativePath.startsWith(managedPrefix))
    .map((file) => planStaleFileResult(file, targetHome, options))
    .filter((result): result is SessionApplyFileResult => result !== null);
}

export function planStaleFileResult(
  file: SessionRenderManifest["files"][number],
  targetHome: string,
  options: SessionApplyOptions,
): SessionApplyFileResult | null {
  const target = resolveManifestRelativePath(file.relativePath, targetHome);
  if (!existsSync(target)) return null;
  const previousContent = readFileSync(target, "utf-8");
  const previousSha256 = sha256(previousContent);
  if (!options.force && previousSha256 !== file.sha256) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "conflict",
      changed: true,
      previousSha256,
      newSha256: "",
      reason: "stale managed file changed since previous manifest; pass force to remove",
    };
  }
  if (!options.force && !previousContent.includes(SESSION_RENDER_MANAGED_MARKER)) {
    return {
      path: target,
      relativePath: file.relativePath,
      role: file.role,
      action: "conflict",
      changed: true,
      previousSha256,
      newSha256: "",
      reason: "stale file lacks managed marker; pass force to remove",
    };
  }
  return {
    path: target,
    relativePath: file.relativePath,
    role: file.role,
    action: "delete",
    changed: true,
    previousSha256,
    newSha256: "",
    reason: "stale managed file removed",
  };
}

export function isPreviouslyManaged(
  file: SessionRenderFile,
  previousSha256: string | null,
  previousHashes: Map<string, string>,
  previousManifest: SessionRenderManifest | null,
): boolean {
  if (file.role === "manifest") return previousManifest !== null;
  if (!previousSha256) return false;
  return previousHashes.get(file.relativePath) === previousSha256;
}

export function resolvePlannedFilePath(
  plan: SessionRenderPlan,
  file: SessionRenderFile,
  targetHome: string,
): string {
  const target = resolve(targetHome, ...file.relativePath.split("/"));
  const rel = relative(targetHome, target);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new SessionApplyError(`Session file escapes target home: ${file.relativePath}`);
  }
  if (resolve(file.path) !== target) {
    throw new SessionApplyError(`Session file path mismatch for ${file.relativePath}: ${file.path}`);
  }
  assertNoSymlinkSegments(targetHome, target);
  return target;
}

export function resolveManifestRelativePath(relativePath: string, targetHome: string): string {
  const target = resolve(targetHome, ...relativePath.split(/[\\/]+/));
  const rel = relative(targetHome, target);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new SessionApplyError(`Session manifest file escapes target home: ${relativePath}`);
  }
  assertNoSymlinkSegments(targetHome, target);
  return target;
}

export function readPreviousManifest(path: string): SessionRenderManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SessionRenderManifest;
    if (parsed.schema !== SESSION_RENDER_SCHEMA) return null;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function applyPlannedFile(
  plan: SessionRenderPlan,
  file: SessionRenderFile,
  targetHome: string,
  resultsByPath: Map<string, SessionApplyFileResult>,
  coordination: ProjectContextWriteCoordination | null,
  allowPortableFallback: boolean,
  forcePortableFileOps: boolean,
): void {
  const target = resolvePlannedFilePath(plan, file, targetHome);
  const result = resultsByPath.get(target);
  if (!result) throw new SessionApplyError(`Session apply result is missing for ${file.relativePath}`);
  coordination?.assert_held();
  assertExpectedSessionFileHash(target, targetHome, result.previousSha256);
  if (currentSessionFileHash(target, targetHome) === file.sha256) return;
  writeProjectContextCoordinatedFile({
    path: target,
    content: file.content,
    workspace_root: targetHome,
    default_mode: 0o644,
    expected_hash: result.previousSha256,
    max_observed_bytes: null,
    allow_portable_replacement: allowPortableFallback,
    force_portable_file_ops: forcePortableFileOps,
  });
  coordination?.assert_held();
}

export function assertExpectedSessionFileHash(
  path: string,
  targetHome: string,
  expectedHash: string | null,
): void {
  const actualHash = currentSessionFileHash(path, targetHome);
  if (actualHash !== expectedHash) {
    throw new SessionApplyError(`Session apply path changed after planning: ${relative(targetHome, path)}`);
  }
}

export function currentSessionFileHash(path: string, targetHome: string): string | null {
  assertNoSymlinkSegments(targetHome, path);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SessionApplyError(`Session apply path is not a regular file: ${path}`);
  }
  return sha256(readFileSync(path, "utf-8"));
}

export function requiredPreviousHash(result: SessionApplyFileResult): string {
  if (result.previousSha256 === null) {
    throw new SessionApplyError(`Session delete has no previous hash: ${result.relativePath}`);
  }
  return result.previousSha256;
}

export function writeSessionSnapshot(
  plan: SessionRenderPlan,
  targetHome: string,
  manifestPath: string,
  results: SessionApplyFileResult[],
  previousManifest: SessionRenderManifest | null,
  coordination: ProjectContextWriteCoordination | null,
  allowPortableFallback: boolean,
  forcePortableFileOps: boolean,
): string | null {
  const existingFiles = results
    .filter((result) => result.action === "update" || result.action === "delete")
    .filter((result) => existsSync(result.path))
    .map((result) => {
      const content = readFileSync(result.path, "utf-8");
      return {
        path: result.path,
        relativePath: result.relativePath,
        role: result.role,
        sha256: sha256(content),
        content,
      };
    });
  if (!previousManifest && existingFiles.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = resolve(
    targetHome,
    ".hasna",
    "session-render-snapshots",
    `${timestamp}-${randomUUID()}.json`,
  );
  const afterFiles: SessionRenderSnapshot["afterFiles"] = results.map((result) => {
    if (result.action === "conflict") {
      throw new SessionApplyError(`Cannot snapshot unresolved conflict: ${result.relativePath}`);
    }
    return {
      path: result.path,
      relativePath: result.relativePath,
      role: result.role,
      action: result.action,
      sha256: result.action === "delete" ? null : result.newSha256,
    };
  });
  const snapshot: SessionRenderSnapshot = {
    schema: "hasna.configs.session-render-snapshot/v2",
    createdAt: new Date().toISOString(),
    tool: plan.tool,
    profile: plan.profile,
    targetHome,
    targetKind: plan.targetKind,
    manifestPath,
    previousManifest,
    files: existingFiles,
    afterFiles,
  };
  coordination?.assert_held();
  writeProjectContextCoordinatedFile({
    path: snapshotPath,
    content: `${JSON.stringify(snapshot, null, 2)}\n`,
    workspace_root: targetHome,
    default_mode: 0o600,
    expected_hash: null,
    max_observed_bytes: null,
    allow_portable_replacement: allowPortableFallback,
    force_portable_file_ops: forcePortableFileOps,
  });
  coordination?.assert_held();
  return snapshotPath;
}

export function assertSafeTargetHome(targetHome: string): string {
  if (!isAbsolute(targetHome)) throw new SessionApplyError(`Session target home must be absolute: ${targetHome}`);
  const normalized = resolve(targetHome);
  if (normalized === parse(normalized).root) {
    throw new SessionApplyError(`Session target home cannot be the filesystem root: ${targetHome}`);
  }
  assertNoSymlinkAncestors(normalized);
  if (existsSync(normalized) && lstatSync(normalized).isSymbolicLink()) {
    throw new SessionApplyError(`Session target home cannot be a symlink: ${normalized}`);
  }
  return normalized;
}

export function assertNoSymlinkSegments(root: string, target: string): void {
  assertNoSymlinkAncestors(root);
  const rel = relative(root, target);
  let current = root;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new SessionApplyError(`Session apply path uses a symlink: ${current}`);
    }
  }
}

export function assertNoSymlinkAncestors(path: string): void {
  const normalized = resolve(path);
  const parsed = parse(normalized);
  let current = parsed.root;
  const rel = relative(parsed.root, normalized);
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new SessionApplyError(`Session apply path uses a symlink ancestor: ${current}`);
    }
  }
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
