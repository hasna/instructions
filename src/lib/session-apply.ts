import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  observeProjectContextSessionGuard,
  removeProjectContextCoordinatedFile,
  withProjectContextSessionGuard,
  writeProjectContextCoordinatedFile,
  type ProjectContextWriteCoordination,
} from "./project-context.js";
import {
  SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_SCHEMA,
  type SessionRenderFile,
  type SessionRenderFileRole,
  type SessionRenderManifest,
  type SessionRenderPlan,
} from "./session-render.js";

export type SessionApplyAction = "create" | "update" | "delete" | "unchanged" | "conflict";

export interface SessionApplyFileResult {
  path: string;
  relativePath: string;
  role: SessionRenderFileRole;
  action: SessionApplyAction;
  changed: boolean;
  previousSha256: string | null;
  newSha256: string;
  reason: string | null;
}

export interface SessionDriftEntry {
  path: string;
  relativePath: string;
  expectedSha256: string;
  actualSha256: string | null;
  reason: "missing" | "hash_mismatch";
}

export interface SessionDriftCheck {
  checked: boolean;
  clean: boolean;
  manifestPath: string;
  checkedAt: string;
  missing: SessionDriftEntry[];
  drifted: SessionDriftEntry[];
}

export interface SessionApplyResult {
  dryRun: boolean;
  applied: boolean;
  targetHome: string;
  manifestPath: string;
  snapshotPath: string | null;
  env: Record<string, string>;
  files: SessionApplyFileResult[];
  conflicts: SessionApplyFileResult[];
  drift: SessionDriftCheck;
}

export interface SessionApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  test_hooks?: {
    before_apply_writes?: (context: {
      plan: SessionRenderPlan;
      results: SessionApplyFileResult[];
    }) => void;
    force_portable_file_ops?: boolean;
  };
}

export interface SessionRestoreOptions {
  dryRun?: boolean;
  test_hooks?: {
    force_portable_file_ops?: boolean;
  };
}

export interface SessionRestoreConflict {
  path: string;
  relativePath: string;
  expectedSha256: string | null;
  actualSha256: string | null;
}

export interface SessionRestoreFileResult {
  path: string;
  relativePath: string;
  action: "create" | "update" | "delete" | "unchanged";
  previousSha256: string | null;
  restoredSha256: string | null;
}

export interface SessionRestoreResult {
  dryRun: boolean;
  restored: boolean;
  snapshotPath: string;
  targetHome: string;
  conflicts: SessionRestoreConflict[];
  files: SessionRestoreFileResult[];
}

type SessionSnapshotAction = "create" | "update" | "delete" | "unchanged";
type SessionSnapshotSchema =
  | "hasna.configs.session-render-snapshot/v1"
  | "hasna.configs.session-render-snapshot/v2";

interface SessionRenderSnapshotAfterFileV1 {
  path: string;
  relativePath: string;
  role: SessionRenderFileRole;
  action: SessionSnapshotAction;
  sha256: string | null;
}

interface SessionRenderSnapshot {
  schema: SessionSnapshotSchema;
  createdAt: string;
  tool: SessionRenderPlan["tool"];
  profile: string;
  targetHome: string;
  targetKind: SessionRenderPlan["targetKind"];
  manifestPath: string;
  previousManifest: SessionRenderManifest | null;
  files: Array<{
    path: string;
    relativePath: string;
    role: SessionRenderFileRole;
    sha256: string;
    content: string;
  }>;
  afterFiles: SessionRenderSnapshotAfterFileV1[];
}

interface StoredSessionRenderSnapshot extends Omit<SessionRenderSnapshot, "afterFiles"> {
  afterFiles: Array<Omit<SessionRenderSnapshotAfterFileV1, "action"> & {
    action?: SessionSnapshotAction;
  }>;
}

export class SessionApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionApplyError";
  }
}

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
    || !Array.isArray(snapshot.afterFiles)
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
    || (snapshot.targetKind !== "session-home" && snapshot.targetKind !== "project-root")
  ) {
    throw new SessionApplyError(`Session snapshot is incomplete: ${snapshotPath}`);
  }
  const targetHome = assertSafeTargetHome(snapshot.targetHome);
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
  const previousManifestFiles = indexPreviousManifestFiles(snapshot.previousManifest, targetHome, snapshotPath);
  const afterRelativePaths = new Set<string>();
  const afterFiles: SessionRenderSnapshot["afterFiles"] = [];
  for (const file of snapshot.afterFiles) {
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
    afterFiles,
  } as SessionRenderSnapshot;
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
  file: StoredSessionRenderSnapshot["afterFiles"][number],
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

function resolveSnapshotFilePath(relativePath: string, recordedPath: string, targetHome: string): string {
  const path = resolveManifestRelativePath(relativePath, targetHome);
  if (resolve(recordedPath) !== path) {
    throw new SessionApplyError(`Session snapshot file path mismatch for ${relativePath}`);
  }
  return path;
}

function planFileResult(
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

function planStaleFileResults(
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

function planStaleFileResult(
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

function isPreviouslyManaged(
  file: SessionRenderFile,
  previousSha256: string | null,
  previousHashes: Map<string, string>,
  previousManifest: SessionRenderManifest | null,
): boolean {
  if (file.role === "manifest") return previousManifest !== null;
  if (!previousSha256) return false;
  return previousHashes.get(file.relativePath) === previousSha256;
}

function resolvePlannedFilePath(
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

function resolveManifestRelativePath(relativePath: string, targetHome: string): string {
  const target = resolve(targetHome, ...relativePath.split(/[\\/]+/));
  const rel = relative(targetHome, target);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new SessionApplyError(`Session manifest file escapes target home: ${relativePath}`);
  }
  assertNoSymlinkSegments(targetHome, target);
  return target;
}

function readPreviousManifest(path: string): SessionRenderManifest | null {
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

function applyPlannedFile(
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

function assertExpectedSessionFileHash(
  path: string,
  targetHome: string,
  expectedHash: string | null,
): void {
  const actualHash = currentSessionFileHash(path, targetHome);
  if (actualHash !== expectedHash) {
    throw new SessionApplyError(`Session apply path changed after planning: ${relative(targetHome, path)}`);
  }
}

function currentSessionFileHash(path: string, targetHome: string): string | null {
  assertNoSymlinkSegments(targetHome, path);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SessionApplyError(`Session apply path is not a regular file: ${path}`);
  }
  return sha256(readFileSync(path, "utf-8"));
}

function requiredPreviousHash(result: SessionApplyFileResult): string {
  if (result.previousSha256 === null) {
    throw new SessionApplyError(`Session delete has no previous hash: ${result.relativePath}`);
  }
  return result.previousSha256;
}

function writeSessionSnapshot(
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

function assertSafeTargetHome(targetHome: string): string {
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

function assertNoSymlinkSegments(root: string, target: string): void {
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

function assertNoSymlinkAncestors(path: string): void {
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
