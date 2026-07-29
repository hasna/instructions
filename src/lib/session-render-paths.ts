import { homedir } from "node:os";
import { isAbsolute, join, parse, posix, resolve } from "node:path";
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

export function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "instruction";
}


export function getRawStoreRoot(): string {
  return resolve(process.env[RAW_STORE_ROOT_ENV] || join(process.env["HOME"] || homedir(), ".hasna", "configs"));
}

export function defaultTargetHome(tool: SessionRenderTool, profile: string, sessionId?: string): string {
  return join(getRawStoreRoot(), "sessions", tool, slug(profile), slug(sessionId || "latest"));
}

export function joinTarget(targetHome: string, relativePath: string): string {
  const safeTargetHome = assertSafeTargetRoot(targetHome);
  const safeRelativePath = assertSafeRelativePath(relativePath);
  return join(safeTargetHome, ...safeRelativePath.split("/"));
}


export function getHomeDir(): string {
  return process.env["CONFIGS_HOME"] || process.env["HOME"] || homedir();
}

export function cleanSessionPathInput(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function resolveSessionPath(path: string): string {
  const cleaned = cleanSessionPathInput(path);
  if (!cleaned) throw new Error("Session render path cannot be empty.");
  const home = getHomeDir();
  if (cleaned === "~") return resolve(home);
  if (cleaned.startsWith("~/")) return resolve(home, cleaned.slice(2));
  if (cleaned === "{{HOME}}" || cleaned === "${HOME}") return resolve(home);
  if (cleaned.startsWith("{{HOME}}/")) return resolve(home, cleaned.slice("{{HOME}}/".length));
  if (cleaned.startsWith("${HOME}/")) return resolve(home, cleaned.slice("${HOME}/".length));
  return resolve(cleaned);
}

export function assertSafeRelativePath(relativePath: string): string {
  if (!relativePath.trim()) throw new Error("Session render relative path cannot be empty.");
  if (relativePath.includes("\\")) throw new Error(`Session render relative path must use POSIX separators: ${relativePath}`);
  const normalized = posix.normalize(relativePath);
  if (normalized === "." || posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Session render relative path escapes target root: ${relativePath}`);
  }
  return normalized;
}

export function assertSafeTargetRoot(targetHome: string): string {
  if (!isAbsolute(targetHome)) throw new Error(`Session render target must be an absolute path: ${targetHome}`);
  const normalized = resolve(targetHome);
  if (normalized === parse(normalized).root) {
    throw new Error(`Session render target cannot be the filesystem root: ${targetHome}`);
  }
  return normalized;
}

