import type { ApplyResult, Config, Profile } from "../types/index.js";

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  cursor: number;
  next_cursor: number | null;
  has_more: boolean;
}

export interface PagedPayload<T> extends Page<T> {
  hint?: string;
}

export function parseLimit(value: unknown, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function parseCursor(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function paginate<T>(
  items: T[],
  opts: { limit?: unknown; cursor?: unknown; defaultLimit?: number; maxLimit?: number } = {},
): Page<T> {
  const limit = parseLimit(opts.limit, opts.defaultLimit ?? DEFAULT_LIST_LIMIT, opts.maxLimit ?? MAX_LIST_LIMIT);
  const cursor = parseCursor(opts.cursor);
  const pageItems = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + pageItems.length < items.length ? cursor + pageItems.length : null;
  return {
    items: pageItems,
    total: items.length,
    limit,
    cursor,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
  };
}

export function pagedPayload<T>(
  items: T[],
  opts: { limit?: unknown; cursor?: unknown; defaultLimit?: number; maxLimit?: number; hint?: string } = {},
): PagedPayload<T> {
  return {
    ...paginate(items, opts),
    hint: opts.hint,
  };
}

export function truncateText(value: string | null | undefined, max = 80): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

export function truncateMiddle(value: string | null | undefined, max = 80): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const head = Math.ceil((max - 3) * 0.55);
  const tail = Math.floor((max - 3) * 0.45);
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

export interface ConfigSummary {
  id: string;
  slug: string;
  name: string;
  category: Config["category"];
  agent: Config["agent"];
  kind: Config["kind"];
  format: Config["format"];
  target_path: string | null;
  output_count: number;
  version: number;
  is_template: boolean;
  updated_at?: string;
  description?: string | null;
  tags?: string[];
  outputs?: Config["outputs"];
}

export function summarizeConfig(config: Config, opts: { verbose?: boolean } = {}): ConfigSummary {
  const summary: ConfigSummary = {
    id: config.id,
    slug: config.slug,
    name: config.name,
    category: config.category,
    agent: config.agent,
    kind: config.kind,
    format: config.format,
    target_path: config.target_path,
    output_count: config.outputs.length,
    version: config.version,
    is_template: config.is_template,
  };
  if (opts.verbose) {
    summary.updated_at = config.updated_at;
    summary.description = config.description;
    summary.tags = config.tags;
    summary.outputs = config.outputs;
  }
  return summary;
}

export interface ProfileSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  selector_count: number;
  variable_count: number;
  created_at?: string;
  updated_at?: string;
  selectors?: Profile["selectors"];
  variables?: Profile["variables"];
}

export function summarizeProfile(profile: Profile, opts: { verbose?: boolean } = {}): ProfileSummary {
  const selectorCount =
    (profile.selectors.os?.length ?? 0) +
    (profile.selectors.arch?.length ?? 0) +
    (profile.selectors.hostnames?.length ?? 0);
  const summary: ProfileSummary = {
    id: profile.id,
    slug: profile.slug,
    name: profile.name,
    description: opts.verbose ? profile.description : truncateText(profile.description, 80),
    selector_count: selectorCount,
    variable_count: Object.keys(profile.variables).length,
  };
  if (opts.verbose) {
    summary.created_at = profile.created_at;
    summary.updated_at = profile.updated_at;
    summary.selectors = profile.selectors;
    summary.variables = profile.variables;
  }
  return summary;
}

export interface ApplyResultSummary {
  config_id: string;
  path: string;
  dry_run: boolean;
  changed: boolean;
  agent?: ApplyResult["agent"];
  transform?: ApplyResult["transform"];
  output_count: number;
  outputs?: ApplyResultSummary[];
}

export function summarizeApplyResult(result: ApplyResult): ApplyResultSummary {
  return {
    config_id: result.config_id,
    path: result.path,
    dry_run: result.dry_run,
    changed: result.changed,
    agent: result.agent,
    transform: result.transform,
    output_count: result.outputs?.length ?? 0,
    outputs: result.outputs?.map(summarizeApplyResult),
  };
}
