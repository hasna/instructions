// Config kinds
export const CONFIG_KINDS = ["file", "reference"] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

// Config categories
export const CONFIG_CATEGORIES = [
  "agent",
  "rules",
  "mcp",
  "shell",
  "secrets_schema",
  "workspace",
  "git",
  "tools",
] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

// Config agents
export const CONFIG_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "zsh",
  "git",
  "npm",
  "global",
] as const;
export type ConfigAgent = (typeof CONFIG_AGENTS)[number];

// Config formats
export const CONFIG_FORMATS = [
  "text",
  "json",
  "toml",
  "yaml",
  "markdown",
  "ini",
] as const;
export type ConfigFormat = (typeof CONFIG_FORMATS)[number];

// Core config entity
export interface Config {
  id: string;
  name: string;
  slug: string;
  kind: ConfigKind;
  category: ConfigCategory;
  agent: ConfigAgent;
  target_path: string | null; // null for reference kind
  format: ConfigFormat;
  content: string;
  description: string | null;
  tags: string[];
  is_template: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

// Raw DB row (tags as JSON string)
export interface ConfigRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  category: string;
  agent: string;
  target_path: string | null;
  format: string;
  content: string;
  description: string | null;
  tags: string;
  is_template: number;
  version: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface CreateConfigInput {
  name: string;
  kind?: ConfigKind;
  category: ConfigCategory;
  agent?: ConfigAgent;
  target_path?: string | null;
  format?: ConfigFormat;
  content: string;
  description?: string;
  tags?: string[];
  is_template?: boolean;
}

export interface UpdateConfigInput {
  name?: string;
  kind?: ConfigKind;
  category?: ConfigCategory;
  agent?: ConfigAgent;
  target_path?: string | null;
  format?: ConfigFormat;
  content?: string;
  description?: string;
  tags?: string[];
  is_template?: boolean;
  synced_at?: string | null;
}

export interface ConfigFilter {
  category?: ConfigCategory;
  agent?: ConfigAgent;
  kind?: ConfigKind;
  tags?: string[];
  search?: string;
  is_template?: boolean;
}

// Config snapshot (version history)
export interface ConfigSnapshot {
  id: string;
  config_id: string;
  content: string;
  version: number;
  created_at: string;
}

// Profile (named bundle of configs)
export interface Profile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  selectors: ProfileSelector;
  variables: ProfileVariables;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  selectors: string;
  variables: string;
  created_at: string;
  updated_at: string;
}

export interface ProfileSelector {
  os?: string[];
  arch?: string[];
  hostnames?: string[];
}

export type ProfileVariables = Record<string, string>;

export interface CreateProfileInput {
  name: string;
  description?: string;
  selectors?: ProfileSelector;
  variables?: ProfileVariables;
}

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  selectors?: ProfileSelector;
  variables?: ProfileVariables;
}

// Profile ↔ Config join
export interface ProfileConfig {
  profile_id: string;
  config_id: string;
  order: number;
}

// Machine (where configs were applied)
export interface Machine {
  id: string;
  hostname: string;
  os: string | null;
  arch: string | null;
  last_applied_at: string | null;
  created_at: string;
}

export interface MachineContext extends Machine {
  os_family: string;
  home_dir: string;
  workspace_root: string;
  bun_bin_dir: string;
  bun_path: string;
  path_prefix: string;
}

// Apply result
export interface ApplyResult {
  config_id: string;
  path: string;
  previous_content: string | null;
  new_content: string;
  dry_run: boolean;
  changed: boolean;
}

// Sync result
export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: string[];
}

// Export/import
export interface ExportManifest {
  version: string;
  exported_at: string;
  configs: Array<Omit<Config, "content">>;
}

// Error types
export class ConfigNotFoundError extends Error {
  constructor(id: string) {
    super(`Config not found: ${id}`);
    this.name = "ConfigNotFoundError";
  }
}

export class ProfileNotFoundError extends Error {
  constructor(id: string) {
    super(`Profile not found: ${id}`);
    this.name = "ProfileNotFoundError";
  }
}

export class ConfigApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigApplyError";
  }
}

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderError";
  }
}
