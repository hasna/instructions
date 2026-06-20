import { describe, expect, test } from "bun:test";
import type { Config, ConfigOutput } from "../types/index";
import {
  applyTransform,
  buildCursorMdc,
  stripClaudeOnlySections,
  transformSkillContent,
} from "./transforms";

const baseConfig: Config = {
  id: "cfg-main",
  name: "Claude",
  slug: "claude-claude-md",
  kind: "file",
  category: "rules",
  agent: "claude",
  target_path: "~/.claude/CLAUDE.md",
  format: "markdown",
  content: [
    "# System Prompt",
    "",
    "Shared guidance.",
    "",
    "<!-- claude-only:start -->",
    "Claude Code private setup.",
    "<!-- claude-only:end -->",
  ].join("\n"),
  description: null,
  tags: [],
  is_template: false,
  outputs: [],
  version: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  synced_at: null,
};

const ruleConfig: Config = {
  ...baseConfig,
  id: "cfg-rule",
  name: "claude-rules-security.md",
  slug: "claude-rules-security-md",
  target_path: "~/.claude/rules/security.md",
  content: "# Security\n\nNever commit secrets.",
};

describe("transforms", () => {
  test("codex flatten strips Claude-only blocks and inlines Claude rules", () => {
    const output: ConfigOutput = {
      agent: "codex",
      target_path: "~/.codex/AGENTS.md",
      transform: "codex-flat",
    };

    const transformed = applyTransform(baseConfig, output, { configs: [baseConfig, ruleConfig] });

    expect(transformed).toContain("# System Prompt");
    expect(transformed).toContain("Shared guidance.");
    expect(transformed).toContain("## Rules");
    expect(transformed).toContain("# Security");
    expect(transformed).not.toContain("Claude Code private setup");
  });

  test("opencode flatten uses AGENTS.md style and inlines Claude rules", () => {
    const output: ConfigOutput = {
      agent: "opencode",
      target_path: "~/.config/opencode/AGENTS.md",
      transform: "opencode-flat",
    };

    const transformed = applyTransform(baseConfig, output, { configs: [baseConfig, ruleConfig] });

    expect(transformed).toContain("# System Prompt");
    expect(transformed).toContain("## Rules");
    expect(transformed).toContain("# Security");
    expect(transformed).not.toContain("Claude Code private setup");
  });

  test("cursor transform emits MDC frontmatter", () => {
    const mdc = buildCursorMdc(ruleConfig);

    expect(mdc).toStartWith("---\n");
    expect(mdc).toContain('description: "claude-rules-security.md"');
    expect(mdc).toContain('globs: ["**/*"]');
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain("# Security");
  });

  test("skill transform removes Claude-only metadata and neutralizes Claude tool references", () => {
    const skill = [
      "---",
      "name: sample",
      "user_invocable: true",
      "---",
      "Use the Agent tool, TodoWrite, Read/Edit, and Bash.",
    ].join("\n");

    const transformed = transformSkillContent(skill);

    expect(transformed).not.toContain("user_invocable");
    expect(transformed).not.toContain("Agent tool");
    expect(transformed).not.toContain("TodoWrite");
    expect(transformed).not.toContain("Read/Edit");
    expect(transformed).not.toContain("Bash");
    expect(transformed).toContain("delegate through the available MCP or agent orchestration tools");
    expect(transformed).toContain("track tasks with the agent's native task mechanism");
    expect(transformed).toContain("read and edit files with the available filesystem tools");
    expect(transformed).toContain("run shell commands with the available terminal tool");
  });

  test("stripClaudeOnlySections removes marked blocks and Claude-only headings", () => {
    const content = [
      "# Shared",
      "",
      "Keep this.",
      "",
      "## Claude-only",
      "Drop this.",
      "",
      "## Shared Again",
      "Keep this too.",
    ].join("\n");

    const stripped = stripClaudeOnlySections(content);

    expect(stripped).toContain("Keep this.");
    expect(stripped).toContain("Keep this too.");
    expect(stripped).not.toContain("Drop this.");
  });
});
