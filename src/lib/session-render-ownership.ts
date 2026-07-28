import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse, relative, sep } from "node:path";
import {
  SESSION_RENDERER_OWNER_ID,
  SESSION_RENDER_EXCLUSIVE_MANAGED_PATHS,
  SESSION_RENDER_MANIFEST_RELATIVE_PATH,
  SESSION_RENDER_SCHEMA,
  type SessionRenderManifest,
} from "./session-render.js";

/**
 * How far above a target path we look for the session target home that claims
 * it. Rendered fragments sit at most a handful of levels below their home
 * (`<home>/.hasna/instructions/rules/<source>/rules/<file>.md`); the bound keeps
 * a pathological path from walking the whole filesystem.
 */
const MANIFEST_ANCESTOR_LIMIT = 24;

const MANAGED_PATH_SEGMENTS: readonly (readonly string[])[] = SESSION_RENDER_EXCLUSIVE_MANAGED_PATHS
  .map((managedPath) => managedPath.split("/").filter(Boolean));

interface CachedManifest {
  mtimeMs: number;
  size: number;
  relativePaths: Set<string>;
}

const manifestCache = new Map<string, CachedManifest>();

function toSegments(absolutePath: string): string[] {
  return absolutePath.replaceAll("\\", "/").split("/").filter(Boolean);
}

/**
 * True when the path sits inside (or is) a directory the session renderer owns
 * exclusively. Matching is on whole path segments and is home-agnostic on
 * purpose: the renderer's target homes are provider profile homes
 * (`~/.claude`, `~/.codex`, `~/.hasna/accounts/profiles/<tool>/<account>`, …),
 * not the config home, so anchoring the check to a known home list is exactly
 * the gap this guard closes.
 */
export function pathIsSessionRenderManagedDir(absolutePath: string): boolean {
  const segments = toSegments(absolutePath);
  return MANAGED_PATH_SEGMENTS.some((managed) => {
    if (managed.length === 0 || managed.length > segments.length) return false;
    for (let start = 0; start + managed.length <= segments.length; start += 1) {
      if (managed.every((segment, offset) => segments[start + offset] === segment)) return true;
    }
    return false;
  });
}

function readManifestRelativePaths(manifestPath: string): Set<string> | null {
  let stats: ReturnType<typeof statSync>;
  try {
    if (!existsSync(manifestPath)) return null;
    stats = statSync(manifestPath);
  } catch {
    return null;
  }
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.relativePaths;
  }
  let manifest: SessionRenderManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SessionRenderManifest;
  } catch {
    return null;
  }
  if (manifest?.schema !== SESSION_RENDER_SCHEMA || !Array.isArray(manifest.files)) return null;
  const writerId = manifest.targetOwner?.writer?.id;
  if (writerId !== undefined && writerId !== SESSION_RENDERER_OWNER_ID) return null;
  const relativePaths = new Set(
    manifest.files
      .map((file) => file?.relativePath)
      .filter((relativePath): relativePath is string => typeof relativePath === "string")
      .map((relativePath) => relativePath.replaceAll("\\", "/")),
  );
  manifestCache.set(manifestPath, { mtimeMs: stats.mtimeMs, size: stats.size, relativePaths });
  return relativePaths;
}

/**
 * True when some ancestor of the path is a session target home whose render
 * manifest claims that exact file. This is the renderer's own record of what it
 * wrote, so it covers provider-native outputs (`CLAUDE.md`, `AGENTS.md`,
 * `opencode.json`, `.cursor/rules/*.mdc`) without statically reserving
 * directories that the config fan-out also writes.
 */
export function sessionRenderManifestClaimsPath(absolutePath: string): boolean {
  const root = parse(absolutePath).root;
  let home = dirname(absolutePath);
  for (let depth = 0; depth < MANIFEST_ANCESTOR_LIMIT; depth += 1) {
    const manifestPath = join(home, ...SESSION_RENDER_MANIFEST_RELATIVE_PATH.split("/"));
    const relativePaths = readManifestRelativePaths(manifestPath);
    if (relativePaths) {
      const claimed = relative(home, absolutePath).split(sep).join("/");
      if (relativePaths.has(claimed)) return true;
    }
    const parent = dirname(home);
    if (parent === home || home === root) break;
    home = parent;
  }
  return false;
}

/**
 * The session renderer owns a path when it is inside one of the renderer's own
 * managed directories, or when a target home's render manifest claims it.
 */
export function sessionRenderOwnsPath(absolutePath: string): boolean {
  return pathIsSessionRenderManagedDir(absolutePath) || sessionRenderManifestClaimsPath(absolutePath);
}
