import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { SessionRenderTool } from "./session-render-model.js";
import { CODEWITH_NATIVE_IMPORTS_ENV } from "./session-render-contract.js";
import {
  LEGACY_CONFIGS_COMPAT_VERSION, LEGACY_CONFIGS_EXECUTABLE, LEGACY_CONFIGS_PACKAGE,
  PROJECT_CONTEXT_CACHE_PATH, PROJECT_CONTEXT_CACHE_SCHEMA, PROJECT_CONTEXT_FRAGMENT_PATH,
  PROJECT_CONTEXT_LOCK_PATH, PROJECT_CONTEXT_LOCK_STALE_MS, PROJECT_CONTEXT_MANAGED_COMMENT,
  PROJECT_CONTEXT_MANIFEST_PATH, PROJECT_CONTEXT_MAX_APPROX_TOKENS,
  PROJECT_CONTEXT_MAX_RENDERED_BYTES, PROJECT_CONTEXT_MAX_WARNINGS, PROJECT_CONTEXT_SCHEMA,
  PROJECT_CONTEXT_SNAPSHOT_DIR, SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES,
  ProjectContextError, ProjectContextHashRace, computeProjectContextSourceHash,
  isRecord, parseProjectContextBundle, revisionKey, scanGeneratedContent, sha256, stableStringify,
  type ManagedBlock, type ProjectContextApplyOptions, type ProjectContextApplyResult,
  type ProjectContextBundleV1, type ProjectContextCache, type ProjectContextManifest,
  type ProjectContextManifestObservation, type ProjectContextPhase, type ProjectContextPlan,
  type ProjectContextPlanInput, type ProjectContextRuntime, type ProjectContextSessionGuard,
  type ProjectContextSessionRenderComposition, type ProjectContextSessionRenderInput,
  type ProjectContextStatus, type ProjectContextWriteCoordination, type WorkspaceLock,
  projectContextCacheSchema, storedManifestObservationSchema,
} from "./project-context-model.js";

export function runtimePaths(workspaceRoot: string, runtime: ProjectContextRuntime): {
  target: string;
  fragment: string;
  manifest: string;
  cache: string;
  sessionManifest: string;
} {
  const relativeTarget = runtime === "claude" ? "CLAUDE.md" : runtime === "codewith" ? ".codewith/CODEWITH.md" : "AGENTS.md";
  return {
    target: resolve(workspaceRoot, ...relativeTarget.split("/")),
    fragment: resolve(workspaceRoot, ...PROJECT_CONTEXT_FRAGMENT_PATH.split("/")),
    manifest: resolve(workspaceRoot, ...PROJECT_CONTEXT_MANIFEST_PATH.split("/")),
    cache: resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/")),
    sessionManifest: runtime === "codewith"
      ? resolve(workspaceRoot, ".codewith", ".hasna", "session-render-manifest.json")
      : resolve(workspaceRoot, ".hasna", "session-render-manifest.json"),
  };
}

export function projectContextSessionGuardPaths(
  paths: ReturnType<typeof runtimePaths>,
  runtime: ProjectContextRuntime,
): string[] {
  return [
    paths.manifest,
    paths.cache,
    paths.fragment,
    paths.target,
    paths.sessionManifest,
    ...(runtime === "codewith" ? [resolve(paths.target, "..", "CODEWITH.override.md")] : []),
  ];
}

export function sessionTargetRelativePath(runtime: ProjectContextRuntime): string {
  if (runtime === "claude") return "CLAUDE.md";
  if (runtime === "codewith") return "CODEWITH.md";
  return "AGENTS.md";
}

export function projectContextRuntimeForSessionTool(tool: SessionRenderTool): ProjectContextRuntime | null {
  if (tool === "claude") return "claude";
  if (tool === "codewith") return "codewith";
  if (tool === "codex") return "agents";
  return null;
}

export function projectContextWorkspaceForSession(
  input: Pick<ProjectContextSessionRenderInput, "target_home" | "project_root">,
  runtime: ProjectContextRuntime,
): string | null {
  const targetHome = resolve(input.target_home);
  if (runtime === "codewith") {
    const workspaceRoot = basename(targetHome) === ".codewith" ? dirname(targetHome) : null;
    if (!workspaceRoot) return null;
    if (input.project_root && resolve(input.project_root) !== workspaceRoot) {
      throw new ProjectContextError(
        "PROJECT_CONTEXT_PATH_INVALID",
        "Codewith project_root must be the parent workspace of target_home",
      );
    }
    if (!existsSync(workspaceRoot) || !lstatSync(workspaceRoot).isDirectory()) return null;
    return assertSafeWorkspaceRoot(workspaceRoot);
  }
  if (!existsSync(targetHome) || !lstatSync(targetHome).isDirectory()) return null;
  return assertSafeWorkspaceRoot(targetHome);
}

export function assertCodewithTargetIsConsumed(workspaceRoot: string, runtime: ProjectContextRuntime): void {
  if (runtime !== "codewith") return;
  const override = resolve(workspaceRoot, ".codewith", "CODEWITH.override.md");
  if (!existsSync(override)) return;
  assertNoSymlinkSegments(workspaceRoot, override);
  if (!lstatSync(override).isFile()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "Codewith override is not a regular file");
  throw new ProjectContextError("PROJECT_CONTEXT_SHADOWED", ".codewith/CODEWITH.override.md shadows .codewith/CODEWITH.md");
}

export function assertSafeWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "workspace root must be absolute");
  const normalized = resolve(path);
  if (normalized === parse(normalized).root) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "workspace root cannot be the filesystem root");
  if (!existsSync(normalized) || !lstatSync(normalized).isDirectory()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", "workspace root must be an existing directory");
  assertNoSymlinkAncestors(normalized);
  if (lstatSync(normalized).isSymbolicLink()) throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", "workspace root cannot be a symlink");
  return normalized;
}

export function assertNoSymlinkSegments(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new ProjectContextError("PROJECT_CONTEXT_PATH_ESCAPE", "managed path escapes workspace root");
  }
  let current = root;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", `managed path uses a symlink: ${current}`);
    }
  }
}

export function assertNoSymlinkAncestors(path: string): void {
  const normalized = resolve(path);
  let current = parse(normalized).root;
  for (const segment of relative(current, normalized).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", `workspace ancestor is a symlink: ${current}`);
  }
}

export function readUtf8RegularFile(path: string, workspaceRoot: string, maxBytes = 256 * 1024): string {
  assertNoSymlinkSegments(workspaceRoot, path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new ProjectContextError("PROJECT_CONTEXT_PATH_INVALID", `managed path is not a regular file: ${path}`);
  if (stat.size > maxBytes) throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `managed input exceeds ${maxBytes} bytes`);
  return readFileSync(path, "utf8");
}

export function currentFileHash(path: string, workspaceRoot: string): string | null {
  if (!existsSync(path)) return null;
  const relativePath = relativePosix(workspaceRoot, path);
  const maxBytes = relativePath === ".hasna/session-render-manifest.json" || relativePath === ".codewith/.hasna/session-render-manifest.json"
    ? SESSION_COMPATIBILITY_MANIFEST_MAX_BYTES
    : 256 * 1024;
  return sha256(readUtf8RegularFile(path, workspaceRoot, maxBytes));
}

export function hashesStillMatch(expected: Map<string, string | null>, workspaceRoot: string): boolean {
  for (const [path, hash] of expected) {
    if (currentFileHash(path, workspaceRoot) !== hash) return false;
  }
  return true;
}

export function fragmentMatchesBundle(path: string, bundle: ProjectContextBundleV1, workspaceRoot: string): boolean {
  const content = readUtf8RegularFile(path, workspaceRoot);
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  return first.includes(`id=${bundle.project.id}`) && first.includes(`revision=${bundle.revision}`) && first.includes(`hash=${bundle.hash}`);
}

export function durableSourcePath(path: string | undefined, workspaceRoot: string): string {
  if (!path || path.startsWith("/dev/fd/")) return resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/"));
  const normalized = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
  if (normalized.startsWith("/dev/fd/")) return resolve(workspaceRoot, ...PROJECT_CONTEXT_CACHE_PATH.split("/"));
  return normalized;
}

export function compareRevisions(incoming: string, previous: string): number {
  const a = revisionKey(incoming);
  const b = revisionKey(previous);
  if (!a || !b || a.kind !== b.kind) {
    throw new ProjectContextError("PROJECT_CONTEXT_REVISION_INCOMPARABLE", "project-context revisions use incompatible ordering schemes");
  }
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}


export function normalizeMaxStaleAge(value: number | undefined): number {
  const result = value ?? 3_600;
  if (!Number.isInteger(result) || result < 1 || result > 7 * 24 * 3_600) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "max stale age must be an integer between 1 second and 7 days");
  }
  return result;
}

export function manifestTool(runtime: ProjectContextRuntime): "claude" | "codewith" | "codex" {
  return runtime === "agents" ? "codex" : runtime;
}

export function runtimeUsesNativeImports(runtime: ProjectContextRuntime, codewithNativeImports: boolean | undefined): boolean {
  if (runtime === "claude") return true;
  if (runtime === "agents") return false;
  return codewithNativeImports === true || process.env[CODEWITH_NATIVE_IMPORTS_ENV] === "1" || process.env[CODEWITH_NATIVE_IMPORTS_ENV] === "true";
}

export function ageInSeconds(generatedAt: string, now: Date): number {
  const deltaMs = now.getTime() - Date.parse(generatedAt);
  if (deltaMs < 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_INVALID", "bundle generated_at is in the future");
  }
  return Math.floor(deltaMs / 1_000);
}

export function staleCacheAgeInSeconds(timestamp: string, now: Date, field: string): number {
  const deltaMs = now.getTime() - Date.parse(timestamp);
  if (deltaMs < 0) {
    throw new ProjectContextError("PROJECT_CONTEXT_CACHE_INVALID", `${field} is in the future`);
  }
  return Math.floor(deltaMs / 1_000);
}

export function statusLabel(status: ProjectContextStatus, ageSeconds: number): string {
  if (status === "fresh") return "fresh";
  if (status === "stale-cache") return `stale cache (age ${ageSeconds}s)`;
  return `stale source (age ${ageSeconds}s)`;
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function inlineNullable(value: string | null): string {
  return value === null ? "`none`" : inlineCode(value);
}

export function inlineCode(value: string): string {
  const encoded = JSON.stringify(value).slice(1, -1).replace(/`/g, "\\u0060");
  return `\`${encoded}\``;
}

export function escapeText(value: string): string {
  return value.replace(/[<>]/g, "");
}

export function preferredEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function relativePosix(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

export function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function linesWithOffsets(content: string): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = [];
  const re = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[0] === "" && match.index === content.length) break;
    result.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

export function lineContentEnd(line: { text: string; start: number; end: number }): number {
  if (line.text.endsWith("\r\n")) return line.end - 2;
  if (line.text.endsWith("\n") || line.text.endsWith("\r")) return line.end - 1;
  return line.end;
}
