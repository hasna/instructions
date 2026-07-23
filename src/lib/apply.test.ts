import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { applyConfig, applyConfigs, applyConfigsWithReport } from "./apply";
import { ANTIGRAVITY_RULE_FILE_CHAR_LIMIT } from "./session-render";
import { detectMachineContext, resolveProfileVariables } from "./machine";
import type { ConfigAgent } from "../types";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("applyConfig", () => {
  test("writes content to target_path", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "test.md");
    const c = createConfig({ name: "T", category: "rules", content: "hello", target_path: target }, db);
    await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(readFileSync(target, "utf-8")).toBe("hello");
  });

  test("dry-run does not write", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "dry.md");
    const c = createConfig({ name: "T", category: "rules", content: "hello", target_path: target }, db);
    const result = await applyConfig(c, { dryRun: true, store: new LocalConfigStore(db) });
    expect(existsSync(target)).toBe(false);
    expect(result.dry_run).toBe(true);
  });

  test("creates parent directories", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "deep", "nested", "file.txt");
    const c = createConfig({ name: "T", category: "tools", content: "data", target_path: target }, db);
    await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(existsSync(target)).toBe(true);
  });

  test("returns changed=false when content identical", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "same.txt");
    writeFileSync(target, "same");
    const c = createConfig({ name: "T", category: "tools", content: "same", target_path: target }, db);
    const result = await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(result.changed).toBe(false);
  });

  test("returns previous_content when overwriting", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "existing.txt");
    writeFileSync(target, "old content");
    const c = createConfig({ name: "T", category: "tools", content: "new content", target_path: target }, db);
    const result = await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(result.previous_content).toBe("old content");
    expect(result.new_content).toBe("new content");
  });

  test("throws for reference kind", async () => {
    const db = getDatabase();
    const c = createConfig({ name: "Ref", category: "workspace", content: "doc", kind: "reference" }, db);
    expect(applyConfig(c, { store: new LocalConfigStore(db) })).rejects.toThrow("reference");
  });

  test("renders machine-aware variables in content and target path", async () => {
    const db = getDatabase();
    const machine = detectMachineContext({
      hostname: "macos-node-a",
      os: "Darwin",
      arch: "arm64",
      home_dir: tmpDir,
      bun_path: "/opt/homebrew/bin/bun",
    });
    const vars = resolveProfileVariables({
      variables: {
        WORKSPACE_ROOT: "{{HOME_DIR}}/Workspace",
      },
    }, machine);
    const c = createConfig({
      name: "Machine Aware",
      category: "tools",
      content: "workspace={{WORKSPACE_ROOT}}",
      target_path: join(tmpDir, "{{HOSTNAME}}.txt"),
      is_template: true,
    }, db);
    const result = await applyConfig(c, { store: new LocalConfigStore(db), vars });
    expect(result.path).toBe(join(tmpDir, "macos-node-a.txt"));
    expect(readFileSync(result.path, "utf-8")).toBe(`workspace=${tmpDir}/Workspace`);
  });

  test("applies transformed outputs for canonical Claude configs", async () => {
    const db = getDatabase();
    const claudeTarget = join(tmpDir, ".claude", "CLAUDE.md");
    const codexTarget = join(tmpDir, ".codex", "AGENTS.md");
    const codewithTarget = join(tmpDir, ".codewith", "CODEWITH.md");
    const opencodeTarget = join(tmpDir, ".config", "opencode", "AGENTS.md");
    const aicopilotTarget = join(tmpDir, ".config", "aicopilot", "AGENTS.md");
    const cursorTarget = join(tmpDir, ".cursor", "rules", "claude.mdc");

    createConfig({
      name: "claude-rules-security.md",
      category: "rules",
      agent: "claude",
      content: "# Security\n\nNever commit secrets.",
      target_path: join(tmpDir, ".claude", "rules", "security.md"),
      format: "markdown",
    }, db);
    const c = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: [
        "# Claude Prompt",
        "",
        "Shared system guidance.",
        "",
        "<!-- claude-only:start -->",
        "Claude-specific local detail.",
        "<!-- claude-only:end -->",
      ].join("\n"),
      target_path: claudeTarget,
      format: "markdown",
      outputs: [
        { agent: "codex", target_path: codexTarget, transform: "codex-flat" },
        { agent: "codewith", target_path: codewithTarget, transform: "codex-flat" },
        { agent: "opencode", target_path: opencodeTarget, transform: "opencode-flat" },
        { agent: "aicopilot", target_path: aicopilotTarget, transform: "opencode-flat" },
        { agent: "cursor", target_path: cursorTarget, transform: "cursor-mdc" },
      ],
    }, db);

    const result = await applyConfig(c, { store: new LocalConfigStore(db) });

    expect(result.outputs?.length).toBe(5);
    expect(readFileSync(claudeTarget, "utf-8")).toContain("Claude-specific local detail");
    for (const target of [codexTarget, codewithTarget, opencodeTarget, aicopilotTarget]) {
      const content = readFileSync(target, "utf-8");
      expect(content).toContain("Shared system guidance.");
      expect(content).toContain("# Security");
      expect(content).not.toContain("Claude-specific local detail");
    }
    const cursor = readFileSync(cursorTarget, "utf-8");
    expect(cursor).toContain("alwaysApply: true");
    expect(cursor).toContain("Shared system guidance.");
  });

  test("skips oversized Antigravity legacy outputs before apply validation", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const antigravityTarget = join(tmpDir, ".gemini", "GEMINI.md");
    const c = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "x".repeat(ANTIGRAVITY_RULE_FILE_CHAR_LIMIT + 1),
      target_path: join(tmpDir, ".claude", "CLAUDE.md"),
      format: "markdown",
      outputs: [
        { agent: "antigravity", target_path: antigravityTarget, transform: "codex-flat" },
      ],
    }, db);

    const report = await applyConfigsWithReport([c], { store: new LocalConfigStore(db) });
    expect(report.failures).toEqual([]);
    expect(report.skipped.some((entry) => entry.path === antigravityTarget)).toBe(true);
    expect(existsSync(antigravityTarget)).toBe(false);
  });

  test("direct apply refuses session-renderer-owned instruction entrypoints", async () => {
    process.env["CONFIGS_HOME"] = tmpDir;
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const ownedConfigs = [
      createConfig({
        name: "Claude Legacy Entrypoint",
        category: "rules",
        agent: "claude",
        content: "legacy claude",
        target_path: "~/.claude/CLAUDE.md",
      }, db),
      createConfig({
        name: "Antigravity Legacy Entrypoint",
        category: "rules",
        agent: "antigravity",
        content: "legacy antigravity",
        target_path: "~/.gemini/GEMINI.md",
      }, db),
    ];

    for (const config of ownedConfigs) {
      await expect(applyConfig(config, { store })).rejects.toThrow("instructions-session-renderer");
    }
    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(tmpDir, ".gemini", "GEMINI.md"))).toBe(false);
  });

  test("bulk apply skips retired Gemini rows", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const geminiTarget = join(tmpDir, ".gemini", "GEMINI.md");
    const antigravityTarget = join(tmpDir, ".gemini", "ANTIGRAVITY.md");
    const stale = createConfig({
      name: "Stale Gemini Global Rules",
      category: "rules",
      agent: "gemini" as ConfigAgent,
      content: "retired gemini content",
      target_path: "~/.gemini/GEMINI.md",
      format: "markdown",
    }, db);
    const active = createConfig({
      name: "Active Antigravity Rules",
      category: "rules",
      agent: "antigravity",
      content: "active antigravity content",
      target_path: "~/.gemini/ANTIGRAVITY.md",
      format: "markdown",
    }, db);

    const results = await applyConfigs([stale, active], { store: new LocalConfigStore(db) });

    expect(results.length).toBe(0);
    expect(existsSync(geminiTarget)).toBe(false);
    expect(existsSync(antigravityTarget)).toBe(false);
  });

  test("refuses to apply stale rows targeting generated fan-out outputs", async () => {
    const db = getDatabase();
    const codexTarget = join(tmpDir, ".codex", "AGENTS.md");
    const canonical = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: join(tmpDir, ".claude", "CLAUDE.md"),
      format: "markdown",
      outputs: [
        { agent: "codex", target_path: codexTarget, transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-codex-generated",
      category: "rules",
      agent: "codex",
      content: "# stale",
      target_path: codexTarget,
      format: "markdown",
    }, db);

    await applyConfig(canonical, { store: new LocalConfigStore(db) });
    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");

    expect(readFileSync(codexTarget, "utf-8")).toContain("Generated");
    expect(readFileSync(codexTarget, "utf-8")).not.toContain("# stale");
  });

  test("refuses generated output rows even when target path uses an equivalent absolute path", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const canonical = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
      outputs: [
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-aicopilot-generated-absolute",
      category: "rules",
      agent: "aicopilot",
      content: "# absolute stale",
      target_path: join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"),
      format: "markdown",
    }, db);

    await applyConfig(canonical, { store: new LocalConfigStore(db) });
    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");

    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).toContain("Generated");
    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).not.toContain("absolute stale");
  });

  test("refuses generated output rows after rendering machine-aware target paths", async () => {
    const db = getDatabase();
    const generatedTarget = join(tmpDir, "generated.md");
    createConfig({
      name: "Canonical Source",
      category: "rules",
      agent: "claude",
      content: "# Canonical\n",
      target_path: join(tmpDir, "canonical.md"),
      outputs: [
        { agent: "codex", target_path: generatedTarget, transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "Rendered Stale Writer",
      category: "rules",
      agent: "codex",
      content: "# stale\n",
      target_path: "{{HOME_DIR}}/generated.md",
    }, db);

    await expect(applyConfig(stale, {
      store: new LocalConfigStore(db),
      vars: { HOME_DIR: tmpDir },
    })).rejects.toThrow("generated output");
    expect(existsSync(generatedTarget)).toBe(false);
  });

  test("refuses generated output rows when target path reaches the same file through a symlink", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const linkHome = join(tmpDir, "link-home");
    symlinkSync(tmpDir, linkHome, "dir");
    const canonical = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
      outputs: [
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-aicopilot-generated-symlink",
      category: "rules",
      agent: "aicopilot",
      content: "# symlink stale",
      target_path: join(linkHome, ".config", "aicopilot", "AICOPILOT.md"),
      format: "markdown",
    }, db);

    await applyConfig(canonical, { store: new LocalConfigStore(db) });
    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");

    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).toContain("Generated");
    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).not.toContain("symlink stale");
  });

  test("refuses symlink stale rows before the generated output directory exists", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const linkHome = join(tmpDir, "link-home");
    symlinkSync(tmpDir, linkHome, "dir");
    createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
      outputs: [
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-aicopilot-generated-symlink-before-dir",
      category: "rules",
      agent: "aicopilot",
      content: "# symlink stale",
      target_path: join(linkHome, ".config", "aicopilot", "AICOPILOT.md"),
      format: "markdown",
    }, db);

    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");
    expect(existsSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"))).toBe(false);
  });
});
