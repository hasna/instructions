import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  anchoredFileHash, anchoredFileObservation, anchoredOpenExclusive, anchoredPreparedObservation,
  assertManagedDirectoryStable, atomicExchangeEntries, atomicExchangePaths,
  captureManagedDirectoryIdentity, isPreparedManagedFileModeUsable, openAnchoredDirectory,
  managedDirectoryMatches, resolveAnchoredFsOps, resolveAtomicExchange,
  type AnchoredDirectory, type AnchoredFileObservation,
} from "./project-context-anchored.js";
import { ensureSafeDirectory, fsyncDirectory } from "./project-context-lock.js";

export function atomicWriteFile(
  path: string,
  content: string,
  workspaceRoot: string,
  defaultMode: number,
  expectedHash?: string | null,
  afterExchange?: () => void,
  atomicExchangeUnavailable = false,
  beforeInstall?: (tempPath: string) => void,
  portableCreateOnly = false,
  maxObservedBytes?: number | null,
  allowPortableReplacement = false,
): void {
  const dir = resolve(path, "..");
  ensureSafeDirectory(dir, workspaceRoot, 0o700);
  assertNoSymlinkSegments(workspaceRoot, path);
  const anchoredOps = portableCreateOnly ? null : resolveAnchoredFsOps();
  if (!anchoredOps) {
    atomicWritePortable(
      path,
      content,
      workspaceRoot,
      defaultMode,
      expectedHash,
      beforeInstall,
      maxObservedBytes,
      allowPortableReplacement,
    );
    return;
  }
  if (
    allowPortableReplacement &&
    typeof expectedHash === "string" &&
    (atomicExchangeUnavailable || resolveAtomicExchange() === null)
  ) {
    atomicWritePortable(
      path,
      content,
      workspaceRoot,
      defaultMode,
      expectedHash,
      beforeInstall,
      maxObservedBytes,
      true,
    );
    return;
  }
  const directory = openAnchoredDirectory(dir, workspaceRoot, anchoredOps, maxObservedBytes);
  const targetName = basename(path);
  const previous = anchoredFileObservation(directory, targetName);
  const previousMode = previous?.mode ?? defaultMode;
  const tempName = `.project-context-${randomUUID()}.tmp`;
  const tempPath = join(dir, tempName);
  let fd: number | null = null;
  let preserveTemp = false;
  let directoryChanged = false;
  const desiredHash = sha256(content);
  try {
    fd = anchoredOpenExclusive(directory, tempName, previousMode);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    beforeInstall?.(tempPath);
    assertManagedDirectoryStable(dir, workspaceRoot, directory.identity);
    if (anchoredPreparedObservation(directory, tempName, path, "before installation").hash !== desiredHash) {
      throw new ProjectContextHashRace(`prepared bytes changed before installation: ${relativePosix(workspaceRoot, path)}`);
    }
    if (expectedHash === undefined) {
      if (!directory.ops.renameat(directory.fd, tempName, directory.fd, targetName)) {
        throw new ProjectContextHashRace(`managed path changed before installation: ${relativePosix(workspaceRoot, path)}`);
      }
      directoryChanged = true;
    } else if (expectedHash === null) {
      const prepared = anchoredPreparedObservation(directory, tempName, path, "before creation");
      if (anchoredFileObservation(directory, targetName) !== null) {
        throw new ProjectContextHashRace(`managed path appeared before creation: ${relativePosix(workspaceRoot, path)}`);
      }
      if (!directory.ops.linkat(directory.fd, tempName, directory.fd, targetName)) {
        throw new ProjectContextHashRace(`managed path appeared before creation: ${relativePosix(workspaceRoot, path)}`);
      }
      directoryChanged = true;
      const installed = anchoredFileObservation(directory, targetName);
      const stagedHash = anchoredFileHash(directory, tempName);
      if (
        !installed ||
        installed.dev !== prepared.dev ||
        installed.ino !== prepared.ino ||
        stagedHash !== desiredHash ||
        installed.hash !== desiredHash
      ) {
        // The target may now contain an ordinary concurrent edit. Preserve the
        // installed path and remove only our extra hard link before retrying.
        directory.ops.unlinkat(directory.fd, tempName);
        preserveTemp = true;
        throw new ProjectContextHashRace(`prepared bytes changed during creation: ${relativePosix(workspaceRoot, path)}`);
      }
      if (!directory.ops.unlinkat(directory.fd, tempName)) preserveTemp = true;
    } else {
      if (anchoredFileObservation(directory, targetName) === null) {
        throw new ProjectContextHashRace(`managed path disappeared before replacement: ${relativePosix(workspaceRoot, path)}`);
      }
      if (atomicExchangeUnavailable) {
        throw new ProjectContextError(
          "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
          "the platform could not provide an atomic exchange for compare-and-swap replacement",
        );
      }
      if (anchoredFileHash(directory, targetName) !== expectedHash) {
        throw new ProjectContextHashRace(`managed path changed before atomic replacement: ${relativePosix(workspaceRoot, path)}`);
      }
      if (anchoredPreparedObservation(directory, tempName, path, "before atomic replacement").hash !== desiredHash) {
        throw new ProjectContextHashRace(`prepared bytes changed before atomic replacement: ${relativePosix(workspaceRoot, path)}`);
      }
      atomicExchangeEntries(directory.fd, tempName, targetName);
      directoryChanged = true;
      let exchanged = true;
      try {
        const displacedAtExchange = anchoredFileHash(directory, tempName);
        const installedAtExchange = anchoredFileHash(directory, targetName);
        if (displacedAtExchange !== expectedHash) {
          preserveTemp = true;
          exchanged = false;
          throw new ProjectContextError(
            "PROJECT_CONTEXT_ATOMIC_REPLACE_CONFLICT",
            `the displaced managed file changed before exchange validation: ${relativePosix(workspaceRoot, path)}`,
          );
        }
        if (installedAtExchange !== desiredHash) {
          atomicExchangeEntries(directory.fd, tempName, targetName);
          exchanged = false;
          throw new ProjectContextHashRace(`prepared bytes changed during atomic replacement: ${relativePosix(workspaceRoot, path)}`);
        }
        afterExchange?.();
        const replacedHash = anchoredFileHash(directory, tempName);
        const replacementHash = anchoredFileHash(directory, targetName);
        if (replacedHash !== expectedHash) {
          preserveTemp = true;
          exchanged = false;
          throw new ProjectContextError(
            "PROJECT_CONTEXT_ATOMIC_REPLACE_CONFLICT",
            `the displaced managed file changed during atomic replacement: ${relativePosix(workspaceRoot, path)}`,
          );
        }
        if (replacementHash !== desiredHash) {
          directory.ops.unlinkat(directory.fd, tempName);
          exchanged = false;
          throw new ProjectContextHashRace(`managed path changed immediately after atomic replacement: ${relativePosix(workspaceRoot, path)}`);
        }
        if (!directory.ops.unlinkat(directory.fd, tempName)) preserveTemp = true;
        exchanged = false;
      } catch (error) {
        if (exchanged) {
          try {
            if (
              anchoredFileHash(directory, targetName) === desiredHash &&
              anchoredFileHash(directory, tempName) === expectedHash
            ) {
              atomicExchangeEntries(directory.fd, tempName, targetName);
              exchanged = false;
            } else {
              preserveTemp = true;
            }
          } catch {
            preserveTemp = true;
          }
        }
        throw error;
      }
    }
    assertManagedDirectoryStable(dir, workspaceRoot, directory.identity);
    fsyncSync(directory.fd);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (!preserveTemp) directory.ops.unlinkat(directory.fd, tempName);
    if (directoryChanged) fsyncSync(directory.fd);
    throw error;
  } finally {
    closeSync(directory.fd);
  }
}

export function atomicWritePortable(
  path: string,
  content: string,
  workspaceRoot: string,
  defaultMode: number,
  expectedHash: string | null | undefined,
  beforeInstall?: (tempPath: string) => void,
  maxObservedBytes?: number | null,
  allowReplacement = false,
): void {
  const desiredHash = sha256(content);
  const currentHash = portableFileHash(path, workspaceRoot, maxObservedBytes);
  if (expectedHash === undefined && currentHash === desiredHash) return;
  if (typeof expectedHash === "string" && allowReplacement) {
    atomicWritePortableReplacement(
      path,
      content,
      workspaceRoot,
      expectedHash,
      beforeInstall,
      maxObservedBytes,
    );
    return;
  }
  if (expectedHash !== null && !(expectedHash === undefined && currentHash === null)) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
      "the platform can create new managed files but cannot safely replace existing files",
    );
  }
  if (currentHash !== null) {
    throw new ProjectContextHashRace(`managed path appeared before portable creation: ${relativePosix(workspaceRoot, path)}`);
  }

  const dir = dirname(path);
  const directoryIdentity = captureManagedDirectoryIdentity(dir, workspaceRoot);
  const tempPath = join(dir, `.project-context-${randomUUID()}.tmp`);
  let fd: number | null = null;
  let tempIdentity: { dev: number; ino: number } | null = null;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      defaultMode,
    );
    const opened = fstatSync(fd);
    tempIdentity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    beforeInstall?.(tempPath);
    assertManagedDirectoryStable(dir, workspaceRoot, directoryIdentity);
    assertNoSymlinkSegments(workspaceRoot, tempPath);
    assertNoSymlinkSegments(workspaceRoot, path);
    if (
      portablePreparedHash(tempPath, path, workspaceRoot, maxObservedBytes, "before portable creation") !== desiredHash ||
      portableFileHash(path, workspaceRoot, maxObservedBytes) !== null
    ) {
      throw new ProjectContextHashRace(`managed path changed before portable creation: ${relativePosix(workspaceRoot, path)}`);
    }
    const prepared = lstatSync(tempPath);
    try {
      linkSync(tempPath, path);
    } catch {
      throw new ProjectContextHashRace(`managed path appeared during portable creation: ${relativePosix(workspaceRoot, path)}`);
    }
    const installed = lstatSync(path);
    if (
      installed.isSymbolicLink() ||
      installed.dev !== prepared.dev ||
      installed.ino !== prepared.ino ||
      portableFileHash(path, workspaceRoot, maxObservedBytes) !== desiredHash
    ) {
      throw new ProjectContextHashRace(`managed path changed during portable creation: ${relativePosix(workspaceRoot, path)}`);
    }
    rmSync(tempPath);
    tempIdentity = null;
    assertManagedDirectoryStable(dir, workspaceRoot, directoryIdentity);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (tempIdentity && managedDirectoryMatches(dir, workspaceRoot, directoryIdentity)) {
      try {
        const current = lstatSync(tempPath);
        if (!current.isSymbolicLink() && current.dev === tempIdentity.dev && current.ino === tempIdentity.ino) {
          rmSync(tempPath);
        }
      } catch {
        // Preserve an uncertain temp rather than following a replaced directory.
      }
    }
    throw error;
  }
}

export function atomicWritePortableReplacement(
  path: string,
  content: string,
  workspaceRoot: string,
  expectedHash: string,
  beforeInstall?: (tempPath: string) => void,
  maxObservedBytes?: number | null,
): void {
  const currentHash = portableFileHash(path, workspaceRoot, maxObservedBytes);
  if (currentHash !== expectedHash) {
    throw new ProjectContextHashRace(`managed path changed before portable replacement: ${relativePosix(workspaceRoot, path)}`);
  }
  const current = lstatSync(path);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new ProjectContextHashRace(`managed path is not a regular file: ${relativePosix(workspaceRoot, path)}`);
  }

  const dir = dirname(path);
  const directoryIdentity = captureManagedDirectoryIdentity(dir, workspaceRoot);
  const tempPath = join(dir, `.project-context-${randomUUID()}.tmp`);
  const desiredHash = sha256(content);
  let fd: number | null = null;
  let tempIdentity: { dev: number; ino: number } | null = null;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      current.mode & 0o777,
    );
    const opened = fstatSync(fd);
    tempIdentity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    beforeInstall?.(tempPath);
    assertManagedDirectoryStable(dir, workspaceRoot, directoryIdentity);
    assertNoSymlinkSegments(workspaceRoot, tempPath);
    assertNoSymlinkSegments(workspaceRoot, path);
    if (
      portableFileHash(path, workspaceRoot, maxObservedBytes) !== expectedHash ||
      portablePreparedHash(tempPath, path, workspaceRoot, maxObservedBytes, "before portable replacement") !== desiredHash
    ) {
      throw new ProjectContextHashRace(`managed path changed before portable replacement: ${relativePosix(workspaceRoot, path)}`);
    }
    renameSync(tempPath, path);
    tempIdentity = null;
    assertManagedDirectoryStable(dir, workspaceRoot, directoryIdentity);
    if (portableFileHash(path, workspaceRoot, maxObservedBytes) !== desiredHash) {
      throw new ProjectContextHashRace(`managed path changed during portable replacement: ${relativePosix(workspaceRoot, path)}`);
    }
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (tempIdentity && managedDirectoryMatches(dir, workspaceRoot, directoryIdentity)) {
      try {
        const candidate = lstatSync(tempPath);
        if (!candidate.isSymbolicLink() && candidate.dev === tempIdentity.dev && candidate.ino === tempIdentity.ino) {
          rmSync(tempPath);
        }
      } catch {
        // Preserve an uncertain temp rather than following a replaced directory.
      }
    }
    throw error;
  }
}

// The portable counterpart of `anchoredPreparedObservation`. Both paths now name
// an unreadable staging file the same way: macOS runs the anchored path and
// Windows the portable one, and a condition that reports differently depending on
// which platform hit it is how a defect stays unrecognised across a fleet.
export function portablePreparedHash(
  tempPath: string,
  path: string,
  workspaceRoot: string,
  maxObservedBytes: number | null | undefined,
  stage: string,
): string {
  const unreadable = (cause?: string) => new ProjectContextError(
    "PROJECT_CONTEXT_PREPARED_FILE_UNREADABLE",
    `the prepared managed file could not be read back ${stage}: ${relativePosix(workspaceRoot, path)}`,
    { staged_path: tempPath, stage, ...(cause === undefined ? {} : { cause }) },
  );
  let hash: string | null;
  try {
    hash = portableFileHash(tempPath, workspaceRoot, maxObservedBytes);
  } catch (error) {
    if (error instanceof ProjectContextError || error instanceof ProjectContextHashRace) throw error;
    throw unreadable((error as Error).message);
  }
  if (hash === null) throw unreadable();
  return hash;
}

export function portableFileHash(
  path: string,
  workspaceRoot: string,
  maxObservedBytes?: number | null,
): string | null {
  if (maxObservedBytes === undefined) return currentFileHash(path, workspaceRoot);
  if (!existsSync(path)) return null;
  assertNoSymlinkSegments(workspaceRoot, path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new ProjectContextHashRace("managed output is not a regular file");
  if (maxObservedBytes !== null && stat.size > maxObservedBytes) {
    throw new ProjectContextHashRace(`managed output exceeds the safe read limit: ${relativePosix(workspaceRoot, path)}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeProjectContextCoordinatedFile(input: {
  path: string;
  content: string;
  workspace_root: string;
  default_mode?: number;
  expected_hash: string | null | undefined;
  max_observed_bytes?: number | null;
  allow_portable_replacement?: boolean;
  force_portable_file_ops?: boolean;
  test_hooks?: {
    before_install?: (tempPath: string) => void;
  };
}): void {
  atomicWriteFile(
    resolve(input.path),
    input.content,
    assertSafeWorkspaceRoot(input.workspace_root),
    input.default_mode ?? 0o644,
    input.expected_hash,
    undefined,
    false,
    input.test_hooks?.before_install,
    input.force_portable_file_ops ?? false,
    input.max_observed_bytes,
    input.allow_portable_replacement ?? false,
  );
}

export function removeProjectContextCoordinatedFile(input: {
  path: string;
  workspace_root: string;
  expected_hash: string;
  max_observed_bytes?: number | null;
  allow_portable_removal?: boolean;
  force_portable_file_ops?: boolean;
  test_hooks?: {
    after_displace?: (displacedPath: string) => void;
  };
}): void {
  const workspaceRoot = assertSafeWorkspaceRoot(input.workspace_root);
  const path = resolve(input.path);
  assertNoSymlinkSegments(workspaceRoot, path);
  const dir = dirname(path);
  const anchoredOps = input.force_portable_file_ops ? null : resolveAnchoredFsOps();
  if (!anchoredOps) {
    if (!input.allow_portable_removal) {
      throw new ProjectContextError(
        "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
        "the platform could not provide directory-anchored managed-file removal",
      );
    }
    removePortableCoordinatedFile(
      path,
      workspaceRoot,
      input.expected_hash,
      input.max_observed_bytes,
      input.test_hooks?.after_displace,
    );
    return;
  }
  const directory = openAnchoredDirectory(dir, workspaceRoot, anchoredOps, input.max_observed_bytes);
  const targetName = basename(path);
  const displacedName = `.project-context-delete-${randomUUID()}.tmp`;
  let displaced = false;
  let expectedObservation: AnchoredFileObservation | null = null;
  try {
    const observed = anchoredFileObservation(directory, targetName);
    if (!observed || observed.hash !== input.expected_hash) {
      throw new ProjectContextHashRace(`managed path changed before deletion: ${relativePosix(workspaceRoot, path)}`);
    }
    expectedObservation = observed;
    if (!directory.ops.renameat(directory.fd, targetName, directory.fd, displacedName)) {
      throw new ProjectContextHashRace(`managed path changed during deletion: ${relativePosix(workspaceRoot, path)}`);
    }
    displaced = true;
    input.test_hooks?.after_displace?.(join(dir, displacedName));
    const moved = anchoredFileObservation(directory, displacedName);
    if (
      !moved ||
      moved.dev !== observed.dev ||
      moved.ino !== observed.ino ||
      moved.hash !== input.expected_hash ||
      anchoredFileObservation(directory, targetName) !== null
    ) {
      throw new ProjectContextHashRace(`managed path changed during deletion validation: ${relativePosix(workspaceRoot, path)}`);
    }
    if (!directory.ops.unlinkat(directory.fd, displacedName)) {
      throw new ProjectContextHashRace(`managed path could not be removed safely: ${relativePosix(workspaceRoot, path)}`);
    }
    displaced = false;
    assertManagedDirectoryStable(dir, workspaceRoot, directory.identity);
    fsyncSync(directory.fd);
  } catch (error) {
    if (
      displaced &&
      expectedObservation &&
      restoreAnchoredDisplacedFile(directory, displacedName, targetName, expectedObservation)
    ) {
      displaced = false;
    }
    throw error;
  } finally {
    closeSync(directory.fd);
  }
}

export function restoreAnchoredDisplacedFile(
  directory: AnchoredDirectory,
  displacedName: string,
  targetName: string,
  expected: AnchoredFileObservation,
): boolean {
  if (!directory.ops.linkat(directory.fd, displacedName, directory.fd, targetName)) return false;
  try {
    const displaced = anchoredFileObservation(directory, displacedName);
    const installed = anchoredFileObservation(directory, targetName);
    if (
      !displaced ||
      !installed ||
      displaced.dev !== expected.dev ||
      displaced.ino !== expected.ino ||
      displaced.dev !== installed.dev ||
      displaced.ino !== installed.ino ||
      displaced.hash !== expected.hash ||
      installed.hash !== expected.hash
    ) return false;
    if (!directory.ops.unlinkat(directory.fd, displacedName)) return false;
    fsyncSync(directory.fd);
    return true;
  } catch {
    return false;
  }
}

export function removePortableCoordinatedFile(
  path: string,
  workspaceRoot: string,
  expectedHash: string,
  maxObservedBytes?: number | null,
  afterDisplace?: (displacedPath: string) => void,
): void {
  if (portableFileHash(path, workspaceRoot, maxObservedBytes) !== expectedHash) {
    throw new ProjectContextHashRace(`managed path changed before portable deletion: ${relativePosix(workspaceRoot, path)}`);
  }
  const observed = lstatSync(path);
  if (observed.isSymbolicLink() || !observed.isFile()) {
    throw new ProjectContextHashRace(`managed path is not a regular file: ${relativePosix(workspaceRoot, path)}`);
  }
  const dir = dirname(path);
  const directoryIdentity = captureManagedDirectoryIdentity(dir, workspaceRoot);
  const displacedPath = join(dir, `.project-context-delete-${randomUUID()}.tmp`);
  let displaced = false;
  try {
    assertManagedDirectoryStable(dir, workspaceRoot, directoryIdentity);
    if (portableFileHash(path, workspaceRoot, maxObservedBytes) !== expectedHash) {
      throw new ProjectContextHashRace(`managed path changed before portable deletion: ${relativePosix(workspaceRoot, path)}`);
    }
    renameSync(path, displacedPath);
    displaced = true;
    afterDisplace?.(displacedPath);
    const moved = lstatSync(displacedPath);
    if (
      moved.isSymbolicLink() ||
      !moved.isFile() ||
      moved.dev !== observed.dev ||
      moved.ino !== observed.ino ||
      portableFileHash(displacedPath, workspaceRoot, maxObservedBytes) !== expectedHash ||
      existsSync(path)
    ) {
      throw new ProjectContextHashRace(`managed path changed during portable deletion: ${relativePosix(workspaceRoot, path)}`);
    }
    rmSync(displacedPath);
    displaced = false;
    assertManagedDirectoryStable(dir, workspaceRoot, directoryIdentity);
    fsyncDirectory(dir);
  } catch (error) {
    if (
      displaced &&
      managedDirectoryMatches(dir, workspaceRoot, directoryIdentity) &&
      restorePortableDisplacedFile(displacedPath, path, workspaceRoot, observed, expectedHash, maxObservedBytes)
    ) {
      displaced = false;
    }
    throw error;
  }
}

export function restorePortableDisplacedFile(
  displacedPath: string,
  path: string,
  workspaceRoot: string,
  expected: { dev: number; ino: number },
  expectedHash: string,
  maxObservedBytes?: number | null,
): boolean {
  try {
    linkSync(displacedPath, path);
  } catch {
    return false;
  }
  try {
    const displaced = lstatSync(displacedPath);
    const installed = lstatSync(path);
    if (
      displaced.isSymbolicLink() ||
      installed.isSymbolicLink() ||
      !displaced.isFile() ||
      !installed.isFile() ||
      displaced.dev !== expected.dev ||
      displaced.ino !== expected.ino ||
      displaced.dev !== installed.dev ||
      displaced.ino !== installed.ino ||
      portableFileHash(displacedPath, workspaceRoot, maxObservedBytes) !== expectedHash ||
      portableFileHash(path, workspaceRoot, maxObservedBytes) !== expectedHash
    ) return false;
    rmSync(displacedPath);
    fsyncDirectory(dirname(path));
    return true;
  } catch {
    return false;
  }
}
