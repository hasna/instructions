import { existsSync } from "node:fs";
import { posix } from "node:path";
import {
  composeProjectContextSessionRender, observeProjectContextSessionGuard,
} from "./project-context.js";
import {
  ANTIGRAVITY_RULE_FILE_CHAR_LIMIT, CODEWITH_FLATTENED_ADAPTER,
  CODEWITH_NATIVE_ADAPTER, CODEWITH_NATIVE_IMPORTS_ENV, RAW_STORE_ROOT_ENV,
  SESSION_LAYER_RANK, SESSION_RENDERER_OWNER_ID, SESSION_RENDER_MANAGED_MARKER,
  SESSION_RENDER_SCHEMA, SESSION_RENDER_TOOLS, SESSION_TOOL_ADAPTERS,
  normalizeSessionInstructionLayer, type IdentityExportShape,
  type OrderedSessionInstructionRule, type OrderedSessionInstructionSource,
  type SessionInstructionLayer, type SessionInstructionMerge, type SessionInstructionOwner,
  type SessionInstructionRule, type SessionInstructionSource, type SessionInstructionSourcePath,
  type SessionProfileRenderSelection, type SessionProviderConfig, type SessionRenderFile,
  type SessionRenderFileRole, type SessionRenderInput, type SessionRenderManifest,
  type SessionRenderMode, type SessionRenderPlan, type SessionRenderTargetKind,
  type SessionRenderTool, type SessionSkippedSource, type SessionTargetOwner,
  type SessionToolAdapter,
} from "./session-render-model.js";

import {
  buildFiles, composeSources, fingerprint, makeFile, normalizeSources,
  rejectDuplicateRenderPaths, sha256, sourceFingerprint,
} from "./session-render-content.js";
import { joinTarget } from "./session-render-paths.js";
import { adapterFor, resolveRenderTarget, resolveSessionTargetOwnership } from "./session-render-target.js";

export function planSessionRender(input: SessionRenderInput): SessionRenderPlan {
  if (!SESSION_RENDER_TOOLS.includes(input.tool)) throw new Error(`Unsupported session render tool: ${input.tool}`);
  if (!input.profile.trim()) throw new Error("Session render profile is required.");

  const adapter = adapterFor(input);
  const { targetHome, targetKind, blockers } = resolveRenderTarget(input);
  const targetOwner = resolveSessionTargetOwnership(input, { targetHome, targetKind });
  const blocked = blockers.length > 0;
  const allowEmptySources = input.allowEmptySources === true;
  const orderedSources = composeSources(normalizeSources(input.sources, input.tool, allowEmptySources));
  if (orderedSources.length === 0 && !allowEmptySources) {
    throw new Error("Session render has no instruction sources. Pass --allow-empty-sources only for explicit empty renders.");
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const env = adapter.envVar && !blocked ? { [adapter.envVar]: targetHome } : {};
  const warnings = [
    ...(orderedSources.length === 0 ? ["No instruction sources were provided."] : []),
    ...blockers,
  ];
  if (input.providerConfig && input.tool !== "opencode") {
    throw new Error("Provider base config is supported only for OpenCode session renders.");
  }
  const baseFiles = blocked ? [] : buildFiles(targetHome, adapter, input.profile, orderedSources, input.providerConfig);
  const projectContext = blocked
    ? null
    : composeProjectContextSessionRender({
      tool: input.tool,
      adapter_mode: adapter.mode,
      target_home: targetHome,
      project_root: input.projectRoot,
      files: baseFiles,
    });
  const projectContextGuard = blocked
    ? null
    : projectContext?.guard ?? observeProjectContextSessionGuard({
      tool: input.tool,
      target_home: targetHome,
      project_root: input.projectRoot,
    });
  if (projectContext && orderedSources.some((source) => source.id === projectContext.source.id)) {
    throw new Error(`Session source ${projectContext.source.id} is reserved for the durable Instructions project-context renderer.`);
  }
  const files = projectContext?.files ?? baseFiles;
  rejectDuplicateRenderPaths(files);

  const manifest: SessionRenderManifest = {
    schema: SESSION_RENDER_SCHEMA,
    tool: input.tool,
    adapterMode: adapter.mode,
    profile: input.profile,
    sessionId: input.sessionId ?? null,
    targetHome,
    targetKind,
    targetOwner,
    writable: !blocked,
    blocked,
    blockers,
    generatedAt,
    env,
    sourceHash: fingerprint(projectContext
      ? {
        sources: orderedSources.map(sourceFingerprint),
        providerConfig: input.providerConfig
          ? { sourceId: input.providerConfig.sourceId, content: input.providerConfig.content }
          : null,
        projectContext: projectContext.project_context,
      }
      : {
        sources: orderedSources.map(sourceFingerprint),
        providerConfig: input.providerConfig
          ? { sourceId: input.providerConfig.sourceId, content: input.providerConfig.content }
          : null,
      }),
    sources: [
      ...orderedSources.map((source) => ({
        id: source.id,
        label: source.resolvedLabel,
        layer: source.resolvedLayer,
        merge: source.resolvedMerge,
        order: source.resolvedOrder,
        path: source.path ?? null,
        targetProviders: source.targetProviders ?? [],
        owner: source.owner ?? null,
        sourcePaths: source.sourcePaths ?? [],
        hash: source.hash ?? null,
        nonOverridable: source.nonOverridable === true,
        replacementScope: source.replacementScope ?? null,
        rules: source.resolvedRules.map((rule) => ({
          id: rule.id,
          label: rule.resolvedLabel,
          path: rule.resolvedPath,
          globs: rule.globs ?? [],
          hash: rule.hash ?? null,
        })),
        renderedPayloadSha256: sha256(source.content),
        provenance: source.provenance ?? null,
        metadata: source.metadata ?? null,
      })),
      ...(projectContext ? [projectContext.source] : []),
    ],
    skippedSources: input.skippedSources ?? [],
    files: files.map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      role: file.role,
      sha256: file.sha256,
      sourceIds: file.sourceIds,
    })),
    warnings,
    ...(input.providerConfig
      ? {
        providerConfig: {
          sourceId: input.providerConfig.sourceId,
          selectedPayloadSha256: sha256(input.providerConfig.content),
          renderedPayloadSha256: files.find((file) => file.relativePath === adapter.configFile)?.sha256
            ?? sha256(input.providerConfig.content),
          selected: !existsSync(joinTarget(targetHome, adapter.configFile!)),
        },
      }
      : {}),
    ...(projectContext
      ? {
        projectContext: projectContext.project_context,
        compatibility: projectContext.compatibility,
      }
      : {}),
  };
  const manifestFile = makeFile(
    targetHome,
    posix.join(".hasna", "session-render-manifest.json"),
    "manifest",
    JSON.stringify(manifest, null, 2),
    orderedSources.map((source) => source.id),
  );

  return {
    dryRun: true,
    tool: input.tool,
    adapter,
    profile: input.profile,
    sessionId: input.sessionId ?? null,
    targetHome,
    targetKind,
    targetOwner,
    writable: !blocked,
    blocked,
    blockers,
    env,
    files,
    manifest,
    manifestFile,
    allFiles: [...files, manifestFile],
    warnings,
    ...(projectContextGuard ? { projectContextGuard } : {}),
  };
}

