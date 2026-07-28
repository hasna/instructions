export const CODEWITH_NATIVE_IMPORTS_ENV = "HASNA_CONFIGS_CODEWITH_NATIVE_IMPORTS";
export const SESSION_RENDER_MANAGED_MARKER = "Managed by @hasna/configs session render";
export const SESSION_RENDER_SCHEMA = "hasna.configs.session-render/v1";

/**
 * The renderer's private namespace inside every session target home. Everything
 * the session renderer owns that is not a provider-native file lives here, so
 * these constants are the single source of truth for both rendering and the
 * `apply` ownership guard.
 */
export const SESSION_RENDER_MANAGED_NAMESPACE = ".hasna";
export const SESSION_RENDER_INSTRUCTIONS_MANAGED_DIR = `${SESSION_RENDER_MANAGED_NAMESPACE}/instructions`;
export const SESSION_RENDER_MANIFEST_RELATIVE_PATH = `${SESSION_RENDER_MANAGED_NAMESPACE}/session-render-manifest.json`;
export const SESSION_RENDER_SNAPSHOT_RELATIVE_DIR = `${SESSION_RENDER_MANAGED_NAMESPACE}/session-render-snapshots`;

export const SESSION_INSTRUCTION_LAYERS = [
  "global",
  "tool",
  "account",
  "machine",
  "division",
  "workspace",
  "repo",
  "path",
  "agent",
  "session",
  "local",
] as const;
