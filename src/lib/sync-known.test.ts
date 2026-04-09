import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig, listConfigs } from "../db/configs";
import { syncKnown, KNOWN_CONFIGS, syncProject, PROJECT_CONFIG_FILES } from "./sync";
import { detectMachineContext } from "./machine";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["CONFIGS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-known-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["CONFIGS_DB_PATH"];
});

describe("KNOWN_CONFIGS", () => {
  test("has required configs (claude, codex, gemini, shell, git, tools)", () => {
    const agents = new Set(KNOWN_CONFIGS.map((k) => k.agent));
    expect(agents.has("claude")).toBe(true);
    expect(agents.has("codex")).toBe(true);
    expect(agents.has("gemini")).toBe(true);
    expect(agents.has("zsh")).toBe(true);
    expect(agents.has("git")).toBe(true);
    expect(agents.has("npm")).toBe(true);
  });

  test("has optional flag on non-essential configs", () => {
    const optional = KNOWN_CONFIGS.filter((k) => k.optional);
    expect(optional.length).toBeGreaterThan(0);
    // bashrc, zprofile, keybindings should be optional
    const optNames = optional.map((k) => k.name);
    expect(optNames).toContain("bashrc");
    expect(optNames).toContain("zprofile");
    expect(optNames).toContain("claude-keybindings");
  });

  test("no duplicate names", () => {
    const names = KNOWN_CONFIGS.filter((k) => !k.rulesDir).map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("syncKnown", () => {
  test("dry-run does not write to DB", async () => {
    const db = getDatabase();
    const result = await syncKnown({ db, dryRun: true });
    // Should report found files but not write them
    expect(listConfigs(undefined, db).length).toBe(0);
    expect(result.added + result.unchanged + result.skipped.length).toBeGreaterThan(0);
  });

  test("filters by agent", async () => {
    const db = getDatabase();
    const result = await syncKnown({ db, agent: "git", dryRun: true });
    // Should only report git configs
    expect(result.skipped.every((s) => !s.includes(".claude/"))).toBe(true);
  });
});

describe("syncProject", () => {
  test("syncs CLAUDE.md from a project dir", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "test-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Test Project\n\nHello.");
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.added).toBe(1);
    const configs = listConfigs(undefined, db);
    expect(configs.length).toBe(1);
    expect(configs[0]!.content).toBe("# Test Project\n\nHello.");
  });

  test("syncs .mcp.json from a project dir", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "mcp-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, ".mcp.json"), '{"mcpServers":{}}');
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.added).toBe(1);
  });

  test("syncs project rules/*.md", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "rules-project");
    mkdirSync(join(projDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projDir, ".claude", "rules", "test.md"), "# Test Rule");
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.added).toBe(1);
  });

  test("dry-run does not write", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "dry-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Dry");
    await syncProject({ db, projectDir: projDir, dryRun: true });
    // dry-run should not persist anything to DB
    expect(listConfigs(undefined, db).length).toBe(0);
  });

  test("skips empty project dir", async () => {
    const db = getDatabase();
    const result = await syncProject({ db, projectDir: join(tmpDir, "empty") });
    expect(result.added).toBe(0);
  });

  test("templateizes machine-specific paths while syncing", async () => {
    const db = getDatabase();
    const machine = detectMachineContext();
    const projDir = join(tmpDir, "machine-aware-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "AGENTS.md"),
      `workspace=${machine.workspace_root}\ncommand=${machine.bun_bin_dir}/configs-mcp\nbun=${machine.bun_path}`
    );
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.added).toBe(1);
    const configs = listConfigs(undefined, db);
    expect(configs[0]!.content).toContain("{{WORKSPACE_ROOT}}");
    expect(configs[0]!.content).toContain("{{BUN_BIN_DIR}}/configs-mcp");
    expect(configs[0]!.content).toContain("{{BUN_PATH}}");
    expect(configs[0]!.is_template).toBe(true);
  });
});

describe("PROJECT_CONFIG_FILES", () => {
  test("includes CLAUDE.md, .mcp.json, AGENTS.md, GEMINI.md", () => {
    const files = PROJECT_CONFIG_FILES.map((f) => f.file);
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain(".mcp.json");
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("GEMINI.md");
  });
});

describe("syncToDisk", () => {
  test("applies file configs to disk", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "sync-to-disk.txt");
    createConfig({ name: "ToDisk", category: "tools", content: "written by syncToDisk", target_path: target }, db);
    const { syncToDisk } = await import("./sync");
    const result = await syncToDisk({ db });
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("written by syncToDisk");
  });

  test("filters by agent", async () => {
    const db = getDatabase();
    const target1 = join(tmpDir, "claude-config.txt");
    const target2 = join(tmpDir, "codex-config.txt");
    createConfig({ name: "Claude", category: "agent", agent: "claude", content: "claude", target_path: target1 }, db);
    createConfig({ name: "Codex", category: "agent", agent: "codex", content: "codex", target_path: target2 }, db);
    const { syncToDisk } = await import("./sync");
    const result = await syncToDisk({ db, agent: "claude" });
    expect(existsSync(target1)).toBe(true);
    expect(existsSync(target2)).toBe(false);
  });

  test("dry-run does not write", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "no-write.txt");
    createConfig({ name: "NoWrite", category: "tools", content: "nope", target_path: target }, db);
    const { syncToDisk } = await import("./sync");
    await syncToDisk({ db, dryRun: true });
    expect(existsSync(target)).toBe(false);
  });

  test("skips configs without target_path", async () => {
    const db = getDatabase();
    createConfig({ name: "NoPath", category: "workspace", content: "ref", kind: "reference" }, db);
    const { syncToDisk } = await import("./sync");
    const result = await syncToDisk({ db });
    expect(result.skipped.length).toBe(0);
    expect(result.updated).toBe(0);
  });
});

describe("syncProject — update + unchanged paths", () => {
  test("detects updated CLAUDE.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "update-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Version 1");
    await syncProject({ db, projectDir: projDir });
    // Change content
    writeFileSync(join(projDir, "CLAUDE.md"), "# Version 2 — updated");
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.updated).toBe(1);
  });

  test("detects unchanged CLAUDE.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "unchanged-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Same content");
    await syncProject({ db, projectDir: projDir });
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("detects updated rules/*.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "rules-update-proj");
    mkdirSync(join(projDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projDir, ".claude", "rules", "test.md"), "# Rule v1");
    await syncProject({ db, projectDir: projDir });
    writeFileSync(join(projDir, ".claude", "rules", "test.md"), "# Rule v2 — changed");
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.updated).toBe(1);
  });

  test("detects unchanged rules/*.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "rules-same-proj");
    mkdirSync(join(projDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projDir, ".claude", "rules", "same.md"), "# Same rule");
    await syncProject({ db, projectDir: projDir });
    const result = await syncProject({ db, projectDir: projDir });
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
  });
});
