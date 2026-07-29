import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LEGACY_CONFIGS_COMPAT_VERSION, LEGACY_CONFIGS_EXECUTABLE, LEGACY_CONFIGS_PACKAGE,
  PROJECT_CONTEXT_CACHE_PATH, PROJECT_CONTEXT_CACHE_SCHEMA, PROJECT_CONTEXT_FRAGMENT_PATH,
  PROJECT_CONTEXT_LOCK_PATH, PROJECT_CONTEXT_LOCK_STALE_MS, PROJECT_CONTEXT_MANAGED_COMMENT,
  PROJECT_CONTEXT_MANIFEST_PATH, PROJECT_CONTEXT_MAX_APPROX_TOKENS,
  PROJECT_CONTEXT_MAX_RENDERED_BYTES, PROJECT_CONTEXT_MAX_WARNINGS, PROJECT_CONTEXT_SCHEMA,
  PROJECT_CONTEXT_SNAPSHOT_DIR, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES,
  ProjectContextError, ProjectContextHashRace, compareRevisions, computeProjectContextSourceHash,
  isRecord, isSafeSingleLine, isStrictIsoTimestamp, parseProjectContextBundle, revisionKey,
  scanGeneratedContent, sha256, stableStringify,
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
import { atomicExchangePaths, resolveAtomicExchange } from "./project-context-anchored.js";

export function acquireWorkspaceLock(
  workspaceRoot: string,
  lockPath: string,
  afterOpen?: () => void,
  beforeStaleRemove?: (lockPath: string) => void,
  processStartIdentityLookup: (pid: number) => string | null = processStartIdentity,
): WorkspaceLock {
  const lockDirectory = resolve(lockPath, "..");
  ensureSafeDirectory(lockDirectory, workspaceRoot, 0o700);
  assertNoSymlinkSegments(workspaceRoot, lockPath);
  const tempPath = join(lockDirectory, `.project-context-lock-${randomUUID()}.tmp`);
  let fd: number | null = null;
  let openedIdentity: { dev: number; ino: number } | null = null;
  let openedContentHash: string | null = null;
  let linked = false;
  let preserveTemp = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const opened = fstatSync(fd);
    openedIdentity = { dev: opened.dev, ino: opened.ino };
    const content = `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: randomUUID(),
      created_at: new Date().toISOString(),
      process_start_id: processStartIdentityLookup(process.pid),
    })}\n`;
    openedContentHash = sha256(content);
    writeFileSync(fd, content);
    fsyncSync(fd);
    try {
      linkSync(tempPath, lockPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const takeover = tryTakeoverStaleWorkspaceLock(
        tempPath,
        lockPath,
        workspaceRoot,
        openedIdentity,
        openedContentHash,
        beforeStaleRemove,
        processStartIdentityLookup,
      );
      if (!takeover) {
        throw new ProjectContextError("PROJECT_CONTEXT_LOCKED", "another renderer holds the workspace project-context lock");
      }
      linked = true;
    }
    fsyncDirectory(lockDirectory);
    if (existsSync(tempPath)) {
      rmSync(tempPath);
      fsyncDirectory(lockDirectory);
    }
    const held = lstatSync(lockPath);
    if (
      held.isSymbolicLink() ||
      held.dev !== openedIdentity.dev ||
      held.ino !== openedIdentity.ino ||
      currentFileHash(lockPath, workspaceRoot) !== openedContentHash
    ) {
      throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during initialization");
    }
    afterOpen?.();
    return { fd, contentHash: openedContentHash, identity: openedIdentity };
  } catch (error) {
    preserveTemp = error instanceof ProjectContextError && error.code === "PROJECT_CONTEXT_LOCK_LOST";
    if (linked && openedIdentity && openedContentHash) {
      removeOwnedLockByInode(lockPath, openedIdentity, openedContentHash);
    }
    if (!preserveTemp && existsSync(tempPath)) {
      try { rmSync(tempPath); } catch { /* leave an unreferenced temp for later cleanup */ }
    }
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    throw error;
  }
}

export function removeOwnedLockByInode(
  lockPath: string,
  identity: { dev: number; ino: number },
  expectedHash?: string,
): void {
  try {
    if (!existsSync(lockPath)) return;
    const current = lstatSync(lockPath);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    if (expectedHash !== undefined && sha256(readFileSync(lockPath, "utf8")) !== expectedHash) return;
    rmSync(lockPath);
    fsyncDirectory(resolve(lockPath, ".."));
  } catch {
    // Leave an uncertain lock in place rather than deleting another owner's file.
  }
}

export function observeStaleWorkspaceLock(
  lockPath: string,
  workspaceRoot: string,
  processStartIdentityLookup: (pid: number) => string | null = processStartIdentity,
): { identity: { dev: number; ino: number }; contentHash: string } | null {
  let content: string;
  let observed: ReturnType<typeof lstatSync>;
  try {
    content = readUtf8RegularFile(lockPath, workspaceRoot, 2_048);
    observed = lstatSync(lockPath);
    if (observed.isSymbolicLink() || !observed.isFile()) return null;
  } catch {
    return null;
  }
  const contentHash = sha256(content);
  if (currentFileHash(lockPath, workspaceRoot) !== contentHash) return null;
  let pid: number | null = null;
  let createdAtMs: number | null = null;
  let recordedProcessStart: string | null = null;
  try {
    const value = JSON.parse(content) as unknown;
    if (isRecord(value)) {
      if (Number.isSafeInteger(value["pid"]) && Number(value["pid"]) > 0) pid = Number(value["pid"]);
      if (typeof value["created_at"] === "string" && isStrictIsoTimestamp(value["created_at"])) {
        const parsedCreatedAt = Date.parse(value["created_at"]);
        if (parsedCreatedAt <= Date.now()) createdAtMs = parsedCreatedAt;
      }
      if (typeof value["process_start_id"] === "string" && value["process_start_id"].length <= 512 && isSafeSingleLine(value["process_start_id"])) {
        recordedProcessStart = value["process_start_id"];
      }
    }
  } catch {
    if (Date.now() - observed.mtimeMs < PROJECT_CONTEXT_LOCK_STALE_MS) return null;
  }
  const observedStartMs = Math.min(observed.mtimeMs, createdAtMs ?? observed.mtimeMs);
  const staleByAge = Date.now() - observedStartMs >= PROJECT_CONTEXT_LOCK_STALE_MS;
  if (pid !== null && processIsAlive(pid)) {
    const currentProcessStart = processStartIdentityLookup(pid);
    if (recordedProcessStart !== null) {
      if (currentProcessStart === recordedProcessStart) return null;
      if (currentProcessStart === null && !staleByAge) return null;
    } else if (!staleByAge) {
      return null;
    }
  }
  if (pid === null && !staleByAge) return null;
  return {
    identity: { dev: observed.dev, ino: observed.ino },
    contentHash,
  };
}

export function tryTakeoverStaleWorkspaceLock(
  candidatePath: string,
  lockPath: string,
  workspaceRoot: string,
  candidateIdentity: { dev: number; ino: number },
  candidateHash: string,
  beforeTakeover?: (lockPath: string) => void,
  processStartIdentityLookup: (pid: number) => string | null = processStartIdentity,
): boolean {
  const stale = observeStaleWorkspaceLock(lockPath, workspaceRoot, processStartIdentityLookup);
  if (!stale) return false;
  beforeTakeover?.(lockPath);
  atomicExchangePaths(candidatePath, lockPath);
  let exchanged = true;
  try {
    const current = lstatSync(lockPath);
    const displaced = lstatSync(candidatePath);
    const candidateInstalled = (
      !current.isSymbolicLink() &&
      current.dev === candidateIdentity.dev &&
      current.ino === candidateIdentity.ino &&
      currentFileHash(lockPath, workspaceRoot) === candidateHash
    );
    const staleDisplaced = (
      !displaced.isSymbolicLink() &&
      displaced.dev === stale.identity.dev &&
      displaced.ino === stale.identity.ino &&
      currentFileHash(candidatePath, workspaceRoot) === stale.contentHash
    );
    if (!candidateInstalled || !staleDisplaced) {
      if (candidateInstalled && existsSync(candidatePath)) {
        atomicExchangePaths(candidatePath, lockPath);
        exchanged = false;
        return false;
      }
      throw new ProjectContextError(
        "PROJECT_CONTEXT_LOCK_LOST",
        "workspace lock changed during stale-lock takeover and could not be restored safely",
      );
    }
    rmSync(candidatePath);
    fsyncDirectory(resolve(lockPath, ".."));
    exchanged = false;
    return true;
  } catch (error) {
    if (exchanged) {
      try {
        if (currentFileHash(lockPath, workspaceRoot) === candidateHash && existsSync(candidatePath)) {
          atomicExchangePaths(candidatePath, lockPath);
          exchanged = false;
        }
      } catch {
        // Preserve both paths for bounded recovery instead of deleting uncertain ownership.
      }
    }
    if (exchanged) {
      throw new ProjectContextError(
        "PROJECT_CONTEXT_LOCK_LOST",
        "workspace lock takeover could not be completed or rolled back safely",
      );
    }
    throw error;
  }
}

export function assertWorkspaceLockHeld(lockPath: string, lock: WorkspaceLock, workspaceRoot: string): void {
  if (!existsSync(lockPath)) {
    throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during render");
  }
  const current = lstatSync(lockPath);
  if (
    current.isSymbolicLink() ||
    current.dev !== lock.identity.dev ||
    current.ino !== lock.identity.ino ||
    currentFileHash(lockPath, workspaceRoot) !== lock.contentHash
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_LOCK_LOST", "workspace project-context lock changed during render");
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks || !/^[0-9]+$/.test(startTicks)) return null;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return /^[a-f0-9-]{36}$/i.test(bootId) ? `linux:${bootId}:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
      return started ? `darwin:${started}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function releaseWorkspaceLock(lockPath: string, lock: WorkspaceLock, workspaceRoot: string): void {
  if (!resolveAtomicExchange()) {
    try {
      removeOwnedLockByInode(lockPath, lock.identity, lock.contentHash);
    } finally {
      try { closeSync(lock.fd); } catch { /* already closed */ }
    }
    return;
  }
  const lockDirectory = resolve(lockPath, "..");
  const releasePath = join(lockDirectory, `.project-context-release-${randomUUID()}.tmp`);
  let releaseFd: number | null = null;
  let releaseIdentity: { dev: number; ino: number } | null = null;
  let releaseHash: string | null = null;
  let exchanged = false;
  try {
    releaseFd = openSync(releasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const opened = fstatSync(releaseFd);
    releaseIdentity = { dev: opened.dev, ino: opened.ino };
    const releaseContent = `${JSON.stringify({
      schema: "hasna.instructions.project-context-lock/v1",
      pid: process.pid,
      nonce: randomUUID(),
      state: "releasing",
      created_at: new Date().toISOString(),
    })}\n`;
    releaseHash = sha256(releaseContent);
    writeFileSync(releaseFd, releaseContent);
    fsyncSync(releaseFd);
    closeSync(releaseFd);
    releaseFd = null;

    atomicExchangePaths(releasePath, lockPath);
    exchanged = true;
    const installed = lstatSync(lockPath);
    const displaced = lstatSync(releasePath);
    const releaseInstalled = (
      !installed.isSymbolicLink() &&
      installed.dev === releaseIdentity.dev &&
      installed.ino === releaseIdentity.ino &&
      currentFileHash(lockPath, workspaceRoot) === releaseHash
    );
    const ownedDisplaced = (
      !displaced.isSymbolicLink() &&
      displaced.dev === lock.identity.dev &&
      displaced.ino === lock.identity.ino &&
      currentFileHash(releasePath, workspaceRoot) === lock.contentHash
    );
    if (!releaseInstalled || !ownedDisplaced) {
      if (releaseInstalled && existsSync(releasePath)) {
        atomicExchangePaths(releasePath, lockPath);
        exchanged = false;
      }
      return;
    }
    rmSync(releasePath);
    removeOwnedLockByInode(lockPath, releaseIdentity, releaseHash);
    fsyncDirectory(lockDirectory);
    exchanged = false;
  } catch {
    if (exchanged) {
      try {
        if (releaseHash && currentFileHash(lockPath, workspaceRoot) === releaseHash && existsSync(releasePath)) {
          atomicExchangePaths(releasePath, lockPath);
          exchanged = false;
        }
      } catch {
        // Leave both paths in place rather than deleting uncertain lock ownership.
      }
    }
  } finally {
    if (releaseFd !== null) {
      try { closeSync(releaseFd); } catch { /* already closed */ }
    }
    if (!exchanged && existsSync(releasePath)) {
      try { rmSync(releasePath); } catch { /* preserve an uncertain release marker */ }
    }
    try { closeSync(lock.fd); } catch { /* already closed */ }
  }
}

export function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function ensureSafeDirectory(path: string, workspaceRoot: string, mode: number): void {
  const rel = relative(workspaceRoot, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new ProjectContextError("PROJECT_CONTEXT_PATH_ESCAPE", "managed directory escapes the workspace root");
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let current = workspaceRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", `managed path uses a symlink: ${current}`);
      if (!statSync(current).isDirectory()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", `managed path is not a directory: ${current}`);
    } else {
      mkdirSync(current, { mode });
      fsyncDirectory(resolve(current, ".."));
    }
  }
}
