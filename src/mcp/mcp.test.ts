import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { createProfile, addConfigToProfile } from "../db/profiles";

// Test MCP tool logic directly by re-implementing the dispatch
beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  getDatabase();
});

describe("MCP tool logic", () => {
  test("list_configs returns compact summaries", () => {
    const db = getDatabase();
    createConfig({ name: "A", category: "rules", content: "x" }, db);
    createConfig({ name: "B", category: "agent", content: "y" }, db);
    const { listConfigs } = require("../db/configs");
    const configs = listConfigs();
    expect(configs.length).toBe(2);
  });

  test("get_config retrieves full content", () => {
    const db = getDatabase();
    const c = createConfig({ name: "My Config", category: "rules", content: "# Hello" }, db);
    const { getConfig } = require("../db/configs");
    const result = getConfig(c.slug);
    expect(result.content).toBe("# Hello");
  });

  test("create_config creates and returns id+slug", () => {
    const db = getDatabase();
    const { createConfig: cc } = require("../db/configs");
    const c = cc({ name: "New", content: "data", category: "tools" }, db);
    expect(c.id).toBeTruthy();
    expect(c.slug).toBe("new");
  });

  test("update_config increments version", () => {
    const db = getDatabase();
    const c = createConfig({ name: "C", category: "rules", content: "v1" }, db);
    const { updateConfig } = require("../db/configs");
    const updated = updateConfig(c.id, { content: "v2" }, db);
    expect(updated.version).toBe(2);
    expect(updated.content).toBe("v2");
  });

  test("list_profiles returns profiles", () => {
    const db = getDatabase();
    createProfile({ name: "Setup" }, db);
    const { listProfiles } = require("../db/profiles");
    const profiles = listProfiles(db);
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe("Setup");
  });

  test("get_snapshot returns null when no snapshots", () => {
    const db = getDatabase();
    const c = createConfig({ name: "C", category: "rules", content: "" }, db);
    const { listSnapshots } = require("../db/snapshots");
    const snaps = listSnapshots(c.id, db);
    expect(snaps.length).toBe(0);
  });

  test("search_tools finds by keyword", () => {
    const TOOL_DOCS: Record<string, string> = {
      list_configs: "List configs by category/agent/kind.",
      get_config: "Get a config by id or slug.",
    };
    const query = "list";
    const matches = Object.entries(TOOL_DOCS)
      .filter(([k, v]) => k.includes(query) || v.toLowerCase().includes(query))
      .map(([name]) => name);
    expect(matches).toContain("list_configs");
  });
});

describe("MCP tool logic — new tools", () => {
  test("get_status returns stats with template count", () => {
    const db = getDatabase();
    createConfig({ name: "Regular", category: "rules", content: "hello" }, db);
    createConfig({ name: "Template", category: "shell", content: "export KEY={{API_KEY}}", is_template: true }, db);
    const { getConfigStats, listConfigs } = require("../db/configs");
    const stats = getConfigStats(db);
    const allConfigs = listConfigs({ kind: "file" }, db);
    let templates = 0;
    for (const c of allConfigs) { if (c.is_template) templates++; }
    expect(stats["total"]).toBe(2);
    expect(templates).toBe(1);
  });

  test("render_template substitutes variables", () => {
    const { renderTemplate } = require("../lib/template");
    const content = "export API_KEY={{API_KEY}}\nexport NAME={{NAME}}";
    const rendered = renderTemplate(content, { API_KEY: "sk-123", NAME: "test" });
    expect(rendered).toBe("export API_KEY=sk-123\nexport NAME=test");
  });

  test("render_template throws on missing vars", () => {
    const { renderTemplate } = require("../lib/template");
    expect(() => renderTemplate("{{MISSING}}", {})).toThrow("Missing required template variables: MISSING");
  });

  test("scan_secrets detects secrets in stored configs", () => {
    const db = getDatabase();
    createConfig({ name: "leaky", category: "shell", content: 'export API_KEY="sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"' }, db);
    const { scanSecrets } = require("../lib/redact");
    const { listConfigs } = require("../db/configs");
    const configs = listConfigs({ kind: "file" }, db);
    let total = 0;
    for (const c of configs) {
      total += scanSecrets(c.content, c.format).length;
    }
    expect(total).toBeGreaterThan(0);
  });

  test("scan_secrets returns clean for redacted content", () => {
    const db = getDatabase();
    createConfig({ name: "clean", category: "shell", content: 'export API_KEY="{{API_KEY}}"', is_template: true }, db);
    const { scanSecrets } = require("../lib/redact");
    const { listConfigs } = require("../db/configs");
    const configs = listConfigs(undefined, db);
    let total = 0;
    for (const c of configs) {
      total += scanSecrets(c.content, c.format).length;
    }
    expect(total).toBe(0);
  });

  test("INSTRUCTIONS_PROFILE filters tools correctly", () => {
    // Simulate profile filtering logic
    const ALL_TOOLS = [
      { name: "get_status" }, { name: "get_config" }, { name: "sync_known" },
      { name: "list_configs" }, { name: "create_config" }, { name: "update_config" },
    ];
    const PROFILES: Record<string, string[]> = {
      minimal: ["get_status", "get_config", "sync_known"],
      full: [],
    };
    const minimalTools = ALL_TOOLS.filter((t) => PROFILES["minimal"]!.includes(t.name));
    expect(minimalTools.length).toBe(3);
    const fullTools = PROFILES["full"]!.length === 0 ? ALL_TOOLS : ALL_TOOLS.filter((t) => PROFILES["full"]!.includes(t.name));
    expect(fullTools.length).toBe(6);
  });

  test("getConfigStats groups by category", () => {
    const db = getDatabase();
    createConfig({ name: "R1", category: "rules", content: "a" }, db);
    createConfig({ name: "R2", category: "rules", content: "b" }, db);
    createConfig({ name: "S1", category: "shell", content: "c" }, db);
    const { getConfigStats } = require("../db/configs");
    const stats = getConfigStats(db);
    expect(stats["rules"]).toBe(2);
    expect(stats["shell"]).toBe(1);
    expect(stats["total"]).toBe(3);
  });
});
