import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig, listConfigs } from "../db/configs";
import { diffConfig, detectCategory, detectAgent, detectFormat } from "./sync";
import { syncFromDir } from "./sync-dir";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = join(tmpdir(), `configs-sync-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
});

describe("detectCategory", () => {
  test("detects rules for claude.md", () => expect(detectCategory("/home/user/.claude/CLAUDE.md")).toBe("rules"));
  test("detects rules for rules dir", () => expect(detectCategory("/home/user/.claude/rules/git.md")).toBe("rules"));
  test("detects agent for .claude dir", () => expect(detectCategory("/home/user/.claude/settings.json")).toBe("agent"));
  test("detects shell for .zshrc", () => expect(detectCategory("/home/user/.zshrc")).toBe("shell"));
  test("detects git for .gitconfig", () => expect(detectCategory("/home/user/.gitconfig")).toBe("git"));
  test("detects tools for tsconfig", () => expect(detectCategory("/home/user/project/tsconfig.json")).toBe("tools"));
});

describe("detectAgent", () => {
  test("detects claude for .claude dir", () => expect(detectAgent("/home/user/.claude/CLAUDE.md")).toBe("claude"));
  test("detects codex for .codex dir", () => expect(detectAgent("/home/user/.codex/config.toml")).toBe("codex"));
  test("detects zsh for .zshrc", () => expect(detectAgent("/home/user/.zshrc")).toBe("zsh"));
  test("detects npm for .npmrc", () => expect(detectAgent("/home/user/.npmrc")).toBe("npm"));
});

describe("detectFormat", () => {
  test("json", () => expect(detectFormat("foo.json")).toBe("json"));
  test("toml", () => expect(detectFormat("foo.toml")).toBe("toml"));
  test("markdown", () => expect(detectFormat("foo.md")).toBe("markdown"));
  test("yaml", () => expect(detectFormat("foo.yaml")).toBe("yaml"));
  test("text fallback", () => expect(detectFormat("foo")).toBe("text"));
});

describe("syncFromDir", () => {
  test("adds new files from disk", async () => {
    writeFileSync(join(tmpDir, "test.md"), "# Hello");
    const db = getDatabase();
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: false });
    expect(result.added).toBe(1);
    expect(listConfigs(undefined, db).length).toBe(1);
  });

  test("unchanged files are not updated", async () => {
    const db = getDatabase();
    writeFileSync(join(tmpDir, "same.txt"), "same");
    await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: false });
    const result2 = await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: false });
    expect(result2.unchanged).toBe(1);
    expect(result2.updated).toBe(0);
  });

  test("updated files are detected", async () => {
    const db = getDatabase();
    const file = join(tmpDir, "change.txt");
    writeFileSync(file, "v1");
    await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: false });
    writeFileSync(file, "v2");
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db), recursive: false });
    expect(result.updated).toBe(1);
  });

  test("dry-run does not write to DB", async () => {
    const db = getDatabase();
    writeFileSync(join(tmpDir, "new.md"), "content");
    const result = await syncFromDir(tmpDir, { store: new LocalConfigStore(db), dryRun: true, recursive: false });
    expect(result.added).toBe(1);
    expect(listConfigs(undefined, db).length).toBe(0);
  });

  test("returns skipped for missing dir", async () => {
    const db = getDatabase();
    const result = await syncFromDir("/nonexistent/path", { store: new LocalConfigStore(db) });
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});

describe("diffConfig", () => {
  test("returns identical message when same", async () => {
    writeFileSync(join(tmpDir, "same.txt"), "content");
    const db = getDatabase();
    const c = createConfig({ name: "same", category: "tools", content: "content", target_path: join(tmpDir, "same.txt") }, db);
    expect(await diffConfig(c)).toBe("(no diff — identical)");
  });

  test("returns diff for different content", async () => {
    writeFileSync(join(tmpDir, "diff.txt"), "disk content");
    const db = getDatabase();
    const c = createConfig({ name: "diff", category: "tools", content: "stored content", target_path: join(tmpDir, "diff.txt") }, db);
    const diff = await diffConfig(c);
    expect(diff).toContain("-stored content");
    expect(diff).toContain("+disk content");
  });

  test("returns file not found for missing path", async () => {
    const db = getDatabase();
    const c = createConfig({ name: "missing", category: "tools", content: "x", target_path: join(tmpDir, "nope.txt") }, db);
    expect(await diffConfig(c)).toContain("not found on disk");
  });

  test("diff includes transformed output paths", async () => {
    const db = getDatabase();
    const primary = join(tmpDir, "CLAUDE.md");
    const output = join(tmpDir, "AGENTS.md");
    writeFileSync(primary, "# Claude");
    writeFileSync(output, "# stale");
    const c = createConfig({
      name: "Claude",
      category: "rules",
      agent: "claude",
      content: "# Claude",
      target_path: primary,
      outputs: [
        { agent: "codex", target_path: output, transform: "codex-flat" },
      ],
    }, db);

    const diff = await diffConfig(c, { store: new LocalConfigStore(db) });

    expect(diff).toContain(`+++ disk (${output})`);
    expect(diff).toContain("-# Claude");
    expect(diff).toContain("+# stale");
  });
});
