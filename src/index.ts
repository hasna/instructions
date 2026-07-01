// Types
export * from "./types/index.js";

// DB — configs
export { createConfig, getConfig, getConfigById, listConfigs, updateConfig, deleteConfig, getConfigStats } from "./db/configs.js";

// DB — snapshots
export { createSnapshot, listSnapshots, getSnapshot, getSnapshotByVersion, pruneSnapshots } from "./db/snapshots.js";

// DB — profiles
export { createProfile, getProfile, listProfiles, updateProfile, deleteProfile, addConfigToProfile, removeConfigFromProfile, getProfileConfigs, profileHasSelectors, profileMatchesMachine, resolveProfileForMachine } from "./db/profiles.js";

// DB — machines
export { registerMachine, updateMachineApplied, listMachines, currentHostname, currentOs, currentArch } from "./db/machines.js";

// DB — database utilities
export { getDatabase, resetDatabase, uuid, now, slugify } from "./db/database.js";
export {
  CONFIGS_STORAGE_ENV,
  CONFIGS_STORAGE_FALLBACK_ENV,
  CONFIGS_STORAGE_MODE_ENV,
  CONFIGS_STORAGE_MODE_FALLBACK_ENV,
  CONFIGS_STORAGE_TABLES,
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  getStoragePg,
  getStorageStatus,
  getStorageSyncMetaAll,
  getSyncMetaAll,
  resolveTables,
  runStorageMigrations,
  storagePull,
  storagePush,
  storageSync,
} from "./db/storage-sync.js";
export type { StorageMode, StorageStatus, SyncMeta, SyncResult } from "./db/storage-sync.js";
export * from "./db/remote-storage.js";

// Status contract
export { getConfigsStatus } from "./status.js";
export type { ConfigsStatusContract } from "./status.js";

// DB — PostgreSQL migrations
export { PG_MIGRATIONS } from "./db/pg-migrations.js";

// Lib — apply
export { applyConfig, applyConfigs, expandPath } from "./lib/apply.js";
export type { ApplyOptions } from "./lib/apply.js";

// Lib — session render/apply
export {
  CODEWITH_NATIVE_IMPORTS_ENV,
  RAW_STORE_ROOT_ENV,
  SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_SCHEMA,
  SESSION_RENDER_TOOLS,
  SESSION_TOOL_ADAPTERS,
  cleanSessionPathInput,
  planSessionRender,
  resolveSessionPath,
  resolveSessionTargetOwnership,
  sourceFromConfig,
  sourceFromFilePath,
  sourcesFromIdentityExport,
} from "./lib/session-render.js";
export type {
  SessionInstructionLayer,
  SessionInstructionMerge,
  SessionInstructionOwner,
  SessionInstructionRule,
  SessionInstructionSource,
  SessionInstructionSourcePath,
  SessionRenderFile,
  SessionRenderFileRole,
  SessionRenderInput,
  SessionRenderManifest,
  SessionRenderMode,
  SessionRenderPlan,
  SessionRenderTargetKind,
  SessionRenderTool,
  SessionTargetOwner,
  SessionTargetOwnerKind,
  SessionToolAdapter,
} from "./lib/session-render.js";
export {
  applySessionRender,
  checkSessionRenderDrift,
  SessionApplyError,
} from "./lib/session-apply.js";
export type {
  SessionApplyAction,
  SessionApplyFileResult,
  SessionApplyOptions,
  SessionApplyResult,
  SessionDriftCheck,
  SessionDriftEntry,
} from "./lib/session-apply.js";

// Lib — transforms
export { applyTransform, buildCodexAgentsMd, buildCursorMdc, buildOpenCodeAgentsMd, stripClaudeOnlySections, transformSkillContent } from "./lib/transforms.js";
export type { TransformContext } from "./lib/transforms.js";

// Lib — machine
export { detectMachineContext, normalizeOsFamily, machineContextToVariables, resolveProfileVariables, templateizeMachineContent, renderMachineAwareContent } from "./lib/machine.js";
export type { MachineContextOverrides } from "./lib/machine.js";

// Lib — platform profile presets
export { PLATFORM_PROFILE_PRESETS, ensurePlatformProfiles } from "./lib/platform-profiles.js";
export {
  PROJECT_DASHBOARD_PROFILE_VARIABLES,
  PROJECT_DASHBOARD_STANDARD_CONTENT,
  PROJECT_DASHBOARD_STANDARD_SLUG,
  ensureProjectDashboardStandardConfig,
} from "./lib/project-dashboard-standard.js";

// Lib — sync
export { syncKnown, syncToDisk, syncProject, diffConfig, detectCategory, detectAgent, detectFormat, KNOWN_CONFIGS, PROJECT_CONFIG_FILES } from "./lib/sync.js";
export { syncFromDir, syncToDir } from "./lib/sync-dir.js";
export type { SyncKnownOptions, SyncToDiskOptions, SyncProjectOptions, KnownConfig } from "./lib/sync.js";
export type { SyncFromDirOptions } from "./lib/sync-dir.js";

// Lib — export/import
export { exportConfigs } from "./lib/export.js";
export { importConfigs } from "./lib/import.js";
export type { ExportOptions } from "./lib/export.js";
export type { ImportOptions, ImportResult } from "./lib/import.js";

// Lib — template
export { parseTemplateVars, extractTemplateVars, renderTemplate, isTemplate } from "./lib/template.js";
export type { TemplateVar } from "./lib/template.js";

// Lib — redact
export { redactContent, scanSecrets, hasSecrets } from "./lib/redact.js";
export type { RedactResult, RedactedVar, RedactFormat } from "./lib/redact.js";
