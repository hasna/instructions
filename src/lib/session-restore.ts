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

export function restoreSessionRenderSnapshot(
  snapshotPath: string,
  options: SessionRestoreOptions = {},
): SessionRestoreResult {
  const snapshot = readSessionRenderSnapshot(snapshotPath);
  const targetHome = assertSafeTargetHome(snapshot.targetHome);
  const resolvedSnapshotPath = resolve(snapshotPath);
  const snapshotRelativePath = relative(targetHome, resolvedSnapshotPath);
  if (
    snapshotRelativePath === ""
    || snapshotRelativePath === ".."
    || snapshotRelativePath.startsWith("../")
    || isAbsolute(snapshotRelativePath)
  ) {
    throw new SessionApplyError("Session snapshot must be stored inside its target home.");
  }
  assertNoSymlinkSegments(targetHome, resolvedSnapshotPath);
  const guard = observeProjectContextSessionGuard({
    tool: snapshot.tool,
    target_home: targetHome,
    project_root: snapshot.targetKind === "project-root" ? targetHome : undefined,
  });
  return withProjectContextSessionGuard(
    guard ?? undefined,
    (coordination) => restoreSessionRenderSnapshotUnlocked(
      snapshot,
      resolvedSnapshotPath,
      targetHome,
      options,
      coordination,
    ),
    { dry_run: options.dryRun },
  );
}

function restoreSessionRenderSnapshotUnlocked(
  snapshot: SessionRenderSnapshot,
  snapshotPath: string,
  targetHome: string,
  options: SessionRestoreOptions,
  coordination: ProjectContextWriteCoordination | null,
): SessionRestoreResult {
  const previousFiles = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  const conflicts: SessionRestoreConflict[] = [];
  for (const file of snapshot.afterFiles) {
    const path = resolveSnapshotFilePath(file.relativePath, file.path, targetHome);
    const actualSha256 = currentSessionFileHash(path, targetHome);
    if (actualSha256 !== file.sha256) {
      conflicts.push({
        path,
        relativePath: file.relativePath,
        expectedSha256: file.sha256,
        actualSha256,
      });
    }
  }

  const files = snapshot.afterFiles.map((file): SessionRestoreFileResult => {
    const previous = previousFiles.get(file.relativePath);
    const path = resolveSnapshotFilePath(file.relativePath, file.path, targetHome);
    const current = currentSessionFileHash(path, targetHome);
    if (file.action === "unchanged") {
      return {
        path,
        relativePath: file.relativePath,
        action: "unchanged",
        previousSha256: current,
        restoredSha256: current,
      };
    }
    if (file.action === "create") {
      return {
        path,
        relativePath: file.relativePath,
        action: current === null ? "unchanged" : "delete",
        previousSha256: current,
        restoredSha256: null,
      };
    }
    if (previous) {
      return {
        path,
        relativePath: file.relativePath,
        action: current === previous.sha256 ? "unchanged" : current === null ? "create" : "update",
        previousSha256: current,
        restoredSha256: previous.sha256,
      };
    }
    throw new SessionApplyError(`Session snapshot is missing a before-image for ${file.action} file: ${file.relativePath}`);
  });

  if (conflicts.length > 0 || options.dryRun) {
    return {
      dryRun: options.dryRun ?? false,
      restored: false,
      snapshotPath,
      targetHome,
      conflicts,
      files,
    };
  }

  const forcePortableFileOps = options.test_hooks?.force_portable_file_ops ?? false;
  const ordered = [...files].sort((left, right) =>
    Number(left.relativePath === ".hasna/session-render-manifest.json")
    - Number(right.relativePath === ".hasna/session-render-manifest.json")
  );
  for (const file of ordered) {
    if (file.action === "unchanged") continue;
    coordination?.assert_held();
    assertExpectedSessionFileHash(file.path, targetHome, file.previousSha256);
    const previous = previousFiles.get(file.relativePath);
    if (file.action === "delete") {
      removeProjectContextCoordinatedFile({
        path: file.path,
        workspace_root: targetHome,
        expected_hash: requiredRestoreHash(file),
        max_observed_bytes: null,
        allow_portable_removal: coordination === null,
        force_portable_file_ops: forcePortableFileOps,
      });
    } else if (previous) {
      writeProjectContextCoordinatedFile({
        path: file.path,
        content: previous.content,
        workspace_root: targetHome,
        default_mode: 0o644,
        expected_hash: file.previousSha256,
        max_observed_bytes: null,
        allow_portable_replacement: coordination === null,
        force_portable_file_ops: forcePortableFileOps,
      });
    }
    coordination?.assert_held();
  }

  return {
    dryRun: false,
    restored: true,
    snapshotPath,
    targetHome,
    conflicts: [],
    files,
  };
}

function requiredRestoreHash(file: SessionRestoreFileResult): string {
  if (file.previousSha256 === null) {
    throw new SessionApplyError(`Session restore delete has no current hash: ${file.relativePath}`);
  }
  return file.previousSha256;
}

function readSessionRenderSnapshot(snapshotPath: string): SessionRenderSnapshot {
  const resolved = resolve(snapshotPath);
  if (!existsSync(resolved)) throw new SessionApplyError(`Session snapshot not found: ${snapshotPath}`);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SessionApplyError(`Session snapshot is not a regular file: ${snapshotPath}`);
  }
  if (statSync(resolved).size > 32 * 1024 * 1024) {
    throw new SessionApplyError(`Session snapshot exceeds the 32 MiB restore limit: ${snapshotPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new SessionApplyError(`Session snapshot is not valid JSON: ${snapshotPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SessionApplyError(`Session snapshot must contain an object: ${snapshotPath}`);
  }
  const snapshot = parsed as Partial<StoredSessionRenderSnapshot>;
  if (
    snapshot.schema !== "hasna.configs.session-render-snapshot/v1"
    && snapshot.schema !== "hasna.configs.session-render-snapshot/v2"
  ) {
    throw new SessionApplyError(`Unsupported session snapshot schema: ${String(snapshot.schema)}`);
  }
  if (
    typeof snapshot.targetHome !== "string"
    || typeof snapshot.manifestPath !== "string"
    || !Array.isArray(snapshot.files)
    || (
      snapshot.previousManifest !== null
      && (
        !snapshot.previousManifest
        || typeof snapshot.previousManifest !== "object"
        || snapshot.previousManifest.schema !== SESSION_RENDER_SCHEMA
        || !Array.isArray(snapshot.previousManifest.files)
      )
    )
    || typeof snapshot.tool !== "string"
    || typeof snapshot.profile !== "string"
  ) {
    throw new SessionApplyError(`Session snapshot is incomplete: ${snapshotPath}`);
  }
  const isPreRollbackLegacyV1 = (
    snapshot.schema === "hasna.configs.session-render-snapshot/v1"
    && snapshot.targetKind === undefined
    && snapshot.afterFiles === undefined
  );
  if (
    !isPreRollbackLegacyV1
    && (
      !Array.isArray(snapshot.afterFiles)
      || (snapshot.targetKind !== "session-home" && snapshot.targetKind !== "project-root")
    )
  ) {
    throw new SessionApplyError(`Session snapshot is incomplete: ${snapshotPath}`);
  }
  const targetHome = assertSafeTargetHome(snapshot.targetHome);
  const previousManifest = snapshot.previousManifest as SessionRenderManifest | null;
  const previousFiles = new Map<string, SessionRenderSnapshot["files"][number]>();
  for (const file of snapshot.files) {
    if (
      !file
      || typeof file.relativePath !== "string"
      || typeof file.path !== "string"
      || typeof file.sha256 !== "string"
      || typeof file.content !== "string"
      || sha256(file.content) !== file.sha256
    ) {
      throw new SessionApplyError(`Session snapshot previous file metadata is invalid: ${snapshotPath}`);
    }
    resolveSnapshotFilePath(file.relativePath, file.path, targetHome);
    if (previousFiles.has(file.relativePath)) {
      throw new SessionApplyError(`Session snapshot has duplicate previous file metadata: ${file.relativePath}`);
    }
    previousFiles.set(file.relativePath, file);
  }
  const previousManifestFiles = indexPreviousManifestFiles(previousManifest, targetHome, snapshotPath);
  const legacyUpgrade = isPreRollbackLegacyV1
    ? reconstructPreRollbackLegacyV1Snapshot(
      {
        ...snapshot,
        targetHome: snapshot.targetHome,
        manifestPath: snapshot.manifestPath,
        tool: snapshot.tool,
        profile: snapshot.profile,
        previousManifest,
      },
      previousFiles,
      previousManifestFiles,
      targetHome,
      snapshotPath,
    )
    : null;
  const targetKind = legacyUpgrade?.targetKind ?? snapshot.targetKind;
  const storedAfterFiles = legacyUpgrade?.afterFiles ?? snapshot.afterFiles;
  if (
    (targetKind !== "session-home" && targetKind !== "project-root")
    || !Array.isArray(storedAfterFiles)
  ) {
    throw new SessionApplyError(`Session snapshot is incomplete: ${snapshotPath}`);
  }
  const afterRelativePaths = new Set<string>();
  const afterFiles: SessionRenderSnapshot["afterFiles"] = [];
  for (const file of storedAfterFiles) {
    if (
      !file
      || typeof file.relativePath !== "string"
      || typeof file.path !== "string"
      || (
        (
          snapshot.schema === "hasna.configs.session-render-snapshot/v2"
          && file.action === undefined
        )
        || (
          file.action !== undefined
          && file.action !== "create"
          && file.action !== "update"
          && file.action !== "delete"
          && file.action !== "unchanged"
        )
      )
      || (typeof file.sha256 !== "string" && file.sha256 !== null)
    ) {
      throw new SessionApplyError(`Session snapshot applied file metadata is invalid: ${snapshotPath}`);
    }
    resolveSnapshotFilePath(file.relativePath, file.path, targetHome);
    if (afterRelativePaths.has(file.relativePath)) {
      throw new SessionApplyError(`Session snapshot has duplicate applied file metadata: ${file.relativePath}`);
    }
    afterRelativePaths.add(file.relativePath);
    afterFiles.push({
      ...file,
      action: file.action ?? inferLegacySnapshotAction(
        file,
        previousFiles,
        previousManifestFiles,
        snapshot.previousManifest,
      ),
    });
  }
  return {
    ...snapshot,
    targetKind,
    afterFiles,
  } as SessionRenderSnapshot;
}

function reconstructPreRollbackLegacyV1Snapshot(
  snapshot: Partial<StoredSessionRenderSnapshot> & {
    targetHome: string;
    manifestPath: string;
    tool: string;
    profile: string;
    previousManifest: SessionRenderManifest | null;
  },
  previousFiles: Map<string, SessionRenderSnapshot["files"][number]>,
  previousManifestFiles: Map<string, SessionRenderManifest["files"][number]>,
  targetHome: string,
  snapshotPath: string,
): Pick<SessionRenderSnapshot, "targetKind" | "afterFiles"> {
  assertNoNewerSessionSnapshot(snapshotPath, snapshot.createdAt, targetHome);
  const manifestPath = resolve(snapshot.manifestPath);
  const manifestRelativePath = relative(targetHome, manifestPath).replaceAll("\\", "/");
  resolveSnapshotFilePath(manifestRelativePath, snapshot.manifestPath, targetHome);
  const manifestSha256 = currentSessionFileHash(manifestPath, targetHome);
  if (manifestSha256 === null) {
    throw new SessionApplyError(`Cannot restore pre-rollback legacy v1 snapshot without its applied manifest: ${snapshotPath}`);
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new SessionApplyError(`Pre-rollback legacy v1 applied manifest is not valid JSON: ${snapshotPath}`);
  }
  if (!parsedManifest || typeof parsedManifest !== "object" || Array.isArray(parsedManifest)) {
    throw new SessionApplyError(`Pre-rollback legacy v1 applied manifest is invalid: ${snapshotPath}`);
  }
  const appliedManifest = parsedManifest as Partial<SessionRenderManifest>;
  if (
    appliedManifest.schema !== SESSION_RENDER_SCHEMA
    || appliedManifest.tool !== snapshot.tool
    || appliedManifest.profile !== snapshot.profile
    || typeof appliedManifest.targetHome !== "string"
    || resolve(appliedManifest.targetHome) !== targetHome
    || (appliedManifest.targetKind !== "session-home" && appliedManifest.targetKind !== "project-root")
    || !Array.isArray(appliedManifest.files)
  ) {
    throw new SessionApplyError(`Pre-rollback legacy v1 applied manifest does not match its snapshot: ${snapshotPath}`);
  }

  const afterFiles: SessionRenderSnapshot["afterFiles"] = [];
  const appliedRelativePaths = new Set<string>();
  for (const file of appliedManifest.files) {
    if (
      !file
      || typeof file.path !== "string"
      || typeof file.relativePath !== "string"
      || !isSessionRenderFileRole(file.role)
      || file.role === "manifest"
      || typeof file.sha256 !== "string"
    ) {
      throw new SessionApplyError(`Pre-rollback legacy v1 applied manifest file metadata is invalid: ${snapshotPath}`);
    }
    resolveSnapshotFilePath(file.relativePath, file.path, targetHome);
    if (appliedRelativePaths.has(file.relativePath)) {
      throw new SessionApplyError(`Pre-rollback legacy v1 applied manifest has duplicate file metadata: ${file.relativePath}`);
    }
    appliedRelativePaths.add(file.relativePath);

    const previousFile = previousFiles.get(file.relativePath);
    const previousManifestFile = previousManifestFiles.get(file.relativePath);
    let action: SessionSnapshotAction;
    if (previousFile) {
      assertMatchingLegacyFileMetadata(file, previousFile, "before-image");
      if (previousFile.sha256 === file.sha256) {
        throw new SessionApplyError(`Pre-rollback legacy v1 update has identical before and after hashes: ${file.relativePath}`);
      }
      action = "update";
    } else if (previousManifestFile) {
      assertMatchingLegacyFileMetadata(file, previousManifestFile, "previous manifest");
      if (previousManifestFile.sha256 === file.sha256) {
        throw new SessionApplyError(
          `Cannot infer pre-rollback legacy v1 unchanged versus recreated file: ${file.relativePath}`,
        );
      }
      action = "create";
    } else {
      action = "create";
    }
    afterFiles.push({
      path: file.path,
      relativePath: file.relativePath,
      role: file.role,
      action,
      sha256: file.sha256,
    });
  }

  for (const [relativePath, previousFile] of previousFiles) {
    if (relativePath === manifestRelativePath || appliedRelativePaths.has(relativePath)) continue;
    const previousManifestFile = previousManifestFiles.get(relativePath);
    if (!previousManifestFile) {
      throw new SessionApplyError(
        `Cannot infer pre-rollback legacy v1 delete without previous manifest metadata: ${relativePath}`,
      );
    }
    assertMatchingLegacyFileMetadata(previousFile, previousManifestFile, "previous manifest");
    afterFiles.push({
      path: previousFile.path,
      relativePath,
      role: previousFile.role,
      action: "delete",
      sha256: null,
    });
  }

  const previousManifestFile = previousFiles.get(manifestRelativePath);
  if (previousManifestFile) {
    if (previousManifestFile.path !== manifestPath || previousManifestFile.role !== "manifest") {
      throw new SessionApplyError(`Pre-rollback legacy v1 manifest before-image metadata is invalid: ${snapshotPath}`);
    }
    if (previousManifestFile.sha256 === manifestSha256) {
      throw new SessionApplyError(`Pre-rollback legacy v1 manifest has identical before and after hashes: ${snapshotPath}`);
    }
  } else if (snapshot.previousManifest) {
    throw new SessionApplyError(`Pre-rollback legacy v1 snapshot is missing its manifest before-image: ${snapshotPath}`);
  }
  afterFiles.push({
    path: manifestPath,
    relativePath: manifestRelativePath,
    role: "manifest",
    action: previousManifestFile ? "update" : "create",
    sha256: manifestSha256,
  });

  return {
    targetKind: appliedManifest.targetKind,
    afterFiles,
  };
}

function assertNoNewerSessionSnapshot(
  snapshotPath: string,
  createdAt: string | undefined,
  targetHome: string,
): void {
  const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs)) {
    throw new SessionApplyError(`Pre-rollback legacy v1 snapshot has an invalid creation time: ${snapshotPath}`);
  }
  for (const entry of readdirSync(dirname(snapshotPath))) {
    const candidatePath = resolve(dirname(snapshotPath), entry);
    if (candidatePath === resolve(snapshotPath) || !entry.endsWith(".json")) continue;
    const candidateStat = lstatSync(candidatePath);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile() || candidateStat.size > 32 * 1024 * 1024) continue;
    try {
      const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as {
        schema?: unknown;
        createdAt?: unknown;
        targetHome?: unknown;
      };
      const candidateCreatedAtMs = typeof candidate.createdAt === "string"
        ? Date.parse(candidate.createdAt)
        : Number.NaN;
      if (
        (candidate.schema === "hasna.configs.session-render-snapshot/v1"
          || candidate.schema === "hasna.configs.session-render-snapshot/v2")
        && typeof candidate.targetHome === "string"
        && resolve(candidate.targetHome) === targetHome
        && Number.isFinite(candidateCreatedAtMs)
        && candidateCreatedAtMs >= createdAtMs
      ) {
        throw new SessionApplyError(
          `Cannot restore pre-rollback legacy v1 snapshot after a newer session snapshot exists: ${candidatePath}`,
        );
      }
    } catch (error) {
      if (error instanceof SessionApplyError) throw error;
    }
  }
}

function assertMatchingLegacyFileMetadata(
  appliedFile: Pick<SessionRenderManifest["files"][number], "path" | "role" | "relativePath">,
  previousFile: Pick<SessionRenderSnapshot["files"][number], "path" | "role" | "relativePath">,
  source: string,
): void {
  if (
    appliedFile.path !== previousFile.path
    || appliedFile.role !== previousFile.role
    || appliedFile.relativePath !== previousFile.relativePath
  ) {
    throw new SessionApplyError(
      `Pre-rollback legacy v1 ${source} metadata conflicts for ${appliedFile.relativePath}`,
    );
  }
}

function isSessionRenderFileRole(role: unknown): role is SessionRenderFileRole {
  return role === "index"
    || role === "fragment"
    || role === "rule"
    || role === "config"
    || role === "manifest";
}

function indexPreviousManifestFiles(
  previousManifest: SessionRenderManifest | null | undefined,
  targetHome: string,
  snapshotPath: string,
): Map<string, SessionRenderManifest["files"][number]> {
  const files = new Map<string, SessionRenderManifest["files"][number]>();
  if (!previousManifest) return files;
  for (const file of previousManifest.files) {
    if (
      !file
      || typeof file.relativePath !== "string"
      || typeof file.path !== "string"
      || typeof file.sha256 !== "string"
    ) {
      throw new SessionApplyError(`Session snapshot previous manifest metadata is invalid: ${snapshotPath}`);
    }
    resolveSnapshotFilePath(file.relativePath, file.path, targetHome);
    if (files.has(file.relativePath)) {
      throw new SessionApplyError(`Session snapshot previous manifest has duplicate file metadata: ${file.relativePath}`);
    }
    files.set(file.relativePath, file);
  }
  return files;
}

function inferLegacySnapshotAction(
  file: NonNullable<StoredSessionRenderSnapshot["afterFiles"]>[number],
  previousFiles: Map<string, SessionRenderSnapshot["files"][number]>,
  previousManifestFiles: Map<string, SessionRenderManifest["files"][number]>,
  previousManifest: SessionRenderManifest | null | undefined,
): SessionSnapshotAction {
  const previousFile = previousFiles.get(file.relativePath);
  const previousManifestFile = previousManifestFiles.get(file.relativePath);
  if (file.sha256 === null) {
    if (
      !previousFile
      || !previousManifestFile
      || previousManifestFile.sha256 !== previousFile.sha256
      || previousManifestFile.path !== previousFile.path
      || previousManifestFile.role !== previousFile.role
    ) {
      throw new SessionApplyError(`Cannot infer legacy v1 delete from incomplete previous metadata: ${file.relativePath}`);
    }
    return "delete";
  }
  if (previousFile) {
    if (previousFile.path !== file.path || previousFile.role !== file.role) {
      throw new SessionApplyError(`Cannot infer legacy v1 update from conflicting before-image metadata: ${file.relativePath}`);
    }
    return "update";
  }
  if (previousManifestFile) {
    if (previousManifestFile.path !== file.path || previousManifestFile.role !== file.role) {
      throw new SessionApplyError(`Cannot infer legacy v1 action from conflicting previous manifest metadata: ${file.relativePath}`);
    }
    if (previousManifestFile.sha256 === file.sha256) {
      throw new SessionApplyError(`Cannot infer legacy v1 unchanged versus recreated file: ${file.relativePath}`);
    }
    return "create";
  }
  if (file.role === "manifest" && previousManifest) {
    const previousManifestSha256 = sha256(`${JSON.stringify(previousManifest, null, 2)}\n`);
    if (previousManifestSha256 !== file.sha256) {
      throw new SessionApplyError(`Cannot infer legacy v1 manifest action without a before-image: ${file.relativePath}`);
    }
    return "unchanged";
  }
  return "create";
}

