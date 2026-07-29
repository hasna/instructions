import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, posix, relative, resolve } from "node:path";
import type { Config } from "../types/index.js";
import {
  GLOBAL_AGENT_RULES_STANDARD_SLUG, resolveAgentOperatingRulesPayload,
} from "./global-agent-rules-standard.js";
import { isRetiredOrUnsupportedConfigAgent } from "./config-agents.js";
import { applyTransform } from "./transforms.js";
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

import { ensureTrailingNewline, filterProviderOnlyBlocks, sha256 } from "./session-render-content.js";
import { cleanSessionPathInput, resolveSessionPath, slug } from "./session-render-paths.js";

export function sourceFromFilePath(path: string, content: string, order = 0): SessionInstructionSource {
  const file = basename(path);
  return {
    id: file.replace(extname(file), ""),
    label: file,
    content,
    layer: "agent",
    order,
    path,
  };
}

export function sourceFromConfig(
  config: Pick<Config, "slug" | "name" | "content" | "agent" | "target_path">,
  order = 0,
  layer?: SessionInstructionLayer,
): SessionInstructionSource {
  const isAgentOperatingRules = config.slug === GLOBAL_AGENT_RULES_STANDARD_SLUG;
  // Stored content is authoritative once it declares a current rules version; the
  // embedded baseline only backstops an empty, unversioned, or strictly older record.
  const rules = isAgentOperatingRules ? resolveAgentOperatingRulesPayload(config.content) : null;
  return {
    id: config.slug,
    label: config.name,
    content: rules ? rules.content : config.content,
    layer: layer ?? (config.agent === "global" ? "global" : "agent"),
    order,
    path: config.target_path ?? undefined,
    provenance: rules
      ? {
        ...rules.provenance,
        configSlug: config.slug,
        configAgent: config.agent,
      }
      : {
        source: "open-configs",
        configSlug: config.slug,
        configAgent: config.agent,
      },
    metadata: rules ? { ...rules.metadata } : null,
    nonOverridable: isAgentOperatingRules,
  };
}

export function selectProfileConfigsForSessionRender(
  configs: Config[],
  tool: SessionRenderTool,
): SessionProfileRenderSelection {
  const sources: Array<{ config: Config; source: SessionInstructionSource }> = [];
  const skippedSources: SessionSkippedSource[] = [];
  const providerConfigs: Config[] = [];

  for (const config of configs) {
    if (isRetiredOrUnsupportedConfigAgent(config.agent)) {
      skippedSources.push(skippedProfileConfig(config, [], "retired or unsupported provider config"));
      continue;
    }
    if (isOpenCodeProviderConfig(config)) {
      if (tool === "opencode") providerConfigs.push(config);
      else skippedSources.push(skippedProfileConfig(config, ["opencode"], "provider settings belong to OpenCode"));
      continue;
    }
    if (config.category !== "rules") {
      skippedSources.push(skippedProfileConfig(
        config,
        [],
        config.kind === "reference"
          ? "reference config is not a provider instruction source"
          : "profile config is handled by direct config preview/apply",
      ));
      continue;
    }

    const output = config.outputs.find((candidate) => candidate.agent === tool);
    if (config.agent !== "global" && config.agent !== tool && !output) {
      skippedSources.push(skippedProfileConfig(config, [config.agent], "rule targets a different provider"));
      continue;
    }
    const selectedContent = output
      ? applyTransform(config, output, { configs })
      : config.content;
    sources.push({
      config,
      source: sourceFromConfig({ ...config, content: selectedContent }, sources.length),
    });
  }

  const selectedSources: SessionInstructionSource[] = [];
  const equivalentSources = new Map<string, {
    config: Config;
    index: number;
    nonOverridable: boolean;
  }>();
  for (const candidate of sources) {
    const key = sha256(candidate.source.content);
    const existing = equivalentSources.get(key);
    if (!existing) {
      equivalentSources.set(key, {
        config: candidate.config,
        index: selectedSources.length,
        nonOverridable: candidate.source.nonOverridable === true,
      });
      selectedSources.push(candidate.source);
      continue;
    }
    const candidateIsNonOverridable = candidate.source.nonOverridable === true;
    const replaceExisting = candidateIsNonOverridable !== existing.nonOverridable
      ? candidateIsNonOverridable
      : candidate.config.updated_at > existing.config.updated_at;
    if (replaceExisting) {
      skippedSources.push(skippedProfileConfig(existing.config, [tool], `equivalent rule superseded by ${candidate.config.slug}`));
      selectedSources[existing.index] = {
        ...candidate.source,
        order: selectedSources[existing.index]!.order,
      };
      equivalentSources.set(key, {
        config: candidate.config,
        index: existing.index,
        nonOverridable: candidateIsNonOverridable,
      });
    } else {
      skippedSources.push(skippedProfileConfig(candidate.config, [tool], `equivalent rule superseded by ${existing.config.slug}`));
    }
  }

  const providerConfig = selectProviderConfig(providerConfigs, skippedSources);
  return {
    sources: selectedSources,
    skippedSources,
    ...(providerConfig ? { providerConfig } : {}),
  };
}

export function skippedProfileConfig(
  config: Config,
  targetProviders: string[],
  reason: string,
): SessionSkippedSource {
  return {
    id: config.slug,
    label: config.name,
    targetProviders,
    reason,
  };
}

export function isOpenCodeProviderConfig(config: Config): boolean {
  return config.kind === "file"
    && config.agent === "opencode"
    && config.format === "json"
    && basename(config.target_path ?? "") === "opencode.json";
}

export function selectProviderConfig(
  configs: Config[],
  skippedSources: SessionSkippedSource[],
): SessionProviderConfig | undefined {
  if (configs.length === 0) return undefined;
  const selected = [...configs].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || left.slug.localeCompare(right.slug)
  )[0]!;
  for (const config of configs) {
    if (config.id === selected.id) continue;
    if (config.content !== selected.content) {
      throw new Error(`Conflicting OpenCode provider configs in profile: ${selected.slug}, ${config.slug}`);
    }
    skippedSources.push(skippedProfileConfig(config, ["opencode"], `equivalent provider config superseded by ${selected.slug}`));
  }
  return {
    sourceId: selected.slug,
    content: selected.content,
  };
}

export function sourcesFromIdentityExport(
  value: unknown,
  options: { path?: string; tool?: SessionRenderTool; orderOffset?: number } = {},
): SessionInstructionSource[] {
  const record = asRecord(value, "identity instruction export");
  const shape = requireIdentityExportShape(record);
  const validation = asOptionalRecord(record["validation"]);
  if (validation && validation["valid"] === false) {
    const issues = Array.isArray(validation["issues"]) ? validation["issues"] : [];
    throw new Error(`Identity instruction export is invalid: ${JSON.stringify(issues)}`);
  }
  const sources = record["sources"];
  if (!Array.isArray(sources)) throw new Error("Identity instruction export sources must be an array.");
  const offset = options.orderOffset ?? 0;
  return sources
    .map((item, index) => identitySourceToSessionSource(item, {
      path: options.path,
      tool: options.tool,
      orderFallback: offset + index,
      exportShape: shape,
    }))
    .filter((source): source is SessionInstructionSource => source !== null);
}

export function requireIdentityExportShape(record: Record<string, unknown>): IdentityExportShape {
  if (record["contract"] === "hasna.identities.configs-instructions/v1") return "configs-contract";
  if (record["version"] === 1 && record["package"] === "@hasna/identities") return "canonical-open-identities";
  throw new Error("Unsupported identity instruction export contract.");
}


export function identitySourceToSessionSource(
  value: unknown,
  options: { path?: string; tool?: SessionRenderTool; orderFallback: number; exportShape: IdentityExportShape },
): SessionInstructionSource | null {
  const record = asRecord(value, "identity instruction source");
  const providers = asStringArray(record["targetProviders"]);
  if (options.tool && providers.length > 0 && !providerTargetsTool(providers, options.tool)) return null;
  const sourcePaths = normalizeSourcePaths(record["sourcePaths"]);
  const kind = maybeString(record["kind"]);
  const layer = record["layer"] === undefined ? layerFromIdentityKind(kind, options.exportShape) : requireLayer(record["layer"]);
  const merge = requireMerge(record["merge"] ?? record["mergePolicy"] ?? "append");
  const id = requireString(record["id"], "identity instruction source id");
  const inlineContent = maybeString(record["content"]);
  const resolvedContent = inlineContent && inlineContent.trim()
    ? inlineContent
    : contentFromIdentitySourcePaths(sourcePaths, options.path, id) ?? inlineContent;
  return {
    id,
    label: maybeString(record["label"]) ?? maybeString(record["title"]) ?? id,
    layer,
    merge,
    order: typeof record["order"] === "number"
      ? record["order"]
      : typeof record["precedence"] === "number"
        ? record["precedence"]
        : options.orderFallback,
    content: resolvedContent ?? "",
    // The export location is a transport used only to resolve sourcePaths.
    // Canonical provenance lives in the export itself, so persisted files and
    // stdin must produce byte-identical plans.
    path: undefined,
    rules: normalizeIdentityRules(record["rules"]),
    provenance: asOptionalRecord(record["provenance"]) ?? null,
    targetProviders: providers,
    owner: normalizeIdentityOwner(record["owner"]),
    sourcePaths,
    globs: asStringArray(record["globs"]),
    hash: maybeString(record["hash"]),
    nonOverridable: record["nonOverridable"] === true,
    replacementScope: maybeString(record["replacementScope"]),
    metadata: asOptionalRecord(record["metadata"]) ?? null,
  };
}

export function layerFromIdentityKind(kind: string | undefined, exportShape: IdentityExportShape): SessionInstructionLayer {
  if (!kind) {
    if (exportShape === "configs-contract") throw new Error("Invalid session instruction layer: undefined");
    return "agent";
  }
  switch (kind) {
    case "global-rules":
    case "global-system-prompt":
      return "global";
    case "provider-rules":
    case "provider-system-prompt":
      return "tool";
    case "identity-doc":
    case "persona-doc":
      return "agent";
    case "account-overlay":
      return "account";
    case "project-overlay":
      return "repo";
    case "machine-overlay":
      return "machine";
    case "session-overlay":
      return "session";
    default:
      throw new Error(`Invalid identity instruction source kind: ${kind}`);
  }
}

export function contentFromIdentitySourcePaths(
  sourcePaths: SessionInstructionSourcePath[],
  exportPath: string | undefined,
  sourceId: string,
): string | undefined {
  if (sourcePaths.length === 0 || !exportPath) return undefined;
  const baseDir = dirname(resolveSessionPath(exportPath));
  const contents: Array<{ path: string; content: string }> = [];
  for (const sourcePath of sourcePaths) {
    const content = readIdentitySourcePath(sourcePath, baseDir, sourceId);
    if (content !== undefined) contents.push({ path: sourcePath.path, content });
  }
  if (contents.length === 0) return undefined;
  if (contents.length === 1) return ensureTrailingNewline(contents[0]!.content);
  return ensureTrailingNewline(contents.map((item) => `<!-- Source path: ${item.path} -->\n${item.content.trimEnd()}`).join("\n\n"));
}

export function readIdentitySourcePath(
  sourcePath: SessionInstructionSourcePath,
  baseDir: string,
  sourceId: string,
): string | undefined {
  const resolvedPath = resolveIdentitySourcePath(sourcePath.path, baseDir, sourceId);
  if (!existsSync(resolvedPath)) {
    if (sourcePath.required) {
      throw new Error(`Required identity instruction source path not found for ${sourceId}: ${sourcePath.path}`);
    }
    return undefined;
  }
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Identity instruction source path is not a file for ${sourceId}: ${sourcePath.path}`);
  }
  const realBase = realpathSync(baseDir);
  const realPath = realpathSync(resolvedPath);
  if (!pathIsInside(realPath, realBase)) {
    throw new Error(`Identity instruction source path escapes export directory for ${sourceId}: ${sourcePath.path}`);
  }
  return readFileSync(realPath, "utf-8");
}

export function resolveIdentitySourcePath(path: string, baseDir: string, sourceId: string): string {
  const cleaned = cleanSessionPathInput(path);
  if (!cleaned) throw new Error(`Identity instruction source path cannot be empty for ${sourceId}.`);
  if (cleaned.includes("\\")) throw new Error(`Identity instruction source path must use POSIX separators for ${sourceId}: ${path}`);
  const resolvedPath = isAbsolute(cleaned) ? resolve(cleaned) : resolve(baseDir, cleaned);
  if (!pathIsInside(resolvedPath, resolve(baseDir))) {
    throw new Error(`Identity instruction source path escapes export directory for ${sourceId}: ${path}`);
  }
  return resolvedPath;
}

export function pathIsInside(path: string, baseDir: string): boolean {
  const rel = relative(baseDir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function providerTargetsTool(targets: string[], tool: SessionRenderTool): boolean {
  return targets.map((target) => target.toLowerCase()).some((target) => target === tool || target === "all" || target === "generic");
}

export function normalizeIdentityRules(value: unknown): SessionInstructionRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Identity instruction source rules must be an array.");
  return value.map((item) => {
    const record = asRecord(item, "identity instruction rule");
    const id = requireString(record["id"], "identity instruction rule id");
    return {
      id,
      label: maybeString(record["label"]) ?? id,
      path: maybeString(record["path"]),
      content: maybeString(record["content"]) ?? "",
      globs: asStringArray(record["globs"]),
      hash: maybeString(record["hash"]),
      metadata: asOptionalRecord(record["metadata"]) ?? null,
    };
  });
}

export function normalizeIdentityOwner(value: unknown): SessionInstructionOwner | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, "identity instruction owner");
  return {
    kind: requireString(record["kind"], "identity instruction owner kind"),
    id: requireString(record["id"], "identity instruction owner id"),
  };
}

export function normalizeSourcePaths(value: unknown): SessionInstructionSourcePath[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Identity instruction source paths must be an array.");
  return value.map((item) => {
    const record = asRecord(item, "identity instruction source path");
    return {
      path: requireString(record["path"], "identity instruction source path"),
      editable: record["editable"] === true,
      required: record["required"] === true,
      hash: maybeString(record["hash"]),
    };
  });
}

export function requireLayer(value: unknown): SessionInstructionLayer {
  return normalizeSessionInstructionLayer(value);
}

export function requireMerge(value: unknown): SessionInstructionMerge {
  if (value === "append" || value === "replace") return value;
  throw new Error(`Invalid session instruction merge policy: ${String(value)}`);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

export function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return asRecord(value, "record");
}

export function maybeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}.`);
  return value;
}

export function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
