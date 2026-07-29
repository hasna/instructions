import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalConfigStore } from "../data/config-store";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { applyConfig, applyConfigsWithReport } from "./apply";
import {
  SESSION_RENDERER_OWNER_ID,
  SESSION_RENDER_EXCLUSIVE_MANAGED_PATHS,
  SESSION_RENDER_MANAGED_DIRS,
  SESSION_RENDER_SHARED_MANAGED_DIRS,
  SESSION_RENDER_MANIFEST_RELATIVE_PATH,
  SESSION_RENDER_SCHEMA,
} from "./session-render";
import { CLAUDE_PROMPT_OUTPUTS } from "./sync";
import { tempRootPath } from "./test-temp-root";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = tempRootPath(`configs-ownership-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env["CONFIGS_HOME"] = tmpDir;
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

function writeSessionRenderManifest(
  targetHome: string,
  tool: string,
  relativePaths: string[],
): void {
  const manifestPath = join(targetHome, ...SESSION_RENDER_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: SESSION_RENDER_SCHEMA,
      tool,
      targetHome,
      targetOwner: {
        kind: "provider-profile",
        tool,
        targetHome,
        writer: { id: SESSION_RENDERER_OWNER_ID, canonical: true, scope: "managed-provider-files" },
      },
      files: relativePaths.map((relativePath) => ({
        path: join(targetHome, ...relativePath.split("/")),
        relativePath,
        role: relativePath.includes("/") ? "fragment" : "index",
        sha256: "0".repeat(64),
        sourceIds: [],
      })),
    }),
    "utf-8",
  );
}

describe("session renderer ownership guard", () => {
  // The discriminating control from todos e85f5338: three arms through the same
  // code path, same renderer-owned home. Arm 1 proves the guard is on, arm 2 is
  // the reported defect, arm 3 proves normal apply still writes.
  test("three-arm control: entrypoint blocked, managed fragment blocked, unmanaged path written", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);

    const entrypoint = createConfig({
      name: "Arm 1 Claude Entrypoint",
      category: "rules",
      agent: "claude",
      content: "arm-1",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
    }, db);
    const managedFragment = createConfig({
      name: "Arm 2 Managed Fragment",
      category: "rules",
      agent: "claude",
      content: "arm-2",
      target_path: "~/.claude/.hasna/instructions/04-hasna-agent-operating-rules.md",
      format: "markdown",
    }, db);
    const unmanaged = createConfig({
      name: "Arm 3 Unmanaged Path",
      category: "rules",
      agent: "claude",
      content: "arm-3",
      target_path: "~/.claude/rules/scratch.md",
      format: "markdown",
    }, db);

    const entrypointReport = await applyConfigsWithReport([entrypoint], { store });
    const fragmentReport = await applyConfigsWithReport([managedFragment], { store });
    const unmanagedReport = await applyConfigsWithReport([unmanaged], { store });

    // Arm 1 — guard is on.
    expect(entrypointReport.skipped.map((entry) => entry.owner)).toEqual([SESSION_RENDERER_OWNER_ID]);
    expect(entrypointReport.results).toEqual([]);
    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(false);

    // Arm 2 — the defect: the managed fragment directory must be owned too.
    expect(fragmentReport.skipped.map((entry) => entry.owner)).toEqual([SESSION_RENDERER_OWNER_ID]);
    expect(fragmentReport.results).toEqual([]);
    expect(
      existsSync(join(tmpDir, ".claude", ".hasna", "instructions", "04-hasna-agent-operating-rules.md")),
    ).toBe(false);

    // Arm 3 — an unmanaged path is still writable; the guard is not global.
    expect(unmanagedReport.skipped).toEqual([]);
    expect(unmanagedReport.results.length).toBe(1);
    expect(readFileSync(join(tmpDir, ".claude", "rules", "scratch.md"), "utf-8")).toBe("arm-3");
  });

  test("direct apply throws for a managed fragment target", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const config = createConfig({
      name: "Managed Fragment Direct",
      category: "rules",
      agent: "claude",
      content: "reverted governance rules",
      target_path: "~/.claude/.hasna/instructions/05-hasna-agent-operating-rules.md",
      format: "markdown",
    }, db);

    await expect(applyConfig(config, { store })).rejects.toThrow(SESSION_RENDERER_OWNER_ID);
    expect(
      existsSync(join(tmpDir, ".claude", ".hasna", "instructions", "05-hasna-agent-operating-rules.md")),
    ).toBe(false);
  });

  test("guard covers every renderer profile home, not just the configured config home", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    for (const relative of [
      ".codex/.hasna/instructions/01-global.md",
      ".codewith/.hasna/instructions/01-global.md",
      ".config/opencode/.hasna/instructions/01-global.md",
      ".hasna/accounts/profiles/claude/account003/.hasna/instructions/01-global.md",
    ]) {
      const config = createConfig({
        name: `Fragment ${relative}`,
        category: "rules",
        agent: "claude",
        content: "stale",
        target_path: join(tmpDir, ...relative.split("/")),
        format: "markdown",
      }, db);
      await expect(applyConfig(config, { store })).rejects.toThrow(SESSION_RENDERER_OWNER_ID);
      expect(existsSync(join(tmpDir, ...relative.split("/")))).toBe(false);
    }
  });

  test("guard covers the renderer manifest and snapshot files", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    for (const relative of [
      ".claude/.hasna/session-render-manifest.json",
      ".claude/.hasna/session-render-snapshots/20260728T000000Z.json",
    ]) {
      const config = createConfig({
        name: `Renderer state ${relative}`,
        category: "agent",
        agent: "claude",
        content: "{}",
        target_path: join(tmpDir, ...relative.split("/")),
        format: "json",
      }, db);
      await expect(applyConfig(config, { store })).rejects.toThrow(SESSION_RENDERER_OWNER_ID);
    }
  });

  test("manifest-claimed files outside the managed dir are owned", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const targetHome = join(tmpDir, ".config", "opencode");
    mkdirSync(targetHome, { recursive: true });
    writeSessionRenderManifest(targetHome, "opencode", ["AGENTS.md", "opencode.json"]);

    const claimed = createConfig({
      name: "OpenCode Config Row",
      category: "mcp",
      agent: "opencode",
      content: "{}",
      target_path: join(targetHome, "opencode.json"),
      format: "json",
    }, db);
    const unclaimed = createConfig({
      name: "OpenCode Sibling Row",
      category: "mcp",
      agent: "opencode",
      content: "{}",
      target_path: join(targetHome, "themes.json"),
      format: "json",
    }, db);

    await expect(applyConfig(claimed, { store })).rejects.toThrow(SESSION_RENDERER_OWNER_ID);
    await applyConfig(unclaimed, { store });
    expect(readFileSync(join(targetHome, "themes.json"), "utf-8")).toBe("{}");
  });

  test("shared fan-out directories stay writable where the renderer did not render", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const cursorTarget = join(tmpDir, ".cursor", "rules", "claude.mdc");
    const config = createConfig({
      name: "Cursor Fan-out Row",
      category: "rules",
      agent: "cursor",
      content: "---\nalwaysApply: true\n---\n",
      target_path: cursorTarget,
      format: "markdown",
    }, db);

    await applyConfig(config, { store });
    expect(existsSync(cursorTarget)).toBe(true);
  });

  test("shared fan-out directories become owned once the renderer claims them", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const workspace = join(tmpDir, "workspaces", "wks_demo");
    mkdirSync(workspace, { recursive: true });
    writeSessionRenderManifest(workspace, "cursor", [".cursor/rules/03-hasna-agent-operating-rules.mdc"]);

    const config = createConfig({
      name: "Cursor Workspace Row",
      category: "rules",
      agent: "cursor",
      content: "stale",
      target_path: join(workspace, ".cursor", "rules", "03-hasna-agent-operating-rules.mdc"),
      format: "markdown",
    }, db);

    await expect(applyConfig(config, { store })).rejects.toThrow(SESSION_RENDERER_OWNER_ID);
  });

  test("the explicit escape hatch is opt-in and never the default", async () => {
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const target = join(tmpDir, ".claude", ".hasna", "instructions", "07-intentional.md");
    const config = createConfig({
      name: "Intentional Fragment",
      category: "rules",
      agent: "claude",
      content: "intentional",
      target_path: target,
      format: "markdown",
    }, db);

    await expect(applyConfig(config, { store })).rejects.toThrow(SESSION_RENDERER_OWNER_ID);
    expect(existsSync(target)).toBe(false);

    await applyConfig(config, { store, allowSessionRendererOwned: true });
    expect(readFileSync(target, "utf-8")).toBe("intentional");
  });
});

describe("session renderer managed path derivation", () => {
  test("exclusive managed paths are derived from the renderer's own adapters", () => {
    expect(SESSION_RENDER_MANAGED_DIRS).toContain(".hasna/instructions");
    for (const dir of SESSION_RENDER_MANAGED_DIRS) {
      const shared = (SESSION_RENDER_SHARED_MANAGED_DIRS as readonly string[]).includes(dir);
      expect(SESSION_RENDER_EXCLUSIVE_MANAGED_PATHS.includes(dir)).toBe(!shared);
    }
  });

  test("no exclusive managed path collides with a config fan-out output directory", () => {
    const fanOutDirs = new Set(
      CLAUDE_PROMPT_OUTPUTS
        .map((output) => output.target_path.replace(/^~\//, ""))
        .map((path) => path.split("/").slice(0, -1).join("/"))
        .filter((dir) => dir.length > 0),
    );
    for (const managed of SESSION_RENDER_EXCLUSIVE_MANAGED_PATHS) {
      for (const fanOut of fanOutDirs) {
        expect(fanOut === managed || fanOut.startsWith(`${managed}/`)).toBe(false);
      }
    }
  });
});
