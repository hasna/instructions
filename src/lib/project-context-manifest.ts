import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { SESSION_INSTRUCTION_LAYERS, SESSION_RENDER_SCHEMA } from "./session-render-contract.js";
import { scanSecrets } from "./redact.js";
import {
  LEGACY_CONFIGS_COMPAT_VERSION, LEGACY_CONFIGS_EXECUTABLE, LEGACY_CONFIGS_PACKAGE,
  PROJECT_CONTEXT_CACHE_PATH, PROJECT_CONTEXT_CACHE_SCHEMA, PROJECT_CONTEXT_FRAGMENT_PATH,
  PROJECT_CONTEXT_LOCK_PATH, PROJECT_CONTEXT_LOCK_STALE_MS, PROJECT_CONTEXT_MANAGED_COMMENT,
  PROJECT_CONTEXT_MANIFEST_PATH, PROJECT_CONTEXT_MAX_APPROX_TOKENS, PROJECT_CONTEXT_MAX_INPUT_BYTES,
  PROJECT_CONTEXT_MAX_RENDERED_BYTES, PROJECT_CONTEXT_MAX_WARNINGS, PROJECT_CONTEXT_SCHEMA,
  PROJECT_CONTEXT_SNAPSHOT_DIR, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES,
  ProjectContextError, ProjectContextHashRace, compareRevisions, computeProjectContextSourceHash,
  isRecord, isSafeSingleLine, parseProjectContextBundle, revisionKey, scanGeneratedContent,
  sha256, stableStringify,
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
import { readUtf8RegularFile, sessionTargetRelativePath } from "./project-context-runtime.js";

import { atomicWriteFile } from "./project-context-files.js";
import { ensureSafeDirectory } from "./project-context-lock.js";
export function buildCache(plan: ProjectContextPlan, now: Date): ProjectContextCache {
  return {
    schema: PROJECT_CONTEXT_CACHE_SCHEMA,
    cached_at: now.toISOString(),
    project_id: plan.bundle.project.id,
    revision: plan.bundle.revision,
    hash: plan.bundle.hash,
    bundle: plan.bundle,
  };
}

export function buildManifest(plan: ProjectContextPlan, now: Date): ProjectContextManifest {
  const tool = manifestTool(plan.runtime);
  const files: ProjectContextManifest["files"] = [
    {
      path: plan.fragment_path,
      relativePath: PROJECT_CONTEXT_FRAGMENT_PATH,
      role: "fragment",
      sha256: sha256(plan.fragment),
      sourceIds: ["project-context-bundle"],
    },
    {
      path: plan.target_path,
      relativePath: plan.target_relative_path,
      role: "index",
      sha256: sha256(plan.target_content),
      sourceIds: ["project-context-bundle"],
    },
  ];
  return {
    schema: SESSION_RENDER_SCHEMA,
    kind: "project-context",
    tool,
    adapterMode: plan.native_imports ? "native-import" : "managed-block",
    profile: "project-context",
    sessionId: null,
    targetHome: plan.workspace_root,
    targetKind: "project-root",
    targetOwner: {
      kind: "project",
      tool,
      profile: "project-context",
      targetHome: plan.workspace_root,
      projectRoot: plan.workspace_root,
      ownedBy: "open-configs",
      canonicalOwner: "instructions",
      reason: "project context is emitted by Projects and written exclusively by Instructions",
    },
    writable: true,
    blocked: false,
    blockers: [],
    generatedAt: now.toISOString(),
    env: {},
    sourceHash: plan.bundle.hash,
    sources: [manifestSource(plan)],
    skippedSources: [],
    files,
    warnings: plan.warnings,
    projectContext: manifestProjectContext(plan),
    compatibility: manifestCompatibility(),
  };
}

export function buildSessionCompatibilityManifest(plan: ProjectContextPlan, now: Date): Record<string, unknown> {
  const paths = runtimePaths(plan.workspace_root, plan.runtime);
  const tool = manifestTool(plan.runtime);
  const targetHome = plan.runtime === "codewith" ? resolve(plan.workspace_root, ".codewith") : plan.workspace_root;
  const targetRelativePath = sessionTargetRelativePath(plan.runtime);
  const existing = existsSync(paths.sessionManifest)
    ? readSessionManifestRecord(paths.sessionManifest, plan.workspace_root)
    : {
      schema: SESSION_RENDER_SCHEMA,
      tool,
      adapterMode: plan.native_imports ? "native-imports" : "flattened-markdown",
      profile: "project-context",
      sessionId: null,
      targetHome,
      targetKind: "session-home",
      targetOwner: {},
      env: {},
      sourceHash: null,
      sources: [],
      skippedSources: [],
      files: [],
      warnings: [],
    };
  if (!existing || existing["schema"] !== SESSION_RENDER_SCHEMA || (existing["tool"] !== undefined && existing["tool"] !== tool)) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session manifest is malformed or incompatible");
  }
  const existingTargetHome = safeLegacyMetadataString(existing["targetHome"], null);
  if (existingTargetHome !== null && resolve(existingTargetHome) !== targetHome) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session manifest targets a different workspace");
  }
  const sources = sanitizeLegacySources(existing["sources"])
    .filter((source) => source["id"] !== "project-context-bundle");
  sources.push(manifestSource(plan));
  const files = sanitizeLegacyFiles(existing["files"]);
  const targetIndexes = files.filter((file) => file["relativePath"] === targetRelativePath);
  if (targetIndexes.length > 1) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", `provider session manifest contains duplicate ${targetRelativePath} entries`);
  }
  const previousSourceIds = targetIndexes[0]?.["sourceIds"] as string[] | undefined;
  const updatedTarget = {
    path: plan.target_path,
    relativePath: targetRelativePath,
    role: "index",
    sha256: sha256(plan.target_content),
    sourceIds: [...new Set([...(previousSourceIds ?? []), "project-context-bundle"])],
  };
  const targetOwner = isRecord(existing["targetOwner"]) ? existing["targetOwner"] : {};
  const adapterMode = plan.native_imports ? "native-imports" : "flattened-markdown";
  return credentialSafeSessionManifest({
    schema: SESSION_RENDER_SCHEMA,
    tool,
    adapterMode,
    profile: safeLegacyMetadataString(existing["profile"], "project-context"),
    sessionId: existing["sessionId"] === null ? null : safeLegacyMetadataString(existing["sessionId"], null),
    targetHome,
    targetKind: existing["targetKind"] === "project-root" ? "project-root" : "session-home",
    targetOwner: {
      kind: targetOwner["kind"] === "project" ? "project" : "provider-profile",
      tool,
      profile: safeLegacyMetadataString(targetOwner["profile"], safeLegacyMetadataString(existing["profile"], "project-context")),
      targetHome,
      projectRoot: plan.workspace_root,
      ownedBy: "open-configs",
      canonicalOwner: "instructions",
      reason: "provider session manifest retained for additive Instructions project-context compatibility",
    },
    writable: true,
    blocked: false,
    blockers: [],
    generatedAt: now.toISOString(),
    env: sanitizeLegacyEnvironment(existing["env"]),
    sourceHash: sha256(stableStringify({ previous: typeof existing["sourceHash"] === "string" ? existing["sourceHash"] : null, projectContext: plan.bundle.hash })),
    sources,
    skippedSources: sanitizeLegacySkippedSources(existing["skippedSources"]),
    files: [...files.filter((file) => file["relativePath"] !== targetRelativePath), updatedTarget],
    warnings: [...new Set([...sanitizeLegacyWarnings(existing["warnings"]), ...plan.warnings])].slice(0, 64),
    projectContext: manifestProjectContext(plan),
    compatibility: manifestCompatibility(),
  });
}

export function credentialSafeSessionManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(manifest, null, 2);
  if (
    scanSecrets(encoded, "json").length > 0 ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]|https?:\/\//i.test(encoded)
  ) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_MANIFEST_INVALID",
      "provider session manifest contains credential-like metadata",
    );
  }
  return manifest;
}

export function sanitizeLegacySources(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !isRecord(entry))) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source inventory is malformed");
  }
  return value.map((entry, index) => {
    const source = entry as Record<string, unknown>;
    const id = safeLegacyMetadataString(source["id"], `legacy-source-${index}`);
    const layer = typeof source["layer"] === "string" && SESSION_INSTRUCTION_LAYERS.includes(source["layer"] as typeof SESSION_INSTRUCTION_LAYERS[number])
      ? source["layer"]
      : "local";
    const merge = source["merge"] === "replace" ? "replace" : "append";
    const owner = isRecord(source["owner"])
      ? {
        kind: safeLegacyMetadataString(source["owner"]["kind"], "unknown"),
        id: safeLegacyMetadataString(source["owner"]["id"], id),
      }
      : null;
    const sourcePaths = Array.isArray(source["sourcePaths"])
      ? source["sourcePaths"].slice(0, 64).filter(isRecord).map((item) => ({
        path: safeLegacyMetadataString(item["path"], "unknown"),
        ...(typeof item["editable"] === "boolean" ? { editable: item["editable"] } : {}),
        ...(typeof item["required"] === "boolean" ? { required: item["required"] } : {}),
        ...(typeof item["hash"] === "string" ? { hash: safeLegacyMetadataString(item["hash"], "") } : {}),
      }))
      : [];
    const rules = Array.isArray(source["rules"])
      ? source["rules"].slice(0, 64).filter(isRecord).map((rule, ruleIndex) => ({
        id: safeLegacyMetadataString(rule["id"], `${id}-rule-${ruleIndex}`),
        label: safeLegacyMetadataString(rule["label"], `${id} rule ${ruleIndex + 1}`),
        path: safeLegacyMetadataString(rule["path"], "unknown"),
        globs: safeLegacyStringArray(rule["globs"], 64),
        hash: typeof rule["hash"] === "string" ? safeLegacyMetadataString(rule["hash"], null) : null,
      }))
      : [];
    return {
      id,
      label: safeLegacyMetadataString(source["label"], id),
      layer,
      merge,
      order: Number.isSafeInteger(source["order"]) ? Number(source["order"]) : index,
      path: typeof source["path"] === "string" ? safeLegacyMetadataString(source["path"], null) : null,
      targetProviders: safeLegacyStringArray(source["targetProviders"], 16),
      owner,
      sourcePaths,
      hash: typeof source["hash"] === "string" ? safeLegacyMetadataString(source["hash"], null) : null,
      nonOverridable: source["nonOverridable"] === true,
      replacementScope: typeof source["replacementScope"] === "string" ? safeLegacyMetadataString(source["replacementScope"], null) : null,
      rules,
      provenance: sanitizeLegacyProvenance(source["provenance"]),
    };
  });
}

export function sanitizeLegacyEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 8) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session environment metadata is malformed");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof item !== "string" || !isAbsolute(item) || !isSafeSingleLine(item) || item.length > 4_096) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session environment metadata contains an unsafe entry");
    }
    if (scanSecrets(`${key}=${item}`, "text").length > 0) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session environment metadata contains credential-like content");
    }
    result[key] = item;
  }
  return result;
}

export function sanitizeLegacyWarnings(value: unknown): string[] {
  return safeLegacyStringArray(value, 64);
}

export function sanitizeLegacyProvenance(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance is malformed");
  }
  const state = { nodes: 0 };
  const sanitized = sanitizeBoundedJsonMetadata(value, 0, state);
  if (!isRecord(sanitized)) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance is malformed");
  }
  const encoded = JSON.stringify(sanitized);
  if (Buffer.byteLength(encoded, "utf8") > PROJECT_CONTEXT_MAX_INPUT_BYTES || scanSecrets(encoded, "text").length > 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance exceeds its bound or contains credential-like content");
  }
  return sanitized;
}

export function sanitizeBoundedJsonMetadata(value: unknown, depth: number, state: { nodes: number }): unknown {
  state.nodes++;
  if (state.nodes > 128 || depth > 6) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance exceeds its structural bound");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an invalid number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 4_096 || !isSafeSingleLine(value)) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an unsafe string");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an oversized array");
    return value.map((item) => sanitizeBoundedJsonMetadata(item, depth + 1, state));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 64) throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an oversized object");
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (key.length === 0 || key.length > 256 || !isSafeSingleLine(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an unsafe key");
      }
      result[key] = sanitizeBoundedJsonMetadata(item, depth + 1, state);
    }
    return result;
  }
  throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session source provenance contains an unsupported value");
}

export function sanitizeLegacyFiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !isRecord(entry))) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session file inventory is malformed");
  }
  return value.map((entry) => {
    const file = entry as Record<string, unknown>;
    const relativePath = safeLegacyMetadataString(file["relativePath"], "");
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("/../")) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session file inventory contains an unsafe relative path");
    }
    const sha = safeLegacyMetadataString(file["sha256"], "");
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session file inventory contains an invalid hash");
    }
    const role = typeof file["role"] === "string" && ["index", "fragment", "rule", "config", "manifest"].includes(file["role"])
      ? file["role"]
      : "index";
    return {
      path: safeLegacyMetadataString(file["path"], ""),
      relativePath,
      role,
      sha256: sha,
      sourceIds: safeLegacyStringArray(file["sourceIds"], 64),
    };
  });
}

export function sanitizeLegacySkippedSources(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).filter(isRecord).map((entry, index) => ({
    id: safeLegacyMetadataString(entry["id"], `skipped-${index}`),
    label: safeLegacyMetadataString(entry["label"], `Skipped source ${index + 1}`),
    targetProviders: safeLegacyStringArray(entry["targetProviders"], 16),
    reason: safeLegacyMetadataString(entry["reason"], "unknown"),
  }));
}

export function safeLegacyStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "provider session manifest contains malformed string metadata");
  }
  return value
    .map((item) => safeLegacyMetadataString(item, ""))
    .filter((item): item is string => item.length > 0);
}

export function safeLegacyMetadataString(value: unknown, fallback: string): string;
export function safeLegacyMetadataString(value: unknown, fallback: null): string | null;
export function safeLegacyMetadataString(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !isSafeSingleLine(value)) return fallback;
  return value;
}

export function manifestSource(plan: ProjectContextPlan): ProjectContextManifest["sources"][number] {
  return projectContextManifestSource(plan.cache_path, plan.runtime, plan.bundle);
}

export function projectContextManifestSource(
  cachePath: string,
  runtime: ProjectContextRuntime,
  bundle: ProjectContextBundleV1,
): ProjectContextManifest["sources"][number] {
  return {
    id: "project-context-bundle",
    label: "Project Context Bundle",
    layer: "repo",
    merge: "replace",
    order: 0,
    path: cachePath,
    targetProviders: [manifestTool(runtime)],
    owner: { kind: "package", id: "@hasna/projects" },
    sourcePaths: [],
    hash: bundle.hash,
    nonOverridable: true,
    replacementScope: "project-context",
    rules: [],
    renderedPayloadSha256: sha256(JSON.stringify(bundle)),
    provenance: {
      schema: PROJECT_CONTEXT_SCHEMA,
      projectId: bundle.project.id,
      revision: bundle.revision,
      hash: bundle.hash,
    },
  };
}

export function manifestProjectContext(plan: ProjectContextPlan): ProjectContextManifest["projectContext"] {
  return {
    schema: PROJECT_CONTEXT_SCHEMA,
    projectId: plan.bundle.project.id,
    revision: plan.bundle.revision,
    hash: plan.bundle.hash,
    status: plan.status,
    ageSeconds: plan.age_seconds,
    cachePath: plan.cache_path,
    fragmentPath: plan.fragment_path,
  };
}

export function manifestCompatibility(): ProjectContextManifest["compatibility"] {
  return {
    legacyPackage: LEGACY_CONFIGS_PACKAGE,
    legacyVersion: LEGACY_CONFIGS_COMPAT_VERSION,
    legacyExecutable: LEGACY_CONFIGS_EXECUTABLE,
    manifestSchema: SESSION_RENDER_SCHEMA,
    managedBy: "@hasna/configs",
    ownedBy: "open-configs",
    canonicalOwner: "instructions",
  };
}

export function writeMetadataSnapshot(plan: ProjectContextPlan, now: Date): string | null {
  const previous = readProjectContextManifest(plan.manifest_path, plan.workspace_root);
  if (!previous || (previous.projectContext.revision === plan.bundle.revision && previous.projectContext.hash === plan.bundle.hash)) return null;
  const snapshotDir = resolve(plan.workspace_root, ...PROJECT_CONTEXT_SNAPSHOT_DIR.split("/"));
  ensureSafeDirectory(snapshotDir, plan.workspace_root, 0o700);
  const snapshotPath = resolve(snapshotDir, `${safeFilename(previous.projectContext.revision)}-${previous.projectContext.hash.slice(-12)}.json`);
  const snapshot = {
    schema: "hasna.configs.session-render-snapshot/v1",
    kind: "project-context-metadata",
    createdAt: now.toISOString(),
    projectId: previous.projectContext.projectId,
    revision: previous.projectContext.revision,
    hash: previous.projectContext.hash,
    status: previous.projectContext.status,
    files: previous.files.map((file) => ({ relativePath: file.relativePath, role: file.role, sha256: file.sha256 })),
  };
  atomicWriteFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, plan.workspace_root, 0o600);
  return snapshotPath;
}

export function readProjectContextManifest(path: string, workspaceRoot: string): ProjectContextManifestObservation | null {
  if (!existsSync(path)) return null;
  const record = readJsonRecord(path, workspaceRoot);
  const result = storedManifestObservationSchema.safeParse(record);
  if (!result.success) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "existing project-context manifest is malformed");
  }
  return {
    tool: result.data.tool,
    adapterMode: result.data.adapterMode,
    projectContext: result.data.projectContext,
    files: result.data.files,
  };
}

export function readProjectContextCache(path: string, workspaceRoot: string): ProjectContextCache | null {
  if (!existsSync(path)) return null;
  const record = readJsonRecord(path, workspaceRoot);
  const result = projectContextCacheSchema.safeParse(record);
  if (!result.success) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", "cache is malformed or incompatible");
  }
  const bundle = parseProjectContextBundle(result.data.bundle);
  if (
    result.data.project_id !== bundle.project.id ||
    result.data.revision !== bundle.revision ||
    result.data.hash !== bundle.hash
  ) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", "cache metadata does not match its bundle");
  }
  return { ...result.data, bundle };
}

export function readJsonRecord(path: string, workspaceRoot: string): Record<string, unknown> | null {
  const content = readUtf8RegularFile(path, workspaceRoot, PROJECT_CONTEXT_MAX_INPUT_BYTES * 4);
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readSessionManifestRecord(path: string, workspaceRoot: string): Record<string, unknown> | null {
  const content = readUtf8RegularFile(path, workspaceRoot, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES);
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
