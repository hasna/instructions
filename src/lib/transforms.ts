import { basename, extname } from "node:path";
import type { Config, ConfigOutput } from "../types/index.js";

export interface TransformContext {
  configs?: Config[];
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function headingLevel(line: string): number | null {
  const m = line.match(/^(#{1,6})\s+/);
  return m ? m[1]!.length : null;
}

export function stripClaudeOnlySections(content: string): string {
  const withoutMarkedBlocks = content.replace(
    /<!--\s*claude-only:start\s*-->[\s\S]*?<!--\s*claude-only:end\s*-->/gi,
    ""
  );

  const lines = withoutMarkedBlocks.split("\n");
  const kept: string[] = [];
  let droppingUntilLevel: number | null = null;

  for (const line of lines) {
    const level = headingLevel(line);
    if (level !== null && droppingUntilLevel !== null && level <= droppingUntilLevel) {
      droppingUntilLevel = null;
    }

    if (droppingUntilLevel !== null) continue;

    if (/^#{1,6}\s+.*claude(?:\s+code)?[-\s]+only\b/i.test(line)) {
      droppingUntilLevel = level ?? 1;
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isClaudeRuleConfig(source: Config, candidate: Config): boolean {
  if (candidate.id === source.id) return false;
  if (candidate.agent !== "claude" || candidate.category !== "rules") return false;
  return !!candidate.target_path?.includes("/rules/");
}

function ruleLabel(config: Config): string {
  const file = config.target_path ? basename(config.target_path) : config.name;
  return file.replace(/\.(md|mdc|markdown)$/i, "");
}

function claudeRules(source: Config, context: TransformContext): Config[] {
  return (context.configs ?? [])
    .filter((config) => isClaudeRuleConfig(source, config))
    .sort((a, b) => (a.target_path ?? a.name).localeCompare(b.target_path ?? b.name));
}

function flattenWithRules(source: Config, context: TransformContext): string {
  const parts = [stripClaudeOnlySections(source.content)];
  const rules = claudeRules(source, context)
    .map((rule) => ({ rule, content: stripClaudeOnlySections(rule.content) }))
    .filter(({ content }) => Boolean(content))
    .map(({ rule, content }) => `### ${ruleLabel(rule)}\n\n${content}`);

  if (rules.length > 0) {
    parts.push(`## Rules\n\n${rules.join("\n\n")}`);
  }

  return ensureTrailingNewline(parts.filter(Boolean).join("\n\n"));
}

export function buildCodexAgentsMd(source: Config, context: TransformContext = {}): string {
  return flattenWithRules(source, context);
}

export function buildOpenCodeAgentsMd(source: Config, context: TransformContext = {}): string {
  return flattenWithRules(source, context);
}

export function buildCursorMdc(source: Config): string {
  const stem = source.target_path
    ? basename(source.target_path, extname(source.target_path))
    : source.slug;
  const description = source.name || stem;
  return ensureTrailingNewline([
    "---",
    `description: ${yamlQuote(description)}`,
    'globs: ["**/*"]',
    "alwaysApply: true",
    "---",
    "",
    stripClaudeOnlySections(source.content),
  ].join("\n"));
}

export function transformSkillContent(content: string): string {
  return ensureTrailingNewline(content
    .split("\n")
    .filter((line) => !/^\s*user_invocable\s*:/i.test(line))
    .join("\n")
    .replace(/\bAgent tool\b/g, "delegate through the available MCP or agent orchestration tools")
    .replace(/\bTodoWrite\b/g, "track tasks with the agent's native task mechanism")
    .replace(/\bRead\/Edit\b/g, "read and edit files with the available filesystem tools")
    .replace(/\bRead\b/g, "read files with the available filesystem tools")
    .replace(/\bEdit\b/g, "edit files with the available filesystem tools")
    .replace(/\bBash\b/g, "run shell commands with the available terminal tool")
    .trim());
}

export function applyTransform(
  source: Config,
  output: ConfigOutput,
  context: TransformContext = {}
): string {
  switch (output.transform) {
    case "passthrough":
    case "claude-passthrough":
      return ensureTrailingNewline(source.content);
    case "codex-flat":
      return buildCodexAgentsMd(source, context);
    case "opencode-flat":
      return buildOpenCodeAgentsMd(source, context);
    case "cursor-mdc":
      return buildCursorMdc(source);
    case "skill-neutral":
      return transformSkillContent(source.content);
  }
}
