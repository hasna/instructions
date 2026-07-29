import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import {
  AGENT_OPERATING_RULES_HEADING_PATTERN, AGENT_OPERATING_RULES_ROLE,
  AGENT_OPERATING_RULES_SEMANTIC_POLICY_KEY, AGENT_OPERATING_RULES_SENTINEL_PATTERN,
  AGENT_OPERATING_RULES_SOURCE_ID, GLOBAL_AGENT_RULES_STANDARD_SLUG,
  compareAgentOperatingRulesVersions, parseAgentOperatingRulesVersion,
  resolveAgentOperatingRulesPayload,
} from "./global-agent-rules-standard.js";
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

import { assertSafeRelativePath, assertSafeTargetRoot, joinTarget, slug } from "./session-render-paths.js";

export function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function canonicalFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalFingerprintValue(entry)]),
    );
  }
  return value;
}

export function sourceFingerprint(source: OrderedSessionInstructionSource): Record<string, unknown> {
  return {
    id: source.id,
    label: source.resolvedLabel,
    layer: source.resolvedLayer,
    order: source.resolvedOrder,
    merge: source.resolvedMerge,
    content: source.content,
    path: source.path ?? null,
    targetProviders: source.targetProviders ?? [],
    owner: canonicalFingerprintValue(source.owner ?? null),
    sourcePaths: canonicalFingerprintValue(source.sourcePaths ?? []),
    globs: source.globs ?? [],
    hash: source.hash ?? null,
    nonOverridable: source.nonOverridable === true,
    replacementScope: source.replacementScope ?? null,
    rules: source.resolvedRules.map((rule) => ({
      id: rule.id,
      label: rule.resolvedLabel,
      path: rule.resolvedPath,
      content: rule.content,
      globs: rule.globs ?? [],
      hash: rule.hash ?? null,
      metadata: canonicalFingerprintValue(rule.metadata ?? null),
    })),
    provenance: canonicalFingerprintValue(source.provenance ?? null),
    metadata: canonicalFingerprintValue(source.metadata ?? null),
  };
}


export function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}


export function makeFile(
  targetHome: string,
  relativePath: string,
  role: SessionRenderFileRole,
  content: string,
  sourceIds: string[],
): SessionRenderFile {
  const safeTargetHome = assertSafeTargetRoot(targetHome);
  const safeRelativePath = assertSafeRelativePath(relativePath);
  const normalizedContent = ensureTrailingNewline(content);
  return {
    path: joinTarget(safeTargetHome, safeRelativePath),
    relativePath: safeRelativePath,
    role,
    content: normalizedContent,
    sha256: sha256(normalizedContent),
    sourceIds,
  };
}

/**
 * Applies the agent-operating-rules currency floor to any source that declares itself to
 * be that policy, whatever route it arrived by.
 *
 * The floor used to live in `sourceFromConfig` alone, which covered the config store and
 * nothing else. An identity export reaches the renderer through
 * `sourcesFromIdentityExport`, carries its own `nonOverridable` flag, and never touched
 * the floor — so an export could render rules BELOW the embedded baseline, or keep the
 * baseline sentinel over a rewritten body, and still be stamped non-overridable. Running
 * the floor here instead means every source declaring the sentinel is checked once, at
 * the point where all routes converge and before deduplication picks a winner.
 *
 * A substitution is recorded rather than performed silently: the attestation keeps the
 * version and digest that were rejected, so a repaired payload is visible in the manifest
 * as an event instead of looking like a clean render.
 */
/**
 * Whether a source is CLAIMING to be the agent operating rules, as opposed to merely
 * quoting them.
 *
 * The floor replaces a whole body, so applying it on a bare sentinel match destroyed any
 * composite document that embedded the rules alongside its own content — including this
 * renderer's own flattened output, which carries the sentinel plus every other source's
 * text and can be re-ingested as a `--source`. Two claims are recognised, and each is one
 * an attacker gains nothing by dropping:
 *
 * - PRIVILEGE OR IDENTITY: the source asks to be treated as the managed policy
 *   (`nonOverridable`, the managed slug or source id, or the agent-operating-rules role).
 *   These are exactly the markers that let a source tie on priority and win on version in
 *   `deduplicateSemanticPolicySources`, so a payload that drops them to escape the floor
 *   also drops its ability to displace the genuine rules.
 * - WHOLE-DOCUMENT PRESENTATION: the body OPENS with the canonical rules heading, i.e. it
 *   presents itself as the rules document rather than a file that quotes them.
 */
export function claimsAgentOperatingRulesPolicy(source: SessionInstructionSource, content: string): boolean {
  if (!AGENT_OPERATING_RULES_SENTINEL_PATTERN.test(content)) return false;
  if (source.nonOverridable === true) return true;
  if (source.id === GLOBAL_AGENT_RULES_STANDARD_SLUG || source.id === AGENT_OPERATING_RULES_SOURCE_ID) return true;
  if (source.metadata?.["role"] === AGENT_OPERATING_RULES_ROLE) return true;
  return AGENT_OPERATING_RULES_HEADING_PATTERN.test(content.trimStart());
}

export function applyAgentOperatingRulesFloor(
  source: SessionInstructionSource,
  content: string,
): { content: string; provenance: Record<string, unknown> | null; metadata: Record<string, unknown> | null } {
  const unchanged = {
    content,
    provenance: source.provenance ?? null,
    metadata: source.metadata ?? null,
  };
  if (!claimsAgentOperatingRulesPolicy(source, content)) return unchanged;

  const payload = resolveAgentOperatingRulesPayload(content);
  if (payload.content === content) {
    return {
      content,
      provenance: { ...(source.provenance ?? {}), payloadIntegrity: payload.integrity },
      metadata: { ...(source.metadata ?? {}), payloadIntegrity: payload.integrity },
    };
  }

  const floored = {
    payloadFloorApplied: true,
    flooredFromRulesVersion: parseAgentOperatingRulesVersion(content),
    flooredFromPayloadSha256: sha256(content),
  };
  return {
    content: payload.content,
    provenance: { ...(source.provenance ?? {}), ...payload.provenance, ...floored },
    metadata: { ...(source.metadata ?? {}), ...payload.metadata, ...floored },
  };
}

export function normalizeSources(
  sources: SessionInstructionSource[],
  tool: SessionRenderTool,
  allowEmptySources: boolean,
): OrderedSessionInstructionSource[] {
  const normalized = sources
    .map((source, index) => {
      if (!source.id.trim()) throw new Error("Session instruction source id is required.");
      // Floor BEFORE provider filtering: the pinned digest describes the payload as
      // published, so comparing filtered bytes against it would fail for any payload that
      // legitimately uses provider-only blocks and would silently replace it.
      const floored = applyAgentOperatingRulesFloor(source, source.content ?? "");
      const content = filterProviderOnlyBlocks(floored.content, tool);
      const normalized = {
        ...source,
        content,
        provenance: floored.provenance,
        metadata: floored.metadata,
        normalizedId: slug(source.id),
        resolvedLabel: source.label ?? source.id,
        resolvedLayer: source.layer === undefined ? "agent" : normalizeSessionInstructionLayer(source.layer),
        resolvedMerge: source.merge ?? "append",
        resolvedOrder: source.order ?? index,
        resolvedRules: normalizeInstructionRules(source, tool),
      };
      const hasPathReferences = (normalized.sourcePaths ?? []).length > 0;
      if (!allowEmptySources && !normalized.content.trim() && normalized.resolvedRules.length === 0 && !hasPathReferences) {
        throw new Error(`Session instruction source "${source.id}" is empty. Pass --allow-empty-sources only for explicit empty renders.`);
      }
      return normalized;
    });
  const ordered = deduplicateSemanticPolicySources(normalized)
    .sort((a, b) =>
      SESSION_LAYER_RANK[a.resolvedLayer] - SESSION_LAYER_RANK[b.resolvedLayer] ||
      a.resolvedOrder - b.resolvedOrder ||
      a.id.localeCompare(b.id)
    );
  rejectDuplicateSourceSlugs(ordered);
  rejectDuplicateRulePaths(ordered);
  return ordered;
}

/**
 * Collapses sources that declare the same semantic policy down to one.
 *
 * Keyed on the policy IDENTITY, not on the declared version: once a store can hold a
 * newer rules payload, a version-keyed map would let a newer source and a stale
 * duplicate both survive and stamp one instruction file with two contradictory rule-set
 * versions. Selection is priority-first, then version — so the managed non-overridable
 * source still wins over an ordinary source that merely declares a higher version, and
 * two equally-privileged sources resolve to the newer one.
 */
export function deduplicateSemanticPolicySources(
  sources: OrderedSessionInstructionSource[],
): OrderedSessionInstructionSource[] {
  const selected: OrderedSessionInstructionSource[] = [];
  const policySources = new Map<string, { index: number; version: string; normalizedContent: string }>();
  for (const source of sources) {
    const sentinel = source.content.match(AGENT_OPERATING_RULES_SENTINEL_PATTERN);
    if (!sentinel) {
      selected.push(source);
      continue;
    }
    const version = sentinel[1]!;
    const key = AGENT_OPERATING_RULES_SEMANTIC_POLICY_KEY;
    const normalizedContent = source.content.replace(/\r\n/g, "\n").trim();
    const existing = policySources.get(key);
    if (!existing) {
      policySources.set(key, { index: selected.length, version, normalizedContent });
      selected.push(source);
      continue;
    }
    const versionOrder = compareAgentOperatingRulesVersions(version, existing.version);
    // Two sources claiming the same version must agree byte for byte, whatever their
    // privilege — silently picking one of two conflicting same-version policies would
    // hide a real distribution fault.
    if (versionOrder === 0 && existing.normalizedContent !== normalizedContent) {
      throw new Error(`Conflicting semantic policy sources declare ${key}/v${version} with different content.`);
    }
    const current = selected[existing.index]!;
    const priorityOrder = semanticPolicySourcePriority(source) - semanticPolicySourcePriority(current);
    if (priorityOrder < 0) continue;
    if (priorityOrder === 0 && versionOrder <= 0) continue;
    selected[existing.index] = {
      ...source,
      resolvedOrder: current.resolvedOrder,
    };
    policySources.set(key, { index: existing.index, version, normalizedContent });
  }
  return selected;
}

export function semanticPolicySourcePriority(source: OrderedSessionInstructionSource): number {
  let priority = 0;
  if (source.nonOverridable) priority += 4;
  if (source.id === GLOBAL_AGENT_RULES_STANDARD_SLUG) priority += 2;
  if (source.metadata?.["role"] === AGENT_OPERATING_RULES_ROLE) priority += 1;
  return priority;
}

export function filterProviderOnlyBlocks(content: string, tool: SessionRenderTool): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let activeProviders: string[] | null = null;
  for (const line of lines) {
    const start = line.match(/^\s*<!--\s*@hasna-provider:\s*([^>]+?)\s*-->\s*$/i);
    if (start) {
      if (activeProviders) throw new Error("Nested provider-only instruction blocks are not supported.");
      activeProviders = start[1]!.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
      continue;
    }
    if (/^\s*<!--\s*@hasna-end-provider\s*-->\s*$/i.test(line)) {
      if (!activeProviders) throw new Error("Provider-only instruction block end marker without start marker.");
      activeProviders = null;
      continue;
    }
    if (!activeProviders || activeProviders.includes(tool) || activeProviders.includes("all") || activeProviders.includes("generic")) {
      output.push(line);
    }
  }
  if (activeProviders) throw new Error("Provider-only instruction block was not closed.");
  return output.join("\n");
}

export function composeSources(sources: OrderedSessionInstructionSource[]): OrderedSessionInstructionSource[] {
  let start = -1;
  for (let i = 0; i < sources.length; i++) {
    if (sources[i]!.resolvedMerge === "replace") start = i;
  }
  if (start < 0) return sources;
  const protectedSources = sources.slice(0, start).filter((source) => source.nonOverridable);
  return [...protectedSources, ...sources.slice(start)];
}

export function sectionForSource(source: OrderedSessionInstructionSource): string {
  const parts = [
    `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
    `# ${source.resolvedLabel}`,
  ];
  if (source.path) parts.push(`Source: ${source.path}`);
  if (source.sourcePaths && source.sourcePaths.length > 0) {
    parts.push([
      "Source paths:",
      ...source.sourcePaths.map((sourcePath) => {
        const flags = [
          sourcePath.editable ? "editable" : null,
          sourcePath.required ? "required" : null,
          sourcePath.hash ? sourcePath.hash : null,
        ].filter(Boolean);
        return `- ${sourcePath.path}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
      }),
    ].join("\n"));
  }
  if (source.owner) parts.push(`Owner: ${source.owner.kind}:${source.owner.id}`);
  const content = source.content.trim();
  if (content) parts.push(content);
  return parts.join("\n\n");
}

export function sectionForRule(source: OrderedSessionInstructionSource, rule: OrderedSessionInstructionRule): string {
  const parts = [
    `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
    `# ${rule.resolvedLabel}`,
  ];
  if (source.path) parts.push(`Source: ${source.path}`);
  if (rule.path) parts.push(`Rule path: ${rule.path}`);
  const content = rule.content.trim();
  if (content) parts.push(content);
  return parts.join("\n\n");
}

export function fragmentPath(adapter: SessionToolAdapter, index: number, source: OrderedSessionInstructionSource): string {
  const n = String(index + 1).padStart(2, "0");
  return posix.join(adapter.managedDir, `${n}-${source.normalizedId}.md`);
}

export function ruleFragmentPath(
  adapter: SessionToolAdapter,
  source: OrderedSessionInstructionSource,
  rule: OrderedSessionInstructionRule,
): string {
  return posix.join(adapter.managedDir, "rules", source.normalizedId, rule.resolvedPath);
}

export function importPath(indexRelativePath: string, fragmentRelativePath: string): string {
  const relative = posix.relative(posix.dirname(indexRelativePath), fragmentRelativePath);
  if (relative.startsWith("./") || relative.startsWith("../")) return relative;
  return `./${relative}`;
}

export function indexHeader(tool: SessionRenderTool, profile: string): string {
  return [
    `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
    `# ${tool} session instructions`,
    "",
    `Profile: ${profile}`,
  ].join("\n");
}

export function buildNativeImportFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  const indexFile = adapter.indexFile!;
  const fragments = sources.flatMap((source, index) => [
    makeFile(targetHome, fragmentPath(adapter, index, source), "fragment", sectionForSource(source), [source.id]),
    ...source.resolvedRules.map((rule) =>
      makeFile(targetHome, ruleFragmentPath(adapter, source, rule), "rule", sectionForRule(source, rule), [source.id, rule.id])
    ),
  ]);
  const imports = fragments.map((file) => `@${importPath(indexFile, file.relativePath)}`);
  const index = makeFile(
    targetHome,
    indexFile,
    "index",
    [indexHeader(adapter.tool, profile), ...imports].join("\n"),
    sources.map((source) => source.id),
  );
  return [index, ...fragments];
}

export function buildFlattenedMarkdownFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  const content = [
    indexHeader(adapter.tool, profile),
    ...sources.flatMap((source) => [
      sectionForSource(source),
      ...source.resolvedRules.map((rule) => sectionForRule(source, rule)),
    ]),
  ].join("\n\n");
  return [
    makeFile(targetHome, adapter.indexFile!, "index", content, [
      ...sources.map((source) => source.id),
      ...sources.flatMap((source) => source.resolvedRules.map((rule) => rule.id)),
    ]),
  ];
}

export function buildCursorRuleFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  return sources.flatMap((source, index) => {
    const n = String(index + 1).padStart(2, "0");
    const stem = `${n}-${source.normalizedId}`;
    const relativePath = posix.join(adapter.managedDir, `${stem}.mdc`);
    const description = `${source.resolvedLabel} (${source.resolvedLayer})`;
    const content = [
      "---",
      `description: ${yamlQuote(description)}`,
      'globs: ["**/*"]',
      "alwaysApply: true",
      "---",
      "",
      `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
      "",
      source.content.trim(),
    ].join("\n");
    const sourceFile = makeFile(targetHome, relativePath, "rule", content, [source.id]);
    const ruleFiles = source.resolvedRules.map((rule) => {
      const ruleStem = `${n}-${source.normalizedId}-${rule.normalizedId}`;
      const ruleRelativePath = posix.join(adapter.managedDir, `${ruleStem}.mdc`);
      const ruleDescription = `${rule.resolvedLabel} (${source.resolvedLayer})`;
      const ruleContent = [
        "---",
        `description: ${yamlQuote(ruleDescription)}`,
        `globs: ${JSON.stringify(rule.globs && rule.globs.length > 0 ? rule.globs : ["**/*"])}`,
        "alwaysApply: true",
        "---",
        "",
        `<!-- ${SESSION_RENDER_MANAGED_MARKER}. Do not edit this generated file directly. -->`,
        "",
        rule.content.trim(),
      ].join("\n");
      return makeFile(targetHome, ruleRelativePath, "rule", ruleContent, [source.id, rule.id]);
    });
    return [sourceFile, ...ruleFiles];
  });
}

export function buildOpenCodeFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
  providerConfig?: SessionProviderConfig,
): SessionRenderFile[] {
  const fragments = sources.flatMap((source, index) => [
    makeFile(targetHome, fragmentPath(adapter, index, source), "fragment", sectionForSource(source), [source.id]),
    ...source.resolvedRules.map((rule) =>
      makeFile(targetHome, ruleFragmentPath(adapter, source, rule), "rule", sectionForRule(source, rule), [source.id, rule.id])
    ),
  ]);
  const flattenedIndex = makeFile(
    targetHome,
    adapter.indexFile!,
    "index",
    [
      indexHeader(adapter.tool, profile),
      ...sources.flatMap((source) => [
        sectionForSource(source),
        ...source.resolvedRules.map((rule) => sectionForRule(source, rule)),
      ]),
    ].join("\n\n"),
    [
      ...sources.map((source) => source.id),
      ...sources.flatMap((source) => source.resolvedRules.map((rule) => rule.id)),
    ],
  );
  const existingConfigPath = joinTarget(targetHome, adapter.configFile!);
  const selectedConfig = existsSync(existingConfigPath)
    ? readOpenCodeConfig(readFileSync(existingConfigPath, "utf8"), existingConfigPath)
    : providerConfig
      ? readOpenCodeConfig(providerConfig.content, providerConfig.sourceId)
      : {};
  const preservedInstructions = normalizeOpenCodeInstructions(selectedConfig["instructions"])
    .filter((path) => !pathIsManagedOpenCodeInstruction(path, adapter.managedDir));
  const config = {
    ...selectedConfig,
    $schema: typeof selectedConfig["$schema"] === "string"
      ? selectedConfig["$schema"]
      : "https://opencode.ai/config.json",
    instructions: [
      ...preservedInstructions,
      ...fragments.map((file) => file.relativePath),
    ],
  };
  const configSourceIds = [
    ...sources.map((source) => source.id),
    ...(providerConfig ? [providerConfig.sourceId] : []),
  ];
  return [
    flattenedIndex,
    makeFile(targetHome, adapter.configFile!, "config", JSON.stringify(config, null, 2), configSourceIds),
    ...fragments,
  ];
}

export function readOpenCodeConfig(content: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenCode config ${source} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenCode config ${source} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function normalizeOpenCodeInstructions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("OpenCode config instructions must be an array of strings.");
  }
  return value as string[];
}

export function pathIsManagedOpenCodeInstruction(path: string, managedDir: string): boolean {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  return normalized === managedDir || normalized.startsWith(`${managedDir}/`);
}

export function buildAntigravityRuleFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  sources: OrderedSessionInstructionSource[],
): SessionRenderFile[] {
  return sources.flatMap((source, index) => {
    const n = String(index + 1).padStart(2, "0");
    const sourcePath = posix.join(adapter.managedDir, `${n}-${source.normalizedId}.md`);
    const sourceFile = makeAntigravityRuleFile(targetHome, sourcePath, sectionForSource(source), [source.id]);
    const ruleFiles = source.resolvedRules.map((rule) => {
      const rulePath = posix.join(adapter.managedDir, `${n}-${source.normalizedId}-${rule.resolvedPath}`);
      return makeAntigravityRuleFile(targetHome, rulePath, sectionForRule(source, rule), [source.id, rule.id]);
    });
    return [sourceFile, ...ruleFiles];
  });
}

export function makeAntigravityRuleFile(
  targetHome: string,
  relativePath: string,
  content: string,
  sourceIds: string[],
): SessionRenderFile {
  const file = makeFile(targetHome, relativePath, "rule", content, sourceIds);
  if (file.content.length > ANTIGRAVITY_RULE_FILE_CHAR_LIMIT) {
    throw new Error(
      `Antigravity rule file ${file.relativePath} is ${file.content.length} characters; split it before rendering because Antigravity limits rule files to ${ANTIGRAVITY_RULE_FILE_CHAR_LIMIT} characters.`
    );
  }
  return file;
}

export function buildFiles(
  targetHome: string,
  adapter: SessionToolAdapter,
  profile: string,
  sources: OrderedSessionInstructionSource[],
  providerConfig?: SessionProviderConfig,
): SessionRenderFile[] {
  switch (adapter.mode) {
    case "native-imports":
      return buildNativeImportFiles(targetHome, adapter, profile, sources);
    case "flattened-markdown":
      return buildFlattenedMarkdownFiles(targetHome, adapter, profile, sources);
    case "cursor-mdc":
      return buildCursorRuleFiles(targetHome, adapter, sources);
    case "opencode-instructions":
      return buildOpenCodeFiles(targetHome, adapter, profile, sources, providerConfig);
    case "antigravity-rules":
      return buildAntigravityRuleFiles(targetHome, adapter, sources);
  }
}


export function normalizeInstructionRules(source: SessionInstructionSource, tool: SessionRenderTool): OrderedSessionInstructionRule[] {
  const seen = new Set<string>();
  return (source.rules ?? []).map((rule) => {
    if (!rule.id.trim()) throw new Error(`Instruction rule id is required for source ${source.id}.`);
    const content = filterProviderOnlyBlocks(rule.content ?? "", tool);
    if (!content.trim() && !rule.path) throw new Error(`Instruction rule content or path is required for rule ${rule.id}.`);
    const resolvedPath = normalizeRulePath(rule.path ?? `${slug(rule.id)}.md`);
    const key = resolvedPath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate rule path for source ${source.id}: ${resolvedPath}`);
    seen.add(key);
    return {
      ...rule,
      content,
      normalizedId: slug(rule.id),
      resolvedLabel: rule.label ?? rule.id,
      resolvedPath,
    };
  });
}

export function rejectDuplicateRenderPaths(files: SessionRenderFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.relativePath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate session render file path: ${file.relativePath}`);
    seen.add(key);
  }
}

export function rejectDuplicateSourceSlugs(sources: OrderedSessionInstructionSource[]): void {
  const seen = new Map<string, string>();
  for (const source of sources) {
    const existing = seen.get(source.normalizedId);
    if (existing) throw new Error(`Duplicate session instruction source slug: ${source.normalizedId} (${existing}, ${source.id})`);
    seen.set(source.normalizedId, source.id);
  }
}

export function rejectDuplicateRulePaths(sources: OrderedSessionInstructionSource[]): void {
  const seen = new Map<string, string>();
  for (const source of sources) {
    for (const rule of source.resolvedRules) {
      const key = rule.resolvedPath.toLowerCase();
      const existing = seen.get(key);
      if (existing) throw new Error(`Duplicate instruction rule path: ${rule.resolvedPath} (${existing}, ${rule.id})`);
      seen.set(key, rule.id);
    }
  }
}

export function normalizeRulePath(path: string): string {
  if (!path.trim()) throw new Error("Instruction rule path cannot be empty.");
  if (path.includes("\\")) throw new Error(`Instruction rule path must use POSIX separators: ${path}`);
  const normalized = posix.normalize(path);
  if (normalized === "." || posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Instruction rule path escapes managed rule directory: ${path}`);
  }
  return normalized;
}

