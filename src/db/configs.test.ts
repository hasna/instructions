import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database";
import { createConfig, getConfig, listConfigs, updateConfig, deleteConfig, getConfigStats } from "./configs";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

const base = () => createConfig({ name: "Test Config", category: "rules", content: "hello", agent: "claude" }, db);

describe("createConfig", () => {
  test("creates a config with defaults", () => {
    const c = base();
    expect(c.id).toBeTruthy();
    expect(c.name).toBe("Test Config");
    expect(c.slug).toBe("test-config");
    expect(c.kind).toBe("file");
    expect(c.agent).toBe("claude");
    expect(c.category).toBe("rules");
    expect(c.version).toBe(1);
    expect(c.tags).toEqual([]);
    expect(c.is_template).toBe(false);
  });

  test("auto-generates unique slugs", () => {
    const c1 = createConfig({ name: "Same Name", category: "rules", content: "" }, db);
    const c2 = createConfig({ name: "Same Name", category: "rules", content: "" }, db);
    expect(c1.slug).toBe("same-name");
    expect(c2.slug).toBe("same-name-1");
  });

  test("stores tags as array", () => {
    const c = createConfig({ name: "Tagged", category: "agent", content: "", tags: ["foo", "bar"] }, db);
    expect(c.tags).toEqual(["foo", "bar"]);
  });

  test("stores template flag", () => {
    const c = createConfig({ name: "Tmpl", category: "tools", content: "{{VAR}}", is_template: true }, db);
    expect(c.is_template).toBe(true);
  });

  test("stores output fan-out targets", () => {
    const c = createConfig({
      name: "Canonical Claude",
      category: "rules",
      agent: "claude",
      content: "# Rules",
      target_path: "~/.claude/CLAUDE.md",
      outputs: [
        { agent: "codex", target_path: "~/.codex/AGENTS.md", transform: "codex-flat" },
        { agent: "codewith", target_path: "~/.codewith/CODEWITH.md", transform: "codex-flat" },
      ],
    }, db);

    expect(c.outputs).toEqual([
      { agent: "codex", target_path: "~/.codex/AGENTS.md", transform: "codex-flat" },
      { agent: "codewith", target_path: "~/.codewith/CODEWITH.md", transform: "codex-flat" },
    ]);
    expect(getConfig(c.id, db).outputs).toEqual(c.outputs);
  });
});

describe("getConfig", () => {
  test("gets by id", () => {
    const c = base();
    expect(getConfig(c.id, db).id).toBe(c.id);
  });

  test("gets by slug", () => {
    const c = base();
    expect(getConfig(c.slug, db).slug).toBe(c.slug);
  });

  test("throws ConfigNotFoundError for missing", () => {
    expect(() => getConfig("nope", db)).toThrow("Config not found: nope");
  });
});

describe("listConfigs", () => {
  test("returns all configs", () => {
    base();
    createConfig({ name: "Two", category: "agent", content: "" }, db);
    expect(listConfigs(undefined, db).length).toBe(2);
  });

  test("filters by category", () => {
    base(); // rules
    createConfig({ name: "Agent Config", category: "agent", content: "" }, db);
    expect(listConfigs({ category: "rules" }, db).length).toBe(1);
  });

  test("filters by agent", () => {
    base(); // claude
    createConfig({ name: "Codex", category: "agent", content: "", agent: "codex" }, db);
    expect(listConfigs({ agent: "claude" }, db).length).toBe(1);
  });

  test("filters by kind", () => {
    base(); // file
    createConfig({ name: "Ref", category: "workspace", content: "", kind: "reference", target_path: null }, db);
    expect(listConfigs({ kind: "reference" }, db).length).toBe(1);
  });

  test("searches name and content", () => {
    base(); // "hello" content
    createConfig({ name: "Other", category: "tools", content: "world" }, db);
    expect(listConfigs({ search: "hello" }, db).length).toBe(1);
    expect(listConfigs({ search: "Test" }, db).length).toBe(1);
  });
});

describe("updateConfig", () => {
  test("updates content and increments version", () => {
    const c = base();
    const updated = updateConfig(c.id, { content: "updated" }, db);
    expect(updated.content).toBe("updated");
    expect(updated.version).toBe(2);
  });

  test("updates name and regenerates slug", () => {
    const c = base();
    const updated = updateConfig(c.id, { name: "New Name" }, db);
    expect(updated.name).toBe("New Name");
    expect(updated.slug).toBe("new-name");
  });

  test("updates tags", () => {
    const c = base();
    const updated = updateConfig(c.id, { tags: ["x", "y"] }, db);
    expect(updated.tags).toEqual(["x", "y"]);
  });

  test("updates output fan-out targets", () => {
    const c = base();
    const updated = updateConfig(c.id, {
      outputs: [
        { agent: "cursor", target_path: "~/.cursor/rules/claude.mdc", transform: "cursor-mdc" },
      ],
    }, db);

    expect(updated.outputs).toEqual([
      { agent: "cursor", target_path: "~/.cursor/rules/claude.mdc", transform: "cursor-mdc" },
    ]);
  });
});

describe("deleteConfig", () => {
  test("deletes a config", () => {
    const c = base();
    deleteConfig(c.id, db);
    expect(() => getConfig(c.id, db)).toThrow();
  });
});

describe("getConfigStats", () => {
  test("returns counts by category", () => {
    base(); // rules
    createConfig({ name: "A", category: "agent", content: "" }, db);
    const stats = getConfigStats(db);
    expect(stats["rules"]).toBe(1);
    expect(stats["agent"]).toBe(1);
    expect(stats["total"]).toBe(2);
  });
});
