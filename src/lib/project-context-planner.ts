import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SESSION_RENDER_SCHEMA } from "./session-render-contract.js";
import {
  LEGACY_CONFIGS_COMPAT_VERSION, LEGACY_CONFIGS_EXECUTABLE, LEGACY_CONFIGS_PACKAGE,
  PROJECT_CONTEXT_CACHE_PATH, PROJECT_CONTEXT_CACHE_SCHEMA, PROJECT_CONTEXT_FRAGMENT_PATH,
  PROJECT_CONTEXT_LOCK_PATH, PROJECT_CONTEXT_LOCK_STALE_MS, PROJECT_CONTEXT_MANAGED_COMMENT,
  PROJECT_CONTEXT_MANIFEST_PATH, PROJECT_CONTEXT_MAX_APPROX_TOKENS,
  PROJECT_CONTEXT_MAX_RENDERED_BYTES, PROJECT_CONTEXT_MAX_WARNINGS, PROJECT_CONTEXT_SCHEMA,
  PROJECT_CONTEXT_SNAPSHOT_DIR, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES,
  ProjectContextError, ProjectContextHashRace, compareRevisions, computeProjectContextSourceHash,
  isRecord, parseProjectContextBundle, revisionKey, revisionSchema, scanGeneratedContent, sha256,
  stableStringify,
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
import { lineContentEnd, linesWithOffsets, readUtf8RegularFile } from "./project-context-runtime.js";
import {
  readProjectContextCache, readProjectContextManifest, readSessionManifestRecord,
  writeMetadataSnapshot, buildCache, buildManifest,
} from "./project-context-manifest.js";

export function planProjectContext(input: ProjectContextPlanInput): ProjectContextPlan {
  const workspaceRoot = assertSafeWorkspaceRoot(input.workspace_root);
  const bundle = parseProjectContextBundle(input.bundle);
  if (bundle.resolution.conflict) {
    throw new ProjectContextError("PROJECT_CONTEXT_IDENTITY_CONFLICT", "Projects reported a conflicting identity resolution");
  }
  const paths = runtimePaths(workspaceRoot, input.runtime);
  assertCodewithTargetIsConsumed(workspaceRoot, input.runtime);
  for (const path of [paths.target, paths.fragment, paths.manifest, paths.cache]) {
    assertNoSymlinkSegments(workspaceRoot, path);
  }

  const now = input.now ?? new Date();
  const status = input.status ?? (bundle.freshness === "fresh" ? "fresh" : "stale-source");
  const generatedAgeSeconds = ageInSeconds(bundle.generated_at, now);
  const ageSeconds = input.age_seconds ?? generatedAgeSeconds;
  if (!Number.isInteger(ageSeconds) || ageSeconds < 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "project context age must be a non-negative integer");
  }
  const nativeImports = runtimeUsesNativeImports(input.runtime, input.codewith_native_imports);
  const inlineMarkerOverhead = nativeImports ? 0 : Buffer.byteLength(buildManagedBlock(bundle, "", "\n"), "utf8");
  const generated = buildCanonicalFragment(
    bundle,
    status,
    ageSeconds,
    PROJECT_CONTEXT_MAX_RENDERED_BYTES - Math.max(320, inlineMarkerOverhead),
    PROJECT_CONTEXT_MAX_APPROX_TOKENS - Math.max(80, Math.ceil(inlineMarkerOverhead / 4)),
  );
  const previousTargetContent = existsSync(paths.target) ? readUtf8RegularFile(paths.target, workspaceRoot) : null;
  const markerParse = parseManagedBlock(previousTargetContent ?? "", input.force === true);
  if (markerParse.block && markerParse.block.id !== bundle.project.id) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "managed block belongs to a different project");
  }
  const eol = preferredEol(previousTargetContent ?? "");
  const body = nativeImports
    ? `@${input.runtime === "codewith" ? "../" : ""}${PROJECT_CONTEXT_FRAGMENT_PATH}`
    : generated.fragment.trimEnd();
  const managedBlock = buildManagedBlock(bundle, body, eol);
  if (Buffer.byteLength(managedBlock, "utf8") > PROJECT_CONTEXT_MAX_RENDERED_BYTES || Math.ceil(managedBlock.length / 4) > PROJECT_CONTEXT_MAX_APPROX_TOKENS) {
    throw new ProjectContextError("PROJECT_CONTEXT_RENDER_TOO_LARGE", "managed provider block exceeds its bounded render budget");
  }

  const legacy = markerParse.block === null
    ? findLegacyCodewithWorkspaceSection(workspaceRoot, input.runtime, previousTargetContent, bundle)
    : null;
  const targetContent = replaceOrAppendManagedBlock(
    previousTargetContent ?? "",
    managedBlock,
    markerParse,
    legacy,
  );
  scanGeneratedContent(generated.fragment);
  scanGeneratedContent(managedBlock);

  const expectedHashes = new Map<string, string | null>();
  for (const path of [paths.fragment, paths.target, paths.cache, paths.manifest, paths.sessionManifest]) {
    if (!path) continue;
    expectedHashes.set(path, currentFileHash(path, workspaceRoot));
  }

  return {
    workspace_root: workspaceRoot,
    runtime: input.runtime,
    target_path: paths.target,
    target_relative_path: relativePosix(workspaceRoot, paths.target),
    fragment_path: paths.fragment,
    manifest_path: paths.manifest,
    cache_path: paths.cache,
    source_path: paths.cache,
    bundle,
    fragment: generated.fragment,
    managed_block: managedBlock,
    target_content: targetContent,
    target_previous_content: previousTargetContent,
    status,
    age_seconds: ageSeconds,
    warnings: generated.warnings,
    included_commands: generated.includedCommands,
    native_imports: nativeImports,
    marker: markerParse.block,
    legacy_migration: legacy !== null,
    expected_hashes: expectedHashes,
  };
}


export function resultForPlan(
  plan: ProjectContextPlan,
  dryRun: boolean,
  raceRetries: number,
  snapshotPath: string | null,
): ProjectContextApplyResult {
  return {
    applied: !dryRun,
    dry_run: dryRun,
    workspace_root: plan.workspace_root,
    runtime: plan.runtime,
    project_id: plan.bundle.project.id,
    revision: plan.bundle.revision,
    hash: plan.bundle.hash,
    status: plan.status,
    age_seconds: plan.age_seconds,
    race_retries: raceRetries,
    target_path: plan.target_path,
    fragment_path: plan.fragment_path,
    manifest_path: plan.manifest_path,
    cache_path: plan.cache_path,
    snapshot_path: snapshotPath,
    warnings: plan.warnings,
  };
}

export function expectedPlanHash(plan: ProjectContextPlan, path: string): string | null {
  if (!plan.expected_hashes.has(path)) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `missing expected hash for managed path ${relativePosix(plan.workspace_root, path)}`);
  }
  return plan.expected_hashes.get(path) ?? null;
}

export function assertRenderedOutputsStable(
  plan: ProjectContextPlan,
  cacheContent: string,
  sessionOutput: { path: string; content: string },
): void {
  const outputs = [
    { path: plan.fragment_path, content: plan.fragment },
    { path: plan.target_path, content: plan.target_content },
    { path: plan.cache_path, content: cacheContent },
    sessionOutput,
  ];
  for (const output of outputs) {
    if (currentFileHash(output.path, plan.workspace_root) !== sha256(output.content)) {
      throw new ProjectContextHashRace(`managed path changed before manifest commit: ${relativePosix(plan.workspace_root, output.path)}`);
    }
  }
}

export function resolveBundleForApply(
  options: ProjectContextApplyOptions,
  workspaceRoot: string,
  now: Date,
): { bundle: ProjectContextBundleV1; status: ProjectContextStatus; ageSeconds: number; sourcePath: string } {
  const hasInput = options.bundle_json !== undefined || options.bundle !== undefined;
  if (hasInput) {
    try {
      const bundle = parseProjectContextBundle(options.bundle_json ?? options.bundle);
      if (options.expected_project_id && bundle.project.id !== options.expected_project_id) {
        throw new ProjectContextError("PROJECT_CONTEXT_IDENTITY_CONFLICT", "bundle project ID differs from the expected project ID");
      }
      return {
        bundle,
        status: bundle.freshness === "fresh" ? "fresh" : "stale-source",
        ageSeconds: ageInSeconds(bundle.generated_at, now),
        sourcePath: durableSourcePath(options.source_path, workspaceRoot),
      };
    } catch (error) {
      if (!(error instanceof ProjectContextError) || error.code !== "PROJECT_CONTEXT_UNSUPPORTED_VERSION" || !options.allow_stale_cache) {
        throw error;
      }
    }
  }

  if (!options.allow_stale_cache) {
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_REQUIRED", "a v1 bundle is required unless stale-cache fallback is explicit");
  }
  if (!options.expected_project_id) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_ID_REQUIRED", "expected_project_id is required for stale-cache fallback");
  }
  const cachePath = resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/"));
  const cache = readProjectContextCache(cachePath, workspaceRoot);
  if (!cache) throw new ProjectContextError("PROJECT_CONTEXT_CACHE_MISSING", "no last-known-good project context cache exists");
  if (cache.project_id !== options.expected_project_id || cache.bundle.project.id !== options.expected_project_id) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_ID_MISMATCH", "cached project context belongs to a different project");
  }
  const bundle = parseProjectContextBundle(cache.bundle);
  if (bundle.revision !== cache.revision || bundle.hash !== cache.hash) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", "cached revision or hash metadata is inconsistent");
  }
  const ageSeconds = Math.max(
    staleCacheAgeInSeconds(bundle.generated_at, now, "bundle generated_at"),
    staleCacheAgeInSeconds(cache.cached_at, now, "cache cached_at"),
  );
  const maxAge = normalizeMaxStaleAge(options.max_stale_age_seconds);
  if (ageSeconds > maxAge) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_EXPIRED", `cached project context age ${ageSeconds}s exceeds ${maxAge}s`);
  }
  return { bundle, status: "stale-cache", ageSeconds, sourcePath: cachePath };
}

export function buildCanonicalFragment(
  bundle: ProjectContextBundleV1,
  status: ProjectContextStatus,
  ageSeconds: number,
  maxBytes: number,
  maxTokens: number,
): { fragment: string; warnings: string[]; includedCommands: number } {
  const warnings = boundedWarnings(bundle, status, ageSeconds);
  const commands = [...bundle.commands];
  let fragment = "";
  do {
    fragment = renderFragment(bundle, status, ageSeconds, warnings, commands);
    const bytes = Buffer.byteLength(fragment, "utf8");
    const tokens = Math.ceil(fragment.length / 4);
    if (bytes <= maxBytes && tokens <= maxTokens) break;
    if (commands.length === 0) {
      throw new ProjectContextError("PROJECT_CONTEXT_RENDER_TOO_LARGE", "core project identity exceeds the bounded fragment budget");
    }
    commands.pop();
  } while (true);
  scanGeneratedContent(fragment);
  return { fragment, warnings, includedCommands: commands.length };
}

export function renderFragment(
  bundle: ProjectContextBundleV1,
  status: ProjectContextStatus,
  ageSeconds: number,
  warnings: string[],
  commands: ProjectContextBundleV1["commands"],
): string {
  const project = bundle.project;
  const lines = [
    `<!-- ${PROJECT_CONTEXT_MANAGED_COMMENT} fragment. canonicalOwner=instructions id=${project.id} revision=${bundle.revision} hash=${bundle.hash} -->`,
    "# Managed Project Context",
    "",
    `Context: ${statusLabel(status, ageSeconds)}`,
    `Project: ${inlineCode(project.name)} (${inlineCode(project.slug)})`,
    `ID: \`${project.id}\``,
    `Kind: \`${project.kind}\``,
    `Status: \`${project.status}\``,
    `Revision: \`${bundle.revision}\``,
    `Authority: \`${bundle.authority.owner}\` / \`${bundle.authority.mode}\` / \`${bundle.authority.storage}\` / \`${bundle.authority.availability}\``,
    `Resolution: \`${bundle.resolution.source}\`; create allowed: \`${String(bundle.resolution.create_allowed)}\``,
    `Path: ${project.path ? inlineCode(project.path) : "`none`"}`,
    `Updated: \`${project.updated_at}\``,
    "",
    "## Linked Systems",
    "",
    `- Todos (\`${bundle.links.todos.state}\`): project ${inlineNullable(bundle.links.todos.project_id)}, task list ${inlineNullable(bundle.links.todos.task_list_id)}`,
    `- Conversations (\`${bundle.links.conversations.state}\`): channel ${inlineNullable(bundle.links.conversations.channel)}`,
    `- Mementos (\`${bundle.links.mementos.state}\`): project ${inlineNullable(bundle.links.mementos.project_id)}, scope ${inlineNullable(bundle.links.mementos.scope)}`,
    `- Station: ${bundle.station ? `${inlineNullable(bundle.station.station_id)}; machine ${inlineNullable(bundle.station.machine_id)}` : "`unknown`"}`,
  ];
  if (warnings.length > 0) {
    lines.push("", "## Warnings", "", ...warnings.map((warning) => `- ${warning}`));
  }
  if (commands.length > 0) {
    lines.push("", "## Safe Next Commands", "");
    for (const command of commands) {
      lines.push(`- ${escapeText(command.name)}: \`${command.argv.map(shellQuote).join(" ")}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function boundedWarnings(bundle: ProjectContextBundleV1, status: ProjectContextStatus, ageSeconds: number): string[] {
  const warnings: string[] = [];
  if (status === "stale-cache") warnings.push(`Using a bounded last-known-good cache aged ${ageSeconds}s; refresh from Projects before mutation.`);
  else if (status === "stale-source") warnings.push(`Projects marked this context stale; source age is ${ageSeconds}s.`);
  if (bundle.freshness === "unknown") warnings.push("Projects could not establish source freshness for this bundle.");
  if (bundle.authority.availability === "unavailable") warnings.push("The Projects authority was unavailable when this bundle was produced.");
  if (bundle.links.todos.state === "partial" || bundle.links.conversations.state === "partial" || bundle.links.mementos.state === "partial") {
    warnings.push("One or more linked-system identities are partial.");
  }
  return warnings.slice(0, PROJECT_CONTEXT_MAX_WARNINGS);
}

export function buildManagedBlock(bundle: ProjectContextBundleV1, body: string, eol: string): string {
  const revision = encodeURIComponent(bundle.revision);
  const begin = `<!-- ${PROJECT_CONTEXT_MANAGED_COMMENT} BEGIN id=${bundle.project.id} revision=${revision} hash=${bundle.hash} -->`;
  const end = `<!-- ${PROJECT_CONTEXT_MANAGED_COMMENT} END id=${bundle.project.id} revision=${revision} hash=${bundle.hash} -->`;
  return `${begin}${eol}${body.replace(/\r?\n/g, eol).trimEnd()}${eol}${end}`;
}

export function parseManagedBlock(content: string, force: boolean): { block: ManagedBlock | null; forceRange: { start: number; end: number } | null } {
  const lines = linesWithOffsets(content);
  const markerLines = lines.filter((line) =>
    (
      line.text.includes(PROJECT_CONTEXT_MANAGED_COMMENT) ||
      /@hasna\/configs project context/i.test(line.text)
    ) && !line.text.includes(`${PROJECT_CONTEXT_MANAGED_COMMENT} fragment.`)
  );
  if (markerLines.length === 0) return { block: null, forceRange: null };

  const parsed = markerLines.map((line) => ({ ...line, marker: parseMarkerLine(line.text) }));
  const malformed = parsed.some((line) => line.marker === null);
  const starts = parsed.filter((line) => line.marker?.kind === "BEGIN");
  const ends = parsed.filter((line) => line.marker?.kind === "END");
  const structurallyInvalid = malformed || starts.length !== 1 || ends.length !== 1 || starts[0]!.start >= ends[0]!.start;
  if (structurallyInvalid) {
    if (!force) throw new ProjectContextError("MANAGED_BLOCK_INVALID", "managed project-context markers are duplicate, nested, malformed, or unbalanced");
    return {
      block: null,
      forceRange: {
        start: markerLines[0]!.start,
        end: lineContentEnd(markerLines[markerLines.length - 1]!),
      },
    };
  }

  const begin = starts[0]!;
  const end = ends[0]!;
  const a = begin.marker!;
  const b = end.marker!;
  if (a.id !== b.id || a.revision !== b.revision || a.hash !== b.hash) {
    if (!force) throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "managed project-context marker metadata is inconsistent");
    return { block: null, forceRange: { start: begin.start, end: lineContentEnd(end) } };
  }
  const nested = parsed.some((line) => line.start > begin.start && line.start < end.start);
  if (nested) {
    if (!force) throw new ProjectContextError("MANAGED_BLOCK_INVALID", "nested managed project-context markers are not supported");
    return { block: null, forceRange: { start: begin.start, end: lineContentEnd(end) } };
  }
  return {
    block: {
      start: begin.start,
      end: lineContentEnd(end),
      id: a.id,
      revision: a.revision,
      hash: a.hash,
      legacy: a.legacy || b.legacy,
    },
    forceRange: null,
  };
}

export function parseMarkerLine(text: string): { kind: "BEGIN" | "END"; id: string; revision: string; hash: string; legacy: boolean } | null {
  const line = text.replace(/[\r\n]+$/, "");
  const canonical = line.match(/^<!-- Managed by @hasna\/configs project context (BEGIN|END) id=([A-Za-z0-9][A-Za-z0-9._:@+-]*) revision=([A-Za-z0-9%._~+-]+) hash=(sha256:[a-f0-9]{64}) -->$/);
  if (canonical) {
    try {
      const revision = decodeURIComponent(canonical[3]!);
      if (!revisionSchema.safeParse(revision).success) return null;
      return { kind: canonical[1] as "BEGIN" | "END", id: canonical[2]!, revision, hash: canonical[4]!, legacy: false };
    } catch {
      return null;
    }
  }
  const legacy = line.match(/^<!-- (BEGIN|END) @hasna\/configs project context id=([A-Za-z0-9][A-Za-z0-9._:@+-]*) revision=((?:rev-)?[0-9]+) hash=(sha256:[a-f0-9]{64}) -->$/);
  if (legacy) {
    return { kind: legacy[1] as "BEGIN" | "END", id: legacy[2]!, revision: legacy[3]!, hash: legacy[4]!, legacy: true };
  }
  return null;
}

export function replaceOrAppendManagedBlock(
  content: string,
  block: string,
  parsed: ReturnType<typeof parseManagedBlock>,
  legacy: { start: number; end: number } | null,
): string {
  const range = parsed.block ?? parsed.forceRange ?? legacy;
  if (range) return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
  if (!content) return `${block}\n`;
  const eol = preferredEol(content);
  const separator = content.endsWith("\n") || content.endsWith("\r") ? eol : `${eol}${eol}`;
  return `${content}${separator}${block}${eol}`;
}

export function findLegacyCodewithWorkspaceSection(
  workspaceRoot: string,
  runtime: ProjectContextRuntime,
  content: string | null,
  bundle: ProjectContextBundleV1,
): { start: number; end: number } | null {
  if (runtime !== "codewith" || !content) return null;
  const sessionManifestPath = runtimePaths(workspaceRoot, runtime).sessionManifest;
  if (!existsSync(sessionManifestPath)) return null;
  const manifest = readSessionManifestRecord(sessionManifestPath, workspaceRoot);
  if (!manifest || manifest["schema"] !== SESSION_RENDER_SCHEMA) {
    throw new ProjectContextError("PROJECT_CONTEXT_MANIFEST_INVALID", "legacy Codewith session manifest is malformed or incompatible");
  }
  const sources = Array.isArray(manifest["sources"]) ? manifest["sources"] : [];
  const hasFdSource = sources.some((source) => isRecord(source) && typeof source["path"] === "string" && source["path"].startsWith("/dev/fd/"));
  if (!hasFdSource) return null;
  const files = Array.isArray(manifest["files"]) ? manifest["files"] : [];
  const codewith = files.find((file) => isRecord(file) && file["relativePath"] === "CODEWITH.md");
  if (!isRecord(codewith) || codewith["sha256"] !== sha256(content)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "legacy /dev/fd session manifest does not match CODEWITH.md");
  }
  const section = /^## Workspace\r?\n/gm.exec(content);
  if (!section) return null;
  const restStart = section.index + section[0].length;
  const next = /^## [^\r\n]+\r?\n/gm;
  next.lastIndex = restStart;
  const nextMatch = next.exec(content);
  const end = nextMatch?.index ?? content.length;
  const body = content.slice(section.index, end);
  if (!body.includes(".project.json") || !body.includes(bundle.project.id)) {
    throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "legacy project section cannot be tied to the incoming canonical project ID");
  }
  return { start: section.index, end };
}

export function assertRevisionOrdering(plan: ProjectContextPlan, force: boolean): void {
  const observations: Array<{ source: string; id: string; revision: string; hash: string }> = [];
  const manifest = readProjectContextManifest(plan.manifest_path, plan.workspace_root);
  if (manifest) {
    observations.push({
      source: "manifest",
      id: manifest.projectContext.projectId,
      revision: manifest.projectContext.revision,
      hash: manifest.projectContext.hash,
    });
    const fragmentEntry = manifest.files.find((file) => file.relativePath === PROJECT_CONTEXT_FRAGMENT_PATH);
    if (fragmentEntry && existsSync(plan.fragment_path)) {
      const actual = currentFileHash(plan.fragment_path, plan.workspace_root);
      if (actual !== fragmentEntry.sha256 && !fragmentMatchesBundle(plan.fragment_path, plan.bundle, plan.workspace_root) && !force) {
        throw new ProjectContextError("MANAGED_BLOCK_CONFLICT", "canonical project-context fragment changed outside Instructions");
      }
    }
  }
  const cache = readProjectContextCache(plan.cache_path, plan.workspace_root);
  if (cache) observations.push({ source: "cache", id: cache.project_id, revision: cache.revision, hash: cache.hash });
  if (plan.marker) observations.push({ source: "marker", id: plan.marker.id, revision: plan.marker.revision, hash: plan.marker.hash });

  for (const observation of observations) {
    if (observation.id !== plan.bundle.project.id) {
      throw new ProjectContextError("PROJECT_CONTEXT_IDENTITY_CONFLICT", `${observation.source} belongs to another project`);
    }
    const ordering = compareRevisions(plan.bundle.revision, observation.revision);
    if (ordering < 0) {
      throw new ProjectContextError("PROJECT_CONTEXT_REVISION_STALE", `incoming revision ${plan.bundle.revision} is older than ${observation.source} revision ${observation.revision}`);
    }
    if (ordering === 0 && plan.bundle.hash !== observation.hash) {
      throw new ProjectContextError("PROJECT_CONTEXT_REVISION_CONFLICT", `revision ${plan.bundle.revision} has a different hash than ${observation.source}`);
    }
  }
}
