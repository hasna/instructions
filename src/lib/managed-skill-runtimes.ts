import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const INBOX_CONVERSATIONS_MINIMUM_VERSION = "0.5.28";

const INBOX_SKILL_MARKERS = [
  [".claude", "skills", "inbox", "SKILL.md"],
  [".codex", "skills", "inbox", "SKILL.md"],
  [".codewith", "skills", "inbox", "SKILL.md"],
  [".config", "opencode", "skills", "inbox", "SKILL.md"],
  [".cursor", "skills", "inbox", "SKILL.md"],
] as const;

const REQUIRED_WATCH_FLAGS = ["--from <agent>", "--all", "--full-content"] as const;

export type ManagedSkillRuntimeAction = "skipped" | "unchanged" | "update" | "failed";

export interface ManagedSkillRuntimeStatus {
  skill: "inbox";
  runtime: "conversations watch";
  minimum_version: typeof INBOX_CONVERSATIONS_MINIMUM_VERSION;
  skill_present: boolean;
  skill_markers: string[];
  skill_contracts_current: number;
  stale_skill_markers: string[];
  expected_skill_sha256: string | null;
  runtime_command: string;
  runtime_present: boolean;
  runtime_version: string | null;
  watch_supports_from: boolean;
  watch_supports_all: boolean;
  watch_supports_full_content: boolean;
  hosted_heartbeat: "unverified" | "passed" | "failed";
  delivery_verified: boolean;
  manual_fallback_ready: boolean;
  healthy: boolean;
  reason: string;
}

export interface ManagedSkillRuntimeInspection {
  runtimes: ManagedSkillRuntimeStatus[];
  skills_present: number;
  healthy: number;
  missing: number;
}

export interface ManagedSkillRuntimeResult extends ManagedSkillRuntimeStatus {
  action: ManagedSkillRuntimeAction;
  dry_run: boolean;
  skill_contracts_changed: number;
}

export interface ManagedSkillRuntimeReconcileReport {
  runtimes: ManagedSkillRuntimeResult[];
  changed: number;
  failed: number;
  dry_run: boolean;
}

export interface ManagedSkillRuntimeOptions {
  homeDir?: string;
  assetPath?: string;
  conversationsCommand?: string;
  agent?: string;
  deliveryVerified?: boolean;
  dryRun?: boolean;
}

interface CommandProbe {
  ok: boolean;
  output: string;
}

interface SkillSnapshot {
  path: string;
  content: string | null;
  mode: number | null;
  regular: boolean;
}

interface SkillWriteSnapshot {
  path: string;
  content: string;
  mode: number;
}

interface SkillWriteFileOperations {
  lstat(path: string): Stats | null;
  read(path: string): string;
  write(path: string, content: string, mode: number): void;
}

export interface SkillWriteTransactionResult {
  ok: boolean;
  error: string | null;
  rollback_conflicts: string[];
}

interface InboxInspection {
  status: ManagedSkillRuntimeStatus;
  canonicalContent: string | null;
  snapshots: SkillSnapshot[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function packagedInboxSkillPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  const candidates = [
    join(import.meta.dir, "..", "..", "assets", "skills", "inbox", "SKILL.md"),
    join(import.meta.dir, "..", "assets", "skills", "inbox", "SKILL.md"),
    join(process.cwd(), "assets", "skills", "inbox", "SKILL.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`packaged inbox skill contract is missing (checked ${candidates.length} package-relative locations)`);
  }
  return found;
}

function readCanonicalSkill(explicitPath?: string): { content: string; sha256: string } {
  const assetPath = packagedInboxSkillPath(explicitPath);
  const stat = lstatOrNull(assetPath);
  if (!stat?.isFile()) {
    throw new Error("packaged inbox skill contract is not a regular file");
  }
  const content = readFileSync(assetPath, "utf8");
  if (!content.includes("conversations watch --from <agent> --all")) {
    throw new Error("packaged inbox skill contract does not declare the canonical conversations watcher");
  }
  if (!content.includes("There is no separate")) {
    throw new Error("packaged inbox skill contract does not retire the legacy executable");
  }
  return { content, sha256: sha256(content) };
}

function runProbe(command: string, args: string[]): CommandProbe {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return { ok: false, output: "" };
  }
  return {
    ok: true,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function inspectSkillMarkers(homeDir: string): SkillSnapshot[] {
  return INBOX_SKILL_MARKERS
    .map((parts) => join(homeDir, ...parts))
    .map((path): SkillSnapshot | null => {
      const stat = lstatOrNull(path);
      if (!stat) return null;
      if (!stat.isFile()) {
        return { path, content: null, mode: null, regular: false };
      }
      return {
        path,
        content: readFileSync(path, "utf8"),
        mode: stat.mode & 0o777,
        regular: true,
      };
    })
    .filter((snapshot): snapshot is SkillSnapshot => snapshot !== null);
}

function inspectInbox(options: ManagedSkillRuntimeOptions): InboxInspection {
  const homeDir = options.homeDir ?? homedir();
  const runtimeCommand = options.conversationsCommand ?? "conversations";
  const snapshots = inspectSkillMarkers(homeDir);
  const skillPresent = snapshots.length > 0;

  let canonicalContent: string | null = null;
  let canonicalSha256: string | null = null;
  let assetError: string | null = null;
  try {
    const canonical = readCanonicalSkill(options.assetPath);
    canonicalContent = canonical.content;
    canonicalSha256 = canonical.sha256;
  } catch (error) {
    assetError = error instanceof Error ? error.message : String(error);
  }

  const versionProbe = skillPresent ? runProbe(runtimeCommand, ["--version"]) : { ok: false, output: "" };
  const helpProbe = versionProbe.ok ? runProbe(runtimeCommand, ["watch", "--help"]) : { ok: false, output: "" };
  const runtimeVersion = versionProbe.ok ? parseVersion(versionProbe.output) : null;
  const supportsFrom = helpProbe.ok && helpProbe.output.includes(REQUIRED_WATCH_FLAGS[0]);
  const supportsAll = helpProbe.ok && helpProbe.output.includes(REQUIRED_WATCH_FLAGS[1]);
  const supportsFullContent = helpProbe.ok && helpProbe.output.includes(REQUIRED_WATCH_FLAGS[2]);
  const packageReady =
    versionProbe.ok &&
    runtimeVersion !== null &&
    compareVersions(runtimeVersion, INBOX_CONVERSATIONS_MINIMUM_VERSION) >= 0 &&
    helpProbe.ok &&
    supportsFrom &&
    supportsAll &&
    supportsFullContent;
  const heartbeatProbe =
    skillPresent && packageReady && options.agent
      ? runProbe(runtimeCommand, ["agents", "heartbeat", "--from", options.agent, "--json"])
      : null;
  const hostedHeartbeat =
    heartbeatProbe === null ? "unverified" : heartbeatProbe.ok ? "passed" : "failed";
  const deliveryVerified = hostedHeartbeat === "passed" && options.deliveryVerified === true;
  const staleMarkers =
    canonicalContent === null
      ? snapshots.map((snapshot) => snapshot.path)
      : snapshots
          .filter((snapshot) => !snapshot.regular || snapshot.content !== canonicalContent)
          .map((snapshot) => snapshot.path);

  let reason = "skill not installed";
  if (skillPresent) {
    const nonRegular = snapshots.some((snapshot) => !snapshot.regular);
    if (nonRegular) reason = "managed skill target is not a regular file";
    else if (assetError) reason = assetError;
    else if (!versionProbe.ok) reason = "conversations command unavailable";
    else if (!runtimeVersion) reason = "conversations version is unreadable";
    else if (compareVersions(runtimeVersion, INBOX_CONVERSATIONS_MINIMUM_VERSION) < 0) {
      reason = `conversations ${runtimeVersion} is older than ${INBOX_CONVERSATIONS_MINIMUM_VERSION}`;
    } else if (!helpProbe.ok) reason = "conversations watch help is unavailable";
    else if (!supportsFrom || !supportsAll || !supportsFullContent) {
      const missing = [
        !supportsFrom ? "--from" : null,
        !supportsAll ? "--all" : null,
        !supportsFullContent ? "--full-content" : null,
      ].filter((flag): flag is string => flag !== null);
      reason = `conversations watch is missing required flags: ${missing.join(", ")}`;
    } else if (staleMarkers.length > 0) reason = "skill contract stale";
    else if (hostedHeartbeat === "failed") reason = "hosted heartbeat failed; manual fallback required";
    else if (hostedHeartbeat === "unverified") reason = "hosted heartbeat unverified; manual fallback required";
    else if (!deliveryVerified) reason = "hosted heartbeat passed; channel and DM delivery verification required";
    else reason = "ready";
  }

  return {
    status: {
      skill: "inbox",
      runtime: "conversations watch",
      minimum_version: INBOX_CONVERSATIONS_MINIMUM_VERSION,
      skill_present: skillPresent,
      skill_markers: snapshots.map((snapshot) => snapshot.path),
      skill_contracts_current: snapshots.length - staleMarkers.length,
      stale_skill_markers: staleMarkers,
      expected_skill_sha256: canonicalSha256,
      runtime_command: runtimeCommand,
      runtime_present: versionProbe.ok,
      runtime_version: runtimeVersion,
      watch_supports_from: supportsFrom,
      watch_supports_all: supportsAll,
      watch_supports_full_content: supportsFullContent,
      hosted_heartbeat: hostedHeartbeat,
      delivery_verified: deliveryVerified,
      manual_fallback_ready: skillPresent && staleMarkers.length === 0 && packageReady,
      healthy: !skillPresent || reason === "ready",
      reason,
    },
    canonicalContent,
    snapshots,
  };
}

export function inspectManagedSkillRuntimes(
  options: Omit<ManagedSkillRuntimeOptions, "dryRun"> = {},
): ManagedSkillRuntimeInspection {
  const runtime = inspectInbox(options).status;
  const installed = runtime.skill_present ? [runtime] : [];
  return {
    runtimes: [runtime],
    skills_present: installed.length,
    healthy: installed.filter((item) => item.healthy).length,
    missing: installed.filter((item) => !item.healthy).length,
  };
}

function runtimeReadyForWrite(status: ManagedSkillRuntimeStatus): boolean {
  return (
    status.runtime_present &&
    status.runtime_version !== null &&
    compareVersions(status.runtime_version, INBOX_CONVERSATIONS_MINIMUM_VERSION) >= 0 &&
    status.watch_supports_from &&
    status.watch_supports_all &&
    status.watch_supports_full_content
  );
}

function projectUpdatedStatus(
  status: ManagedSkillRuntimeStatus,
  contractCount: number,
): ManagedSkillRuntimeStatus {
  const healthy = status.hosted_heartbeat === "passed" && status.delivery_verified;
  return {
    ...status,
    skill_contracts_current: contractCount,
    stale_skill_markers: [],
    manual_fallback_ready: true,
    healthy,
    reason: healthy
      ? "ready"
      : status.hosted_heartbeat === "failed"
        ? "hosted heartbeat failed; manual fallback required"
        : status.hosted_heartbeat === "unverified"
          ? "hosted heartbeat unverified; manual fallback required"
          : "hosted heartbeat passed; channel and DM delivery verification required",
  };
}

function cleanup(path: string): void {
  rmSync(path, { force: true });
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(tempPath, content, { mode, flag: "wx" });
    renameSync(tempPath, path);
  } finally {
    cleanup(tempPath);
  }
}

const DEFAULT_SKILL_WRITE_FILE_OPERATIONS: SkillWriteFileOperations = {
  lstat: lstatOrNull,
  read: (path) => readFileSync(path, "utf8"),
  write: writeAtomic,
};

/**
 * Apply a set of inspected skill-contract writes as one best-effort
 * transaction. Rollback owns a file only while it is still a regular file and
 * still contains the canonical bytes written by this invocation. A later edit
 * is preserved and returned as a rollback conflict instead of being replaced
 * with the stale before-image.
 *
 * Exported from this internal module so the real transaction can be exercised
 * with deterministic file-operation interleavings. It is not re-exported from
 * the package root.
 */
export function writeSkillContractsTransactional(
  snapshots: SkillWriteSnapshot[],
  canonicalContent: string,
  fileOperations: SkillWriteFileOperations = DEFAULT_SKILL_WRITE_FILE_OPERATIONS,
): SkillWriteTransactionResult {
  const written: SkillWriteSnapshot[] = [];

  try {
    for (const snapshot of snapshots) {
      const currentStat = fileOperations.lstat(snapshot.path);
      if (!currentStat?.isFile() || fileOperations.read(snapshot.path) !== snapshot.content) {
        throw new Error("managed skill changed after inspection; refusing a stale write");
      }
      fileOperations.write(snapshot.path, canonicalContent, snapshot.mode);
      written.push(snapshot);
    }
    return { ok: true, error: null, rollback_conflicts: [] };
  } catch (error) {
    const rollbackConflicts: string[] = [];

    for (const snapshot of written.reverse()) {
      const currentStat = fileOperations.lstat(snapshot.path);
      if (!currentStat?.isFile()) {
        rollbackConflicts.push(`${snapshot.path}: no longer a regular file`);
        continue;
      }

      let currentContent: string;
      try {
        currentContent = fileOperations.read(snapshot.path);
      } catch {
        rollbackConflicts.push(`${snapshot.path}: could not read the current file`);
        continue;
      }

      if (currentContent !== canonicalContent) {
        rollbackConflicts.push(`${snapshot.path}: changed after this reconciliation wrote it`);
        continue;
      }

      try {
        fileOperations.write(snapshot.path, snapshot.content, snapshot.mode);
      } catch {
        rollbackConflicts.push(`${snapshot.path}: still owned but could not be restored`);
      }
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rollback_conflicts: rollbackConflicts,
    };
  }
}

export async function reconcileManagedSkillRuntimes(
  options: ManagedSkillRuntimeOptions = {},
): Promise<ManagedSkillRuntimeReconcileReport> {
  const dryRun = options.dryRun ?? false;
  const before = inspectInbox(options);
  const status = before.status;

  if (!status.skill_present) {
    return {
      runtimes: [{ ...status, action: "skipped", dry_run: dryRun, skill_contracts_changed: 0 }],
      changed: 0,
      failed: 0,
      dry_run: dryRun,
    };
  }

  if (before.snapshots.some((snapshot) => !snapshot.regular)) {
    return {
      runtimes: [{ ...status, action: "failed", dry_run: dryRun, skill_contracts_changed: 0 }],
      changed: 0,
      failed: 1,
      dry_run: dryRun,
    };
  }

  if (!before.canonicalContent || !runtimeReadyForWrite(status)) {
    return {
      runtimes: [{ ...status, action: "failed", dry_run: dryRun, skill_contracts_changed: 0 }],
      changed: 0,
      failed: 1,
      dry_run: dryRun,
    };
  }

  const staleSnapshots = before.snapshots.filter(
    (snapshot) => snapshot.content !== before.canonicalContent,
  );
  if (staleSnapshots.length === 0) {
    return {
      runtimes: [{ ...status, action: "unchanged", dry_run: dryRun, skill_contracts_changed: 0 }],
      changed: 0,
      failed: 0,
      dry_run: dryRun,
    };
  }

  if (dryRun) {
    const projected = projectUpdatedStatus(status, before.snapshots.length);
    return {
      runtimes: [{
        ...projected,
        action: "update",
        dry_run: true,
        skill_contracts_changed: staleSnapshots.length,
      }],
      changed: 1,
      failed: 0,
      dry_run: true,
    };
  }

  const transaction = writeSkillContractsTransactional(
    staleSnapshots.map((snapshot) => ({
      path: snapshot.path,
      content: snapshot.content!,
      mode: snapshot.mode ?? 0o644,
    })),
    before.canonicalContent,
  );
  if (!transaction.ok) {
    const rollbackConflictReason =
      transaction.rollback_conflicts.length > 0
        ? `; rollback conflicts: ${transaction.rollback_conflicts.join("; ")}`
        : "";
    const reason = `${transaction.error ?? "managed skill reconciliation failed"}${rollbackConflictReason}`;
    return {
      runtimes: [{
        ...status,
        action: "failed",
        dry_run: false,
        skill_contracts_changed: 0,
        reason,
      }],
      changed: 0,
      failed: 1,
      dry_run: false,
    };
  }

  const after = inspectInbox(options).status;
  const accepted = after.healthy || after.manual_fallback_ready;
  return {
    runtimes: [{
      ...after,
      action: accepted ? "update" : "failed",
      dry_run: false,
      skill_contracts_changed: accepted ? staleSnapshots.length : 0,
    }],
    changed: accepted ? 1 : 0,
    failed: accepted ? 0 : 1,
    dry_run: false,
  };
}
