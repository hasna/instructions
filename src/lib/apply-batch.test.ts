import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import type { Config } from "../types/index";
import { applyConfigs, previewConfigs } from "./apply";

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
