import type {
  SessionRenderFileRole, SessionRenderManifest, SessionRenderPlan,
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

export type SessionSnapshotAction = "create" | "update" | "delete" | "unchanged";
export type SessionSnapshotSchema =
  | "hasna.configs.session-render-snapshot/v1"
  | "hasna.configs.session-render-snapshot/v2";

export interface SessionRenderSnapshotAfterFileV1 {
  path: string;
  relativePath: string;
  role: SessionRenderFileRole;
  action: SessionSnapshotAction;
  sha256: string | null;
}

export interface SessionRenderSnapshot {
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

export interface StoredSessionRenderSnapshot extends Omit<SessionRenderSnapshot, "targetKind" | "afterFiles"> {
  targetKind?: SessionRenderPlan["targetKind"];
  afterFiles?: Array<Omit<SessionRenderSnapshotAfterFileV1, "action"> & {
    action?: SessionSnapshotAction;
  }>;
}

export class SessionApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionApplyError";
  }
}

