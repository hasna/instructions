import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { LocalConfigStore } from "../data/config-store";
import { createConfig, getConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { getProfileConfigs } from "../db/profiles";
import { ensurePlatformProfiles } from "./platform-profiles";
import { planSessionRender, sourceFromConfig } from "./session-render";
import {
  DANGEROUS_OPERATION_GUARD_STANDARD_CONTENT,
  DANGEROUS_OPERATION_GUARD_STANDARD_SLUG,
  ensureDangerousOperationGuardStandardConfig,
} from "./dangerous-operation-guard-standard";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

describe("dangerous operation guard standard", () => {
  test("seeds managed dangerous-operation guard rules with runtime-specific clauses", async () => {
    const config = await ensureDangerousOperationGuardStandardConfig(new LocalConfigStore(db));

    expect(config.slug).toBe(DANGEROUS_OPERATION_GUARD_STANDARD_SLUG);
    expect(config.kind).toBe("reference");
    expect(config.category).toBe("rules");
    expect(config.agent).toBe("global");
    expect(config.tags).toEqual(expect.arrayContaining(["dangerous-operation-guard", "hooks", "station01"]));

    const content = config.content;
    expect(content).toContain("sustained Hasna\ncoding agents on station01");
    expect(content).toContain("Apply this guard to sustained Codewith, Codex, Claude Code, Qwen Code");
    expect(content).toContain("OpenCode, Cursor, and Google Antigravity");
    expect(content).toContain("Do not target Gemini CLI");
    expect(content).toContain("Keep guard policy in managed instructions/config");
    expect(content).toContain("allow_managed_hooks_only = true");
    expect(content).toContain("`PreToolUse` is a hard-deny and context-injection surface");
    expect(content).toContain("Approval decisions belong in `PermissionRequest` hooks");
    expect(content).toContain("do not return `permissionDecision: \"ask\"` from\n  `PreToolUse`");
    expect(content).toContain("Session rendering writes Qwen Code `QWEN.md`");
    expect(content).toContain("policy context only");
    expect(content).toContain("Qwen Code native `settings.json` hooks");
    expect(content).toContain("`~/.qwen/settings.json`");
    expect(content).toContain("`.qwen/settings.json`");
    expect(content).toContain("Cursor rule files are advisory prompt context");
    expect(content).toContain("managed wrapper/plugin fallback for enforcement");
    expect(content).toContain("must never reintroduce an active\n  `gemini` target");
  });

  test("updates stale seeded guard instead of creating a duplicate", async () => {
    createConfig({
      name: "Dangerous Operation Guard Standard",
      category: "rules",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: "old content",
    }, db);

    const config = await ensureDangerousOperationGuardStandardConfig(new LocalConfigStore(db));
    const stored = getConfig(DANGEROUS_OPERATION_GUARD_STANDARD_SLUG, db);

    expect(config.id).toBe(stored.id);
    expect(stored.content).toBe(DANGEROUS_OPERATION_GUARD_STANDARD_CONTENT);
    expect(stored.version).toBe(2);
  });

  test("renders through managed guard outputs for all claimed render targets", async () => {
    const config = await ensureDangerousOperationGuardStandardConfig(new LocalConfigStore(db));
    const source = sourceFromConfig(config);

    const codewith = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [source],
    });
    expect(codewith.files[0]?.relativePath).toBe("CODEWITH.md");
    expect(codewith.files[0]?.content).toContain("Dangerous Operation Guard Standard");
    expect(codewith.files[0]?.content).toContain("PermissionRequest");

    const codex = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      sources: [source],
    });
    expect(codex.files[0]?.relativePath).toBe("AGENTS.md");
    expect(codex.files[0]?.content).toContain("PreToolUse");

    const claude = planSessionRender({
      tool: "claude",
      profile: "account999",
      targetHome: "/tmp/claude-account999",
      sources: [source],
    });
    expect(claude.files[0]?.relativePath).toBe("CLAUDE.md");
    expect(claude.files[0]?.content).toContain("@./.hasna/instructions/01-dangerous-operation-guard-standard.md");
    expect(claude.files[1]?.content).toContain("Claude Code native hooks");

    const opencode = planSessionRender({
      tool: "opencode",
      profile: "account999",
      targetHome: "/tmp/opencode-account999",
      sources: [source],
    });
    expect(opencode.files[0]?.relativePath).toBe("AGENTS.md");
    expect(opencode.files[1]?.relativePath).toBe("opencode.json");
    expect(opencode.files[0]?.content).toContain("OpenCode");
    expect(JSON.parse(opencode.files[1]!.content)).toMatchObject({
      instructions: [".hasna/instructions/01-dangerous-operation-guard-standard.md"],
    });

    const cursor = planSessionRender({
      tool: "cursor",
      profile: "account999",
      projectRoot: "/tmp/repo",
      sources: [source],
    });
    expect(cursor.files[0]?.relativePath).toBe(".cursor/rules/01-dangerous-operation-guard-standard.mdc");
    expect(cursor.files[0]?.content).toContain("Cursor rule files are advisory prompt context");

    const qwen = planSessionRender({
      tool: "qwen",
      profile: "account999",
      targetHome: "/tmp/qwen-account999",
      sources: [source],
    });
    expect(qwen.files[0]?.relativePath).toBe("QWEN.md");
    expect(qwen.files[0]?.content).toContain("Qwen Code");
    expect(qwen.files[0]?.content).toContain("policy context only");

    const antigravity = planSessionRender({
      tool: "antigravity",
      profile: "account999",
      projectRoot: "/tmp/repo",
      sources: [source],
    });
    expect(antigravity.files[0]?.relativePath).toBe(".agents/rules/01-dangerous-operation-guard-standard.md");
    expect(antigravity.files[0]?.content).toContain("wrapper/plugin fallback");
  });

  test("platform profiles link the guard standard when present", async () => {
    const standard = await ensureDangerousOperationGuardStandardConfig(new LocalConfigStore(db));
    const profiles = await ensurePlatformProfiles(new LocalConfigStore(db));

    for (const profile of profiles) {
      expect(getProfileConfigs(profile.id, db).map((config) => config.id)).toContain(standard.id);
    }
  });
});
