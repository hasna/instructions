import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig, getConfig, listConfigs } from "../db/configs";
import { syncKnown, KNOWN_CONFIGS, syncProject, PROJECT_CONFIG_FILES } from "./sync";
import { detectMachineContext } from "./machine";
import { CONFIG_AGENTS } from "../types/index";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-known-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("KNOWN_CONFIGS", () => {
  test("has required configs (claude, codex, opencode, cursor, codewith, aicopilot, antigravity, shell, git, tools)", () => {
    const agents = new Set(KNOWN_CONFIGS.map((k) => k.agent));
    expect(agents.has("claude")).toBe(true);
    expect(agents.has("codex")).toBe(true);
    expect(agents.has("opencode")).toBe(true);
    expect(agents.has("cursor")).toBe(true);
    expect(agents.has("codewith")).toBe(true);
    expect(agents.has("aicopilot")).toBe(true);
    expect(agents.has("antigravity")).toBe(true);
    expect(agents.has("zsh")).toBe(true);
    expect(agents.has("git")).toBe(true);
    expect(agents.has("npm")).toBe(true);
    expect([...agents].sort()).toEqual([
      "aicopilot",
      "antigravity",
      "claude",
      "codewith",
      "codex",
      "cursor",
      "git",
      "global",
      "npm",
      "opencode",
      "zsh",
    ]);
  });

  test("CONFIG_AGENTS includes exactly the active config owners", () => {
    expect([...CONFIG_AGENTS].sort()).toEqual([
      "aicopilot",
      "antigravity",
      "claude",
      "codewith",
      "codex",
      "cursor",
      "git",
      "global",
      "npm",
      "opencode",
      "zsh",
    ]);
  });

  test("registers new coding agent rule and MCP targets", () => {
    const paths = new Set(KNOWN_CONFIGS.map((k) => k.rulesDir ?? k.path));
    expect(paths.has("~/.config/opencode/AGENTS.md")).toBe(true);
    expect(paths.has("~/.config/opencode/opencode.json")).toBe(true);
    expect(paths.has("~/.config/aicopilot/AICOPILOT.md")).toBe(true);
    expect(paths.has("~/.config/aicopilot/aicopilot.json")).toBe(true);
    expect(paths.has("~/.gemini/GEMINI.md")).toBe(true);
    expect(paths.has("~/.gemini/config/mcp_config.json")).toBe(true);
    expect(paths.has("~/.codewith/CODEWITH.md")).toBe(true);
    expect(paths.has("~/.codewith/config.toml")).toBe(true);
    expect(paths.has("~/.cursor/rules")).toBe(true);
    expect(paths.has("~/.cursor/mcp.json")).toBe(true);
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
    const result = await syncKnown({ store: new LocalConfigStore(db), dryRun: true });
    // Should report found files but not write them
    expect(listConfigs(undefined, db).length).toBe(0);
    expect(result.added + result.unchanged + result.skipped.length).toBeGreaterThan(0);
  });

  test("filters by agent", async () => {
    const db = getDatabase();
    const result = await syncKnown({ store: new LocalConfigStore(db), agent: "git", dryRun: true });
    // Should only report git configs
    expect(result.skipped.every((s) => !s.includes(".claude/"))).toBe(true);
  });

  test("ingests cursor .mdc rules from rulesDir", async () => {
    const db = getDatabase();
    const originalHome = process.env["CONFIGS_HOME"];
    process.env["CONFIGS_HOME"] = tmpDir;
    try {
      mkdirSync(join(tmpDir, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(tmpDir, ".cursor", "rules", "security.mdc"), "---\nalwaysApply: true\n---\n# Security");

      const result = await syncKnown({ store: new LocalConfigStore(db), agent: "cursor" });
      const configs = listConfigs({ agent: "cursor" }, db);

      expect(result.added).toBe(1);
      expect(configs.length).toBe(1);
      expect(configs[0]!.name).toBe("cursor-rules-security.mdc");
      expect(configs[0]!.target_path).toBe("~/.cursor/rules/security.mdc");
      expect(configs[0]!.content).toContain("# Security");
    } finally {
      if (originalHome === undefined) delete process.env["CONFIGS_HOME"];
      else process.env["CONFIGS_HOME"] = originalHome;
    }
  });

  test("syncs Claude prompt with fan-out outputs for all coding agents", async () => {
    const db = getDatabase();
    const originalHome = process.env["CONFIGS_HOME"];
    process.env["CONFIGS_HOME"] = tmpDir;
    try {
      mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
      writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nShared.");
      writeFileSync(join(tmpDir, ".claude", "rules", "security.md"), "# Security");

      const result = await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
      const config = getConfig("claude-claude-md", db);

      expect(result.added).toBe(2);
      expect(config.outputs).toEqual([
        { agent: "codex", target_path: "~/.codex/AGENTS.md", transform: "codex-flat" },
        { agent: "codewith", target_path: "~/.codewith/CODEWITH.md", transform: "codex-flat" },
        { agent: "opencode", target_path: "~/.config/opencode/AGENTS.md", transform: "opencode-flat" },
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
        { agent: "antigravity", target_path: "~/.gemini/GEMINI.md", transform: "codex-flat" },
        { agent: "cursor", target_path: "~/.cursor/rules/claude.mdc", transform: "cursor-mdc" },
      ]);
    } finally {
      if (originalHome === undefined) delete process.env["CONFIGS_HOME"];
      else process.env["CONFIGS_HOME"] = originalHome;
    }
  });

  test("backfills fan-out outputs for unchanged migrated Claude rows", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nShared.");

    createConfig({
      name: "claude-claude-md",
      category: "rules",
      agent: "claude",
      format: "markdown",
      content: "# Claude\n\nShared.",
      target_path: "~/.claude/CLAUDE.md",
      outputs: [],
    }, db);

    const result = await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    const config = getConfig("claude-claude-md", db);

    expect(result.updated).toBe(1);
    expect(config.outputs.map((output) => output.agent)).toEqual(["codex", "codewith", "opencode", "aicopilot", "antigravity", "cursor"]);
  });
});

describe("syncProject", () => {
  test("syncs CLAUDE.md from a project dir", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "test-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Test Project\n\nHello.");
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
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
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.added).toBe(1);
  });

  test("syncs Antigravity workspace MCP config from a project dir", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "antigravity-mcp-project");
    mkdirSync(join(projDir, ".agents"), { recursive: true });
    writeFileSync(join(projDir, ".agents", "mcp_config.json"), '{"mcpServers":{}}');
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    const configs = listConfigs(undefined, db);
    expect(result.added).toBe(1);
    expect(configs[0]!.agent).toBe("antigravity");
    expect(configs[0]!.category).toBe("mcp");
    expect(configs[0]!.target_path).toBe(join(projDir, ".agents", "mcp_config.json"));
  });

  test("syncs project rules/*.md", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "rules-project");
    mkdirSync(join(projDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projDir, ".claude", "rules", "test.md"), "# Test Rule");
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.added).toBe(1);
  });

  test("dry-run does not write", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "dry-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Dry");
    await syncProject({ store: new LocalConfigStore(db), projectDir: projDir, dryRun: true });
    // dry-run should not persist anything to DB
    expect(listConfigs(undefined, db).length).toBe(0);
  });

  test("skips empty project dir", async () => {
    const db = getDatabase();
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: join(tmpDir, "empty") });
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
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.added).toBe(1);
    const configs = listConfigs(undefined, db);
    expect(configs[0]!.content).toContain("{{WORKSPACE_ROOT}}");
    expect(configs[0]!.content).toContain("{{BUN_BIN_DIR}}/configs-mcp");
    expect(configs[0]!.content).toContain("{{BUN_PATH}}");
    expect(configs[0]!.is_template).toBe(true);
  });
});

describe("PROJECT_CONFIG_FILES", () => {
  test("includes active project config files only", () => {
    const files = PROJECT_CONFIG_FILES.map((f) => f.file);
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain(".mcp.json");
    expect(files).toContain("AGENTS.md");
    expect(files).toContain(".codewith/CODEWITH.md");
    expect(files).toContain("AICOPILOT.md");
    expect(files).toContain(".agents/mcp_config.json");
  });
});

describe("syncToDisk", () => {
  test("applies file configs to disk", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "sync-to-disk.txt");
    createConfig({ name: "ToDisk", category: "tools", content: "written by syncToDisk", target_path: target }, db);
    const { syncToDisk } = await import("./sync");
    const result = await syncToDisk({ store: new LocalConfigStore(db) });
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
    const result = await syncToDisk({ store: new LocalConfigStore(db), agent: "claude" });
    expect(existsSync(target1)).toBe(true);
    expect(existsSync(target2)).toBe(false);
  });

  test("dry-run does not write", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "no-write.txt");
    createConfig({ name: "NoWrite", category: "tools", content: "nope", target_path: target }, db);
    const { syncToDisk } = await import("./sync");
    await syncToDisk({ store: new LocalConfigStore(db), dryRun: true });
    expect(existsSync(target)).toBe(false);
  });

  test("skips configs without target_path", async () => {
    const db = getDatabase();
    createConfig({ name: "NoPath", category: "workspace", content: "ref", kind: "reference" }, db);
    const { syncToDisk } = await import("./sync");
    const result = await syncToDisk({ store: new LocalConfigStore(db) });
    expect(result.skipped.length).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("does not let stale generated target rows overwrite canonical fan-out outputs", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 1");
    writeFileSync(join(tmpDir, ".claude", "rules", "security.md"), "# Security\n\nRule");

    const { syncToDisk } = await import("./sync");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db) });

    await syncKnown({ store: new LocalConfigStore(db) });
    expect(listConfigs({ agent: "codex" }, db).some((config) => config.target_path === "~/.codex/AGENTS.md")).toBe(false);

    createConfig({
      name: "stale-codex-generated",
      category: "rules",
      agent: "codex",
      format: "markdown",
      content: "# Claude\n\nVersion 1",
      target_path: "~/.codex/AGENTS.md",
    }, db);
    createConfig({
      name: "stale-codewith-generated",
      category: "rules",
      agent: "codewith",
      format: "markdown",
      content: "# Claude\n\nVersion 1",
      target_path: "~/.codewith/CODEWITH.md",
    }, db);

    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 2");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db) });

    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).toContain("Version 2");
    expect(readFileSync(join(tmpDir, ".codewith", "CODEWITH.md"), "utf-8")).toContain("Version 2");
  });

  test("agent-filtered syncToDisk applies canonical outputs for that agent", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 1");

    const { syncToDisk } = await import("./sync");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db), agent: "codex" });
    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).toContain("Version 1");

    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 2");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    const result = await syncToDisk({ store: new LocalConfigStore(db), agent: "codex" });

    expect(result.updated).toBe(1);
    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).toContain("Version 2");
    expect(existsSync(join(tmpDir, ".codewith", "CODEWITH.md"))).toBe(false);
  });

  test("syncToDisk skips stale generated rows with equivalent absolute target paths", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 1");

    const { syncToDisk } = await import("./sync");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db) });

    createConfig({
      name: "zz-stale-codex-generated-absolute",
      category: "rules",
      agent: "codex",
      format: "markdown",
      content: "# absolute stale",
      target_path: join(tmpDir, ".codex", "AGENTS.md"),
    }, db);

    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 2");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db) });

    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).toContain("Version 2");
    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).not.toContain("absolute stale");
  });

  test("syncToDisk skips stale generated rows through equivalent symlink target paths", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const linkHome = join(tmpDir, "link-home");
    symlinkSync(tmpDir, linkHome, "dir");
    mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 1");

    const { syncToDisk } = await import("./sync");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db) });

    createConfig({
      name: "zz-stale-codex-generated-symlink",
      category: "rules",
      agent: "codex",
      format: "markdown",
      content: "# symlink stale",
      target_path: join(linkHome, ".codex", "AGENTS.md"),
    }, db);

    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nVersion 2");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });
    await syncToDisk({ store: new LocalConfigStore(db) });

    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).toContain("Version 2");
    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).not.toContain("symlink stale");
  });

  test("syncToDisk skips symlink stale rows before generated output directory exists", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const linkHome = join(tmpDir, "link-home");
    symlinkSync(tmpDir, linkHome, "dir");
    mkdirSync(join(tmpDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Claude\n\nGenerated");
    await syncKnown({ store: new LocalConfigStore(db), agent: "claude" });

    createConfig({
      name: "zz-stale-codex-generated-symlink-before-dir",
      category: "rules",
      agent: "codex",
      format: "markdown",
      content: "# symlink stale",
      target_path: join(linkHome, ".codex", "AGENTS.md"),
    }, db);

    const { syncToDisk } = await import("./sync");
    await syncToDisk({ store: new LocalConfigStore(db) });

    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).toContain("Generated");
    expect(readFileSync(join(tmpDir, ".codex", "AGENTS.md"), "utf-8")).not.toContain("symlink stale");
  });
});

describe("syncProject — update + unchanged paths", () => {
  test("detects updated CLAUDE.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "update-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Version 1");
    await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    // Change content
    writeFileSync(join(projDir, "CLAUDE.md"), "# Version 2 — updated");
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.updated).toBe(1);
  });

  test("detects unchanged CLAUDE.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "unchanged-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "CLAUDE.md"), "# Same content");
    await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("detects updated rules/*.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "rules-update-proj");
    mkdirSync(join(projDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projDir, ".claude", "rules", "test.md"), "# Rule v1");
    await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    writeFileSync(join(projDir, ".claude", "rules", "test.md"), "# Rule v2 — changed");
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.updated).toBe(1);
  });

  test("detects unchanged rules/*.md on second sync", async () => {
    const db = getDatabase();
    const projDir = join(tmpDir, "rules-same-proj");
    mkdirSync(join(projDir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projDir, ".claude", "rules", "same.md"), "# Same rule");
    await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    const result = await syncProject({ store: new LocalConfigStore(db), projectDir: projDir });
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
  });
});
