import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import type { Config } from "../types/index";
import { applyConfigs, applyConfigsWithReport, previewConfigs } from "./apply";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-batch-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("applyConfigs (batch)", () => {
  test("applies multiple configs to disk", async () => {
    const db = getDatabase();
    const c1 = createConfig({ name: "A", category: "tools", content: "aaa", target_path: join(tmpDir, "a.txt") }, db);
    const c2 = createConfig({ name: "B", category: "tools", content: "bbb", target_path: join(tmpDir, "b.txt") }, db);
    const results = await applyConfigs([c1, c2], { store: new LocalConfigStore(db) });
    expect(results.length).toBe(2);
    expect(readFileSync(join(tmpDir, "a.txt"), "utf-8")).toBe("aaa");
    expect(readFileSync(join(tmpDir, "b.txt"), "utf-8")).toBe("bbb");
  });

  test("skips reference kind configs", async () => {
    const db = getDatabase();
    const file = createConfig({ name: "File", category: "tools", content: "data", target_path: join(tmpDir, "f.txt") }, db);
    const ref = createConfig({ name: "Ref", category: "workspace", content: "doc", kind: "reference" }, db);
    const results = await applyConfigs([file, ref], { store: new LocalConfigStore(db) });
    expect(results.length).toBe(1); // only file applied
    expect(results[0]!.config_id).toBe(file.id);
  });

  test("dry-run returns results without writing", async () => {
    const db = getDatabase();
    const c = createConfig({ name: "Dry", category: "tools", content: "test", target_path: join(tmpDir, "dry.txt") }, db);
    const results = await applyConfigs([c], { dryRun: true, store: new LocalConfigStore(db) });
    expect(results.length).toBe(1);
    expect(results[0]!.dry_run).toBe(true);
    expect(existsSync(join(tmpDir, "dry.txt"))).toBe(false);
  });

  test("aborts the entire batch before writes when multiple configs target one file", async () => {
    const db = getDatabase();
    const sharedTarget = join(tmpDir, "shared.txt");
    const independentTarget = join(tmpDir, "independent.txt");
    writeFileSync(sharedTarget, "shared before");
    writeFileSync(independentTarget, "independent before");
    const first = createConfig({
      name: "First Writer",
      category: "tools",
      content: "first",
      target_path: sharedTarget,
    }, db);
    const second = createConfig({
      name: "Second Writer",
      category: "tools",
      content: "second",
      target_path: sharedTarget,
    }, db);
    const independent = createConfig({
      name: "Independent Writer",
      category: "tools",
      content: "independent",
      target_path: independentTarget,
    }, db);

    const report = await applyConfigsWithReport(
      [first, independent, second],
      { store: new LocalConfigStore(db) },
    );

    expect(report.results).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.message).toContain("Multiple profile writers target");
    expect(readFileSync(sharedTarget, "utf8")).toBe("shared before");
    expect(readFileSync(independentTarget, "utf8")).toBe("independent before");
  });

  test("aborts before all writes when rendered and literal targets collide", async () => {
    const db = getDatabase();
    const sharedTarget = join(tmpDir, "shared.txt");
    const outputOwnerTarget = join(tmpDir, "output-owner.txt");
    const independentTarget = join(tmpDir, "independent.txt");
    writeFileSync(sharedTarget, "shared before");
    writeFileSync(outputOwnerTarget, "output owner before");
    writeFileSync(independentTarget, "independent before");
    const templatedPrimary = createConfig({
      name: "Templated Primary Writer",
      category: "tools",
      content: "templated primary",
      target_path: "{{HOME_DIR}}/shared.txt",
    }, db);
    const literalOutput = createConfig({
      name: "Literal Output Writer",
      category: "tools",
      agent: "claude",
      content: "literal output",
      target_path: outputOwnerTarget,
      outputs: [{
        agent: "codex",
        target_path: sharedTarget,
        transform: "codex-flat",
      }],
    }, db);
    const independent = createConfig({
      name: "Independent Writer",
      category: "tools",
      content: "independent after",
      target_path: independentTarget,
    }, db);

    const report = await applyConfigsWithReport(
      [templatedPrimary, literalOutput, independent],
      {
        vars: { HOME_DIR: tmpDir },
        store: new LocalConfigStore(db),
      },
    );

    expect(report.results).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.message).toContain(`Multiple profile writers target ${sharedTarget}`);
    expect(readFileSync(sharedTarget, "utf8")).toBe("shared before");
    expect(readFileSync(outputOwnerTarget, "utf8")).toBe("output owner before");
    expect(readFileSync(independentTarget, "utf8")).toBe("independent before");
  });

  test("deduplicates templated and literal configs after rendering their complete behavior", async () => {
    const db = getDatabase();
    const sharedTarget = join(tmpDir, "shared.txt");
    const sharedOutput = join(tmpDir, "shared-output.txt");
    const templated = createConfig({
      name: "Templated Writer",
      category: "tools",
      agent: "claude",
      content: "home={{HOME_DIR}}",
      target_path: "{{HOME_DIR}}/shared.txt",
      outputs: [{
        agent: "codex",
        target_path: "{{HOME_DIR}}/shared-output.txt",
        transform: "passthrough",
      }],
    }, db);
    const literal = createConfig({
      name: "Literal Writer",
      category: "tools",
      agent: "claude",
      content: `home=${tmpDir}`,
      target_path: sharedTarget,
      outputs: [{
        agent: "codex",
        target_path: sharedOutput,
        transform: "passthrough",
      }],
    }, db);

    const report = await previewConfigs([templated, literal], {
      vars: { HOME_DIR: tmpDir },
      store: new LocalConfigStore(db),
    });

    expect(report.failures).toEqual([]);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.path).toBe(sharedTarget);
    expect(report.results[0]?.new_content).toBe(`home=${tmpDir}`);
    expect(report.results[0]?.outputs?.map((output) => output.path)).toEqual([sharedOutput]);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped.every((entry) => entry.owner === "equivalent-profile-config")).toBe(true);
  });

  test("does not deduplicate configs that differ by a unique output", async () => {
    const db = getDatabase();
    const sharedTarget = join(tmpDir, "shared.txt");
    const firstOutput = join(tmpDir, "first-output.txt");
    const secondOutput = join(tmpDir, "second-output.txt");
    const first = createConfig({
      name: "First Complete Writer",
      category: "tools",
      agent: "claude",
      content: "same content",
      target_path: sharedTarget,
      outputs: [{
        agent: "codex",
        target_path: firstOutput,
        transform: "passthrough",
      }],
    }, db);
    const second = createConfig({
      name: "Second Complete Writer",
      category: "tools",
      agent: "claude",
      content: "same content",
      target_path: sharedTarget,
      outputs: [{
        agent: "codewith",
        target_path: secondOutput,
        transform: "passthrough",
      }],
    }, db);

    const report = await applyConfigsWithReport(
      [first, second],
      { store: new LocalConfigStore(db) },
    );

    expect(report.results).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.message).toContain(`Multiple profile writers target ${sharedTarget}`);
    expect(report.skipped).toEqual([]);
    expect(existsSync(sharedTarget)).toBe(false);
    expect(existsSync(firstOutput)).toBe(false);
    expect(existsSync(secondOutput)).toBe(false);
  });

  test("does not deduplicate configs whose transform metadata changes output content", async () => {
    const db = getDatabase();
    const sharedTarget = join(tmpDir, "shared.md");
    const sharedOutput = join(tmpDir, "shared.mdc");
    const first = createConfig({
      name: "First Cursor Description",
      category: "rules",
      agent: "claude",
      content: "# Same content\n",
      target_path: sharedTarget,
      outputs: [{
        agent: "cursor",
        target_path: sharedOutput,
        transform: "cursor-mdc",
      }],
    }, db);
    const second = createConfig({
      name: "Second Cursor Description",
      category: "rules",
      agent: "claude",
      content: "# Same content\n",
      target_path: sharedTarget,
      outputs: [{
        agent: "cursor",
        target_path: sharedOutput,
        transform: "cursor-mdc",
      }],
    }, db);

    const report = await applyConfigsWithReport(
      [first, second],
      { store: new LocalConfigStore(db) },
    );

    expect(report.results).toEqual([]);
    expect(report.failures.map((failure) => failure.message)).toEqual([
      expect.stringContaining(`Multiple profile writers target ${sharedTarget}`),
      expect.stringContaining(`Multiple profile writers target ${sharedOutput}`),
    ]);
    expect(report.skipped).toEqual([]);
    expect(existsSync(sharedTarget)).toBe(false);
    expect(existsSync(sharedOutput)).toBe(false);
  });

  test("handles empty array", async () => {
    const results = await applyConfigs([]);
    expect(results.length).toBe(0);
  });

  test("previews missing secret variables without resolving or exposing them", async () => {
    const db = getDatabase();
    const config = createConfig({
      name: "Authorization Template",
      category: "mcp",
      agent: "codex",
      content: 'Authorization = "{{AUTHORIZATION}}"',
      target_path: join(tmpDir, "config.toml"),
      is_template: true,
    }, db);

    const preview = await previewConfigs([config], {
      vars: {},
      store: new LocalConfigStore(db),
    });

    expect(preview.failures).toEqual([]);
    expect(preview.results[0]?.unresolved_template_vars).toEqual(["AUTHORIZATION"]);
    expect(preview.results[0]?.new_content).toBe('Authorization = "{{AUTHORIZATION}}"');
    expect(existsSync(join(tmpDir, "config.toml"))).toBe(false);
  });

  test("assigns provider instruction entrypoints to the session renderer once", async () => {
    process.env["CONFIGS_HOME"] = tmpDir;
    const db = getDatabase();
    const canonical = createConfig({
      name: "claude-claude-md",
      category: "rules",
      agent: "claude",
      content: "Canonical source",
      target_path: "~/.claude/CLAUDE.md",
      outputs: [
        { agent: "codex", target_path: "~/.codex/AGENTS.md", transform: "codex-flat" },
        { agent: "codewith", target_path: "~/.codewith/CODEWITH.md", transform: "codex-flat" },
        { agent: "opencode", target_path: "~/.config/opencode/AGENTS.md", transform: "opencode-flat" },
      ],
    }, db);
    const staleDuplicate = createConfig({
      name: "claude-md",
      category: "rules",
      agent: "claude",
      content: "Canonical source",
      target_path: "~/.claude/CLAUDE.md",
      outputs: canonical.outputs,
    }, db);

    const preview = await previewConfigs([canonical, staleDuplicate], {
      store: new LocalConfigStore(db),
    });

    expect(preview.failures).toEqual([]);
    expect(preview.results).toEqual([]);
    expect(preview.skipped.every((entry) => entry.owner === "instructions-session-renderer")).toBe(true);
    expect(new Set(preview.skipped.map((entry) => entry.path))).toEqual(new Set([
      join(tmpDir, ".claude", "CLAUDE.md"),
      join(tmpDir, ".codex", "AGENTS.md"),
      join(tmpDir, ".codewith", "CODEWITH.md"),
      join(tmpDir, ".config", "opencode", "AGENTS.md"),
    ]));
  });

  test("skips Claude and Antigravity legacy writers while preserving OpenCode settings", async () => {
    process.env["CONFIGS_HOME"] = tmpDir;
    const db = getDatabase();
    const configs = [
      createConfig({
        name: "Claude Legacy Writer",
        category: "rules",
        agent: "claude",
        content: "legacy claude",
        target_path: "~/.claude/CLAUDE.md",
      }, db),
      createConfig({
        name: "Antigravity Gemini Legacy Writer",
        category: "rules",
        agent: "antigravity",
        content: "legacy antigravity gemini",
        target_path: "~/.gemini/GEMINI.md",
      }, db),
      createConfig({
        name: "Antigravity Named Legacy Writer",
        category: "rules",
        agent: "antigravity",
        content: "legacy antigravity named",
        target_path: "~/.gemini/ANTIGRAVITY.md",
      }, db),
      createConfig({
        name: "OpenCode Settings",
        category: "agent",
        agent: "opencode",
        format: "json",
        content: JSON.stringify({ model: "preserved-model", mcp: { preserved: true } }),
        target_path: "~/.config/opencode/opencode.json",
      }, db),
    ];

    const preview = await previewConfigs(configs, {
      store: new LocalConfigStore(db),
    });

    expect(preview.failures).toEqual([]);
    expect(preview.results).toHaveLength(1);
    expect(preview.results[0]?.path).toBe(join(tmpDir, ".config", "opencode", "opencode.json"));
    expect(preview.results[0]?.new_content).toContain("preserved-model");
    expect(new Set(preview.skipped.map((entry) => entry.path))).toEqual(new Set([
      join(tmpDir, ".claude", "CLAUDE.md"),
      join(tmpDir, ".gemini", "GEMINI.md"),
      join(tmpDir, ".gemini", "ANTIGRAVITY.md"),
    ]));
    expect(preview.skipped.every((entry) => entry.owner === "instructions-session-renderer")).toBe(true);
  });

  test("checks session ownership after rendering machine-aware target paths", async () => {
    process.env["CONFIGS_HOME"] = tmpDir;
    const renderedHome = join(tmpDir, "remote-home");
    const db = getDatabase();
    const configs = [
      createConfig({
        name: "Rendered Claude Writer",
        category: "rules",
        agent: "claude",
        content: "legacy claude",
        target_path: "{{HOME_DIR}}/.claude/CLAUDE.md",
      }, db),
      createConfig({
        name: "OpenCode Settings With Rendered Legacy Output",
        category: "mcp",
        agent: "opencode",
        content: "{}",
        target_path: "{{HOME_DIR}}/.config/opencode/opencode.json",
        outputs: [{
          agent: "antigravity",
          target_path: "{{HOME_DIR}}/.gemini/GEMINI.md",
          transform: "codex-flat",
        }, {
          agent: "antigravity",
          target_path: "{{HOME_DIR}}/.gemini/config/mcp_config.json",
          transform: "codex-flat",
        }],
      }, db),
    ];

    const preview = await previewConfigs(configs, {
      vars: { HOME_DIR: renderedHome },
      store: new LocalConfigStore(db),
    });

    expect(preview.failures).toEqual([]);
    expect(preview.results).toHaveLength(1);
    expect(preview.results[0]?.path).toBe(join(renderedHome, ".config", "opencode", "opencode.json"));
    expect(preview.results[0]?.outputs?.map((output) => output.path)).toEqual([
      join(renderedHome, ".gemini", "config", "mcp_config.json"),
    ]);
    expect(new Set(preview.skipped.map((entry) => entry.path))).toEqual(new Set([
      join(renderedHome, ".claude", "CLAUDE.md"),
      join(renderedHome, ".gemini", "GEMINI.md"),
    ]));
    expect(preview.skipped.every((entry) => entry.owner === "instructions-session-renderer")).toBe(true);
    expect(existsSync(join(renderedHome, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(renderedHome, ".gemini", "GEMINI.md"))).toBe(false);
    expect(existsSync(join(renderedHome, ".gemini", "config", "mcp_config.json"))).toBe(false);
    expect(existsSync(join(renderedHome, ".config", "opencode", "opencode.json"))).toBe(false);
  });

  test("excludes retired Gemini and project-scoped Antigravity writers before validation", async () => {
    const db = getDatabase();
    const canonical = createConfig({
      name: "Claude Canonical",
      category: "rules",
      agent: "claude",
      content: "# Canonical\n",
      target_path: join(tmpDir, ".claude", "CLAUDE.md"),
      outputs: [{
        agent: "antigravity",
        target_path: join(tmpDir, ".gemini", "GEMINI.md"),
        transform: "codex-flat",
      }],
    }, db);
    const retired = {
      ...createConfig({
        name: "Gemini Legacy",
        category: "rules",
        agent: "claude",
        content: "# Legacy\n",
        target_path: join(tmpDir, ".gemini", "GEMINI.md"),
      }, db),
      agent: "gemini" as Config["agent"],
    };

    process.env["CONFIGS_HOME"] = tmpDir;
    const preview = await previewConfigs([canonical, retired], {
      store: new LocalConfigStore(db),
    });

    expect(preview.failures).toEqual([]);
    expect(preview.skipped.some((item) =>
      item.config_slug === canonical.slug
      && item.owner === "instructions-session-renderer"
      && item.reason.includes("Antigravity")
    )).toBe(true);
    expect(preview.skipped.some((item) =>
      item.config_slug === retired.slug
      && item.owner === "retired-provider-config"
    )).toBe(true);
  });
});
