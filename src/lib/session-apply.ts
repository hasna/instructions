import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
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
  const snapshot = {
    schema: "hasna.configs.session-render-snapshot/v1",
    createdAt: new Date().toISOString(),
    tool: plan.tool,
    profile: plan.profile,
    targetHome,
    manifestPath,
    previousManifest,
    files: existingFiles,
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
