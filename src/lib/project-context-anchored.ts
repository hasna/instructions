import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

export interface AnchoredDirectory {
  fd: number;
  path: string;
  workspaceRoot: string;
  identity: { dev: number; ino: number };
  ops: AnchoredFsOps;
  maxObservedBytes: number | null | undefined;
}

export interface AnchoredFileObservation {
  dev: number;
  ino: number;
  hash: string;
  mode: number;
}

export interface AnchoredFsOps {
  openat: (directoryFd: number, name: string, flags: number, mode: number) => number;
  renameat: (leftDirectoryFd: number, left: string, rightDirectoryFd: number, right: string) => boolean;
  linkat: (leftDirectoryFd: number, left: string, rightDirectoryFd: number, right: string) => boolean;
  unlinkat: (directoryFd: number, name: string) => boolean;
}

let anchoredFsOps: AnchoredFsOps | null | undefined;

export function openAnchoredDirectory(
  path: string,
  workspaceRoot: string,
  providedOps?: AnchoredFsOps,
  maxObservedBytes?: number | null,
): AnchoredDirectory {
  const ops = providedOps ?? resolveAnchoredFsOps();
  if (!ops) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
      "the platform could not provide directory-anchored managed-file operations",
    );
  }
  const identity = captureManagedDirectoryIdentity(path, workspaceRoot);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new ProjectContextHashRace(`managed parent directory changed while opening: ${relativePosix(workspaceRoot, path)}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== identity.dev || opened.ino !== identity.ino) {
      throw new ProjectContextHashRace(`managed parent directory changed while opening: ${relativePosix(workspaceRoot, path)}`);
    }
    assertManagedDirectoryStable(path, workspaceRoot, identity);
    return { fd, path, workspaceRoot, identity, ops, maxObservedBytes };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// openat(2) is variadic — `int openat(int, const char *, int, ...)` — and `mode`
// is the variadic argument the kernel reads only when O_CREAT is set. bun:ffi can
// only declare fixed arguments, and a fixed fourth argument happens to match the
// Linux integer calling convention while it does not match arm64 macOS, where
// variadic arguments are passed on the stack rather than in registers. There the
// kernel read an uninitialised slot: a create asking for 0o644 produced 0o140 in
// one measurement on station03 and 0o000 in another, never a mode with the owner
// read bit, so every readback failed and the failure was reported as a hash race
// on 14 of 16 fleet machines. Creation therefore no longer travels through the FFI
// declaration at all — it uses the compiled fs binding, which builds the variadic
// call correctly on every platform — and the directory anchor is re-established by
// verifying the created inode through the pinned directory fd instead of being
// assumed from the call. This is one code path on every platform, so the Linux
// suite exercises exactly what macOS runs. The remaining FFI openat call omits
// O_CREAT, so the kernel never reads its variadic slot.
export function anchoredOpenExclusive(directory: AnchoredDirectory, name: string, mode: number): number {
  const requestedMode = mode & 0o7777;
  let fd: number;
  try {
    fd = openSync(
      join(directory.path, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      requestedMode,
    );
  } catch {
    throw new ProjectContextHashRace(`could not create prepared managed file in ${relativePosix(directory.workspaceRoot, directory.path)}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new ProjectContextHashRace("prepared managed output is not a regular file");
    }
    if (!isPreparedManagedFileModeUsable(requestedMode, opened.mode)) {
      // Fail loudly rather than stage a file the platform made unreadable. Left
      // unchecked this is invisible until the readback returns nothing and the
      // caller blames a concurrent writer.
      throw new ProjectContextError(
        "PROJECT_CONTEXT_PREPARED_FILE_MODE_REJECTED",
        `the platform created the prepared managed file with an unusable mode in ${relativePosix(directory.workspaceRoot, directory.path)}`,
        { requested_mode: modeLiteral(requestedMode), observed_mode: modeLiteral(opened.mode) },
      );
    }
    assertManagedDirectoryStable(directory.path, directory.workspaceRoot, directory.identity);
    const anchored = anchoredFileObservation(directory, name);
    if (!anchored || anchored.dev !== opened.dev || anchored.ino !== opened.ino) {
      throw new ProjectContextHashRace(`prepared managed file is not the one anchored in ${relativePosix(directory.workspaceRoot, directory.path)}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function modeLiteral(mode: number): string {
  return `0o${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

// The staging file must never carry a permission the caller did not ask for, and
// must not lose the owner-read bit that the readback depends on. Both properties
// hold under every umask — a umask clears bits, and clearing bits is not a defect,
// so an equality check against the requested mode would reject an ordinary umask
// 0o077 machine. They still reject the modes arm64 macOS actually produced for a
// 0o644 request (0o140 — owner execute, group read, no owner read — and 0o000),
// and reject a widened mode such as 0o777.
//
// Owner read is conditional on having been requested, because a managed file the
// user chmod'd to 0o444 or 0o200 hands its own mode back here as the mode to stage
// with. Demanding owner write would reject a legitimate read-only managed file,
// and demanding owner read unconditionally would turn a 0o200 file into a mode
// complaint when the honest failure is the readback that follows.
export function isPreparedManagedFileModeUsable(requestedMode: number, observedMode: number): boolean {
  const requested = requestedMode & 0o7777;
  const observed = observedMode & 0o7777;
  if ((observed & ~requested) !== 0) return false;
  if ((requested & 0o400) !== 0 && (observed & 0o400) === 0) return false;
  return true;
}

// Which managed-file operation path this platform will actually take. Exposed so a
// test can assert it exercised the directory-anchored path rather than silently
// measuring the portable fallback, and so an operator can tell the two apart
// without reading the source.
export function projectContextFileOpsDiagnostics(): {
  platform: string;
  arch: string;
  anchored_file_ops: boolean;
  atomic_exchange: boolean;
} {
  return {
    platform: process.platform,
    arch: process.arch,
    anchored_file_ops: resolveAnchoredFsOps() !== null,
    atomic_exchange: resolveAtomicExchange() !== null,
  };
}

export function anchoredFileObservation(directory: AnchoredDirectory, name: string): AnchoredFileObservation | null {
  const fd = directory.ops.openat(directory.fd, name, constants.O_RDONLY | constants.O_NOFOLLOW, 0);
  if (fd < 0) return null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ProjectContextHashRace("managed output is not a regular file");
    const relativePath = relativePosix(directory.workspaceRoot, join(directory.path, name));
    const maxBytes = directory.maxObservedBytes === undefined
      ? relativePath === ".hasna/session-render-manifest.json" || relativePath === ".codewith/.hasna/session-render-manifest.json"
        ? SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES
        : 256 * 1024
      : directory.maxObservedBytes;
    if (maxBytes !== null && stat.size > maxBytes) {
      throw new ProjectContextHashRace(`managed output exceeds the safe read limit: ${relativePath}`);
    }
    return {
      dev: stat.dev,
      ino: stat.ino,
      hash: createHash("sha256").update(readFileSync(fd)).digest("hex"),
      mode: stat.mode & 0o777,
    };
  } finally {
    closeSync(fd);
  }
}

export function anchoredFileHash(directory: AnchoredDirectory, name: string): string | null {
  return anchoredFileObservation(directory, name)?.hash ?? null;
}

// A readback that fails is not a hash race. `anchoredFileObservation` returns null
// both when a staged file cannot be opened at all and when it was never there, and
// comparing that null against the expected digest reported "prepared bytes changed"
// for a file nobody else had touched — the message sent every reader hunting a
// concurrent writer. Staged-file readbacks go through here so the unreadable case
// is named for what it is, and so it is not retried: re-running a broken syscall
// path cannot succeed on a second attempt, only the hash race can.
export function anchoredPreparedObservation(
  directory: AnchoredDirectory,
  name: string,
  path: string,
  stage: string,
): AnchoredFileObservation {
  const observed = anchoredFileObservation(directory, name);
  if (!observed) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_PREPARED_FILE_UNREADABLE",
      `the prepared managed file could not be read back ${stage}: ${relativePosix(directory.workspaceRoot, path)}`,
      { staged_name: name, stage },
    );
  }
  return observed;
}

export function captureManagedDirectoryIdentity(
  path: string,
  workspaceRoot: string,
): { dev: number; ino: number } {
  assertNoSymlinkSegments(workspaceRoot, join(path, ".project-context-directory-guard"));
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ProjectContextHashRace(`managed parent directory disappeared: ${relativePosix(workspaceRoot, path)}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", `managed parent is not a stable directory: ${path}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

export function assertManagedDirectoryStable(
  path: string,
  workspaceRoot: string,
  expected: { dev: number; ino: number },
): void {
  assertNoSymlinkSegments(workspaceRoot, join(path, ".project-context-directory-guard"));
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(path);
  } catch {
    throw new ProjectContextHashRace(`managed parent directory disappeared during write: ${relativePosix(workspaceRoot, path)}`);
  }
  if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new ProjectContextHashRace(`managed parent directory changed during write: ${relativePosix(workspaceRoot, path)}`);
  }
}

export function managedDirectoryMatches(
  path: string,
  workspaceRoot: string,
  expected: { dev: number; ino: number },
): boolean {
  try {
    assertManagedDirectoryStable(path, workspaceRoot, expected);
    return true;
  } catch {
    return false;
  }
}

export type AtomicExchange = (
  leftDirectoryFd: number,
  left: string,
  rightDirectoryFd: number,
  right: string,
) => boolean;

let atomicExchange: AtomicExchange | null | undefined;
export const atomicExchangeLibraries: Array<ReturnType<typeof dlopen>> = [];

export function atomicExchangePaths(left: string, right: string): void {
  const exchange = resolveAtomicExchange();
  const atFdcwd = process.platform === "darwin" ? -2 : -100;
  if (!exchange || !exchange(atFdcwd, left, atFdcwd, right)) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
      "the platform could not provide an atomic exchange for compare-and-swap replacement",
    );
  }
}

export function atomicExchangeEntries(directoryFd: number, left: string, right: string): void {
  const exchange = resolveAtomicExchange();
  if (!exchange || !exchange(directoryFd, left, directoryFd, right)) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_ATOMIC_REPLACE_UNAVAILABLE",
      "the platform could not provide a directory-anchored atomic exchange",
    );
  }
}

export function resolveAtomicExchange(): AtomicExchange | null {
  if (atomicExchange !== undefined) return atomicExchange;
  if (process.platform === "linux") {
    const muslArch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
    const candidates = [
      "libc.so.6",
      "libc.so",
      ...(muslArch ? [`/lib/ld-musl-${muslArch}.so.1`, `/lib/libc.musl-${muslArch}.so.1`] : []),
    ];
    for (const candidate of candidates) {
      try {
        const library = dlopen(candidate, {
          renameat2: {
            args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
            returns: FFIType.i32,
          },
        });
        atomicExchangeLibraries.push(library);
        const renameat2 = library.symbols.renameat2;
        atomicExchange = (leftDirectoryFd, left, rightDirectoryFd, right) => renameat2(
          leftDirectoryFd,
          Buffer.from(`${left}\0`),
          rightDirectoryFd,
          Buffer.from(`${right}\0`),
          2,
        ) === 0;
        return atomicExchange;
      } catch {
        // Older glibc and some musl builds expose the kernel call only through syscall(2).
      }
    }
    const renameat2Syscall = process.arch === "arm64" ? 276 : process.arch === "x64" ? 316 : null;
    if (renameat2Syscall !== null) {
      for (const candidate of candidates) {
        try {
          const library = dlopen(candidate, {
            syscall: {
              args: [FFIType.i64, FFIType.i64, FFIType.cstring, FFIType.i64, FFIType.cstring, FFIType.u64],
              returns: FFIType.i64,
            },
          });
          atomicExchangeLibraries.push(library);
          const syscall = library.symbols.syscall;
          atomicExchange = (leftDirectoryFd, left, rightDirectoryFd, right) => Number(syscall(
            renameat2Syscall,
            leftDirectoryFd,
            Buffer.from(`${left}\0`),
            rightDirectoryFd,
            Buffer.from(`${right}\0`),
            2,
          )) === 0;
          return atomicExchange;
        } catch {
          // Try the next libc location before failing closed.
        }
      }
    }
  }
  if (process.platform === "darwin") {
    try {
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        renameatx_np: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
      });
      atomicExchangeLibraries.push(library);
      const renameatx = library.symbols.renameatx_np;
      atomicExchange = (leftDirectoryFd, left, rightDirectoryFd, right) => renameatx(
        leftDirectoryFd,
        Buffer.from(`${left}\0`),
        rightDirectoryFd,
        Buffer.from(`${right}\0`),
        2,
      ) === 0;
      return atomicExchange;
    } catch {
      // Fall through to a fail-closed unsupported result.
    }
  }
  // Windows ReplaceFileW can atomically install the prepared file, but it cannot
  // atomically materialize the displaced target back at the temp path. Without a
  // journaled recovery protocol that is not a true exchange, so updates fail closed.
  atomicExchange = null;
  return null;
}

export function resolveAnchoredFsOps(): AnchoredFsOps | null {
  if (anchoredFsOps !== undefined) return anchoredFsOps;
  const candidates = process.platform === "linux"
    ? [
        "libc.so.6",
        "libc.so",
        ...(process.arch === "arm64"
          ? ["/lib/ld-musl-aarch64.so.1", "/lib/libc.musl-aarch64.so.1"]
          : process.arch === "x64"
            ? ["/lib/ld-musl-x86_64.so.1", "/lib/libc.musl-x86_64.so.1"]
            : []),
      ]
    : process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : [];
  for (const candidate of candidates) {
    try {
      const library = dlopen(candidate, {
        openat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32],
          returns: FFIType.i32,
        },
        renameat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
          returns: FFIType.i32,
        },
        linkat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
          returns: FFIType.i32,
        },
        unlinkat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32],
          returns: FFIType.i32,
        },
      });
      atomicExchangeLibraries.push(library);
      anchoredFsOps = {
        openat: (directoryFd, name, flags, mode) => Number(library.symbols.openat(
          directoryFd,
          Buffer.from(`${name}\0`),
          flags,
          mode,
        )),
        renameat: (leftDirectoryFd, left, rightDirectoryFd, right) => library.symbols.renameat(
          leftDirectoryFd,
          Buffer.from(`${left}\0`),
          rightDirectoryFd,
          Buffer.from(`${right}\0`),
        ) === 0,
        linkat: (leftDirectoryFd, left, rightDirectoryFd, right) => library.symbols.linkat(
          leftDirectoryFd,
          Buffer.from(`${left}\0`),
          rightDirectoryFd,
          Buffer.from(`${right}\0`),
          0,
        ) === 0,
        unlinkat: (directoryFd, name) => library.symbols.unlinkat(
          directoryFd,
          Buffer.from(`${name}\0`),
          0,
        ) === 0,
      };
      return anchoredFsOps;
    } catch {
      // Try the next libc location before failing closed.
    }
  }
  anchoredFsOps = null;
  return null;
}
