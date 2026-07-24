export const CODEWITH_NATIVE_IMPORTS_ENV = "HASNA_CONFIGS_CODEWITH_NATIVE_IMPORTS";
export const SESSION_RENDER_MANAGED_MARKER = "Managed by @hasna/configs session render";
export const SESSION_RENDER_SCHEMA = "hasna.configs.session-render/v1";

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
