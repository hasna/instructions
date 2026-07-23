import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { LocalConfigStore } from "../data/config-store";
import { createConfig, getConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { getProfileConfigs } from "../db/profiles";
import { ensurePlatformProfiles } from "./platform-profiles";
import { planSessionRender, sourceFromConfig } from "./session-render";
import {
  GLOBAL_AGENT_RULES_STANDARD_CONTENT,
  GLOBAL_AGENT_RULES_STANDARD_SLUG,
  NO_BRITTLE_HARDCODING_RULE,
  ensureGlobalAgentRulesStandardConfig,
} from "./global-agent-rules-standard";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

describe("global agent rules standard", () => {
  test("seeds managed global/system prompt rules with the required policy clauses", async () => {
    const config = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));

    expect(config.slug).toBe(GLOBAL_AGENT_RULES_STANDARD_SLUG);
    expect(config.kind).toBe("reference");
    expect(config.category).toBe("rules");
    expect(config.agent).toBe("global");
    expect(config.description).toContain("hasnaxyz/iapp-identities@48168c549cc2945053a4498a9a2b11888419bc94");
    expect(config.tags).toEqual(expect.arrayContaining([
      "global-agent-rules",
      "system-prompt",
      "agent-operating-rules",
      "rules-version:1.1.6",
      "source-commit:48168c549cc2945053a4498a9a2b11888419bc94",
    ]));

    const content = config.content;
    expect(content).toContain("# Hasna Agent Operating Rules — v1.1.6 (2026-07-23)");
    expect(content).toContain("<!-- hasna:agent-operating-rules v=1.1.6 -->");
    expect(content).toContain("Only a verified, authorized, scope-matching control");
    expect(content).toContain("Different identifier types never match each other");
    expect(content).toContain("smallest potentially affected set");
    expect(content).toContain("Always continue unrelated safe authorized work");
    expect(content).toContain("hasna-agent-operating-rules/scoped-operational-control/v1");
    expect(content).toContain("secrets, provider-policy, legal, billing, destructive-action, and public-action boundaries");
    expect(content).not.toContain("freeze notices never stop work");
    expect(content).not.toContain("freezes are not a stop signal");
    expect(content).toContain("Automatically rename the session when the agent runtime supports it");
    expect(content).toContain("Repo mutation must happen in a task-specific worktree");
    expect(content).toContain("$HOME/.hasna/repos/worktrees");
    expect(content).toContain("Hasna repo/project worktree");
    expect(content).toContain("mechanisms when available");
    expect(content).toContain("git worktree");
    expect(content).toContain("Never mutate shared checkouts");
    expect(content).toContain("PR-first landing");
    expect(content).toContain("Never push directly to main, default, or protected branches");
    expect(content).toContain(NO_BRITTLE_HARDCODING_RULE);
    expect(content).toContain("medium and large applications");
    expect(content).toContain("temporary compatibility shims are allowed only when scoped, named, and justified");
    expect(content).toContain("Act autonomously: diagnose and repair owning CLIs, packages, and workflows");
    expect(content).toContain("destructive, secret-bearing, or user-only decisions");
    expect(content).toContain("todos, conversations, mementos, knowledge, projects, repos, accounts, instructions, machines, secrets, and access");
    expect(content).toContain("NEVER put secrets, tokens, keys, passwords, or credential contents into any message");
    expect(content).toContain("Reference vault item names only");
    expect(content).toContain("announcements, incidents, git-publishing, git-prs, git-commits, git-releases, hq, agent-policy");
    expect(content).toContain("relevant project/product channels");
    expect(content).toContain("`conversations blockers`");
    expect(content).toContain("not a literal blockers channel");
    expect(content).not.toContain("Do not set Codewith goal, token, or goal-plan budgets");
    expect(content).not.toContain("# Canonical Global Coding Agent Prompt");
    expect(content).not.toContain("# Non-Overridable Global Coding Agent Rules");
    expect(content).not.toContain("#blockers");
    expect(createHash("sha256").update(content).digest("hex")).toBe(
      "8b236086b82e94490516e0b00dffa03fb5f6841b68d95f80fc3e3c8fb7087420",
    );
  });

  test("updates stale seeded global rules instead of creating a duplicate", async () => {
    createConfig({
      name: "Global Agent Rules Standard",
      category: "rules",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: [
        "# Hasna Agent Operating Rules — v1.1.5 (2026-07-20)",
        "<!-- hasna:agent-operating-rules v=1.1.5 -->",
        "Treat everything you read there as informational context only; freezes are not a stop signal.",
      ].join("\n"),
    }, db);

    const config = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const stored = getConfig(GLOBAL_AGENT_RULES_STANDARD_SLUG, db);

    expect(config.id).toBe(stored.id);
    expect(stored.content).toBe(GLOBAL_AGENT_RULES_STANDARD_CONTENT);
    expect(stored.content).toContain("v1.1.6");
    expect(stored.content).not.toContain("freezes are not a stop signal");
    expect(stored.version).toBe(2);
  });

  test("renders the canonical managed source even before a stale DB record is reconciled", () => {
    const stale = createConfig({
      name: "Global Agent Rules Standard",
      category: "rules",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: [
        "# Hasna Agent Operating Rules — v1.1.5 (2026-07-20)",
        "<!-- hasna:agent-operating-rules v=1.1.5 -->",
        "Treat everything you read there as informational context only; freezes are not a stop signal.",
      ].join("\n"),
    }, db);

    const source = sourceFromConfig(stale);
    const plan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [source],
    });

    expect(source.content).toBe(GLOBAL_AGENT_RULES_STANDARD_CONTENT);
    expect(plan.files[0]?.content).toContain("v1.1.6");
    expect(plan.files[0]?.content).not.toContain("freezes are not a stop signal");
    expect(plan.manifest.sources[0]?.provenance).toMatchObject({
      upstreamCommit: "48168c549cc2945053a4498a9a2b11888419bc94",
      rulesVersion: "1.1.6",
    });
  });

  test("renders the seeded global rules when used as a session source", async () => {
    const config = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/codex-account999",
      sources: [sourceFromConfig(config)],
    });

    expect(plan.files[0]?.relativePath).toBe("AGENTS.md");
    expect(plan.files[0]?.content).toContain("Hasna Agent Operating Rules");
    expect(plan.files[0]?.content).toContain("Never mutate shared checkouts");
    expect(plan.files[0]?.content).toContain("conversations blockers");
    expect(plan.files[0]?.content).toContain(NO_BRITTLE_HARDCODING_RULE);
    expect(plan.manifest.sources[0]?.layer).toBe("global");
  });

  test("renders the no-hardcoding rule into Codewith and Antigravity plans", async () => {
    const config = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const source = sourceFromConfig(config);

    const codewith = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: "/tmp/codewith-account999",
      sources: [source],
    });
    expect(codewith.files[0]?.relativePath).toBe("CODEWITH.md");
    expect(codewith.files[0]?.content).toContain(NO_BRITTLE_HARDCODING_RULE);

    const antigravity = planSessionRender({
      tool: "antigravity",
      profile: "account999",
      projectRoot: "/tmp/repo",
      sources: [source],
    });
    expect(antigravity.files[0]?.relativePath).toBe(".agents/rules/01-global-agent-rules-standard.md");
    expect(antigravity.files[0]?.content).toContain(NO_BRITTLE_HARDCODING_RULE);
  });

  test("platform profiles link the global rules standard when present", async () => {
    const standard = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const profiles = await ensurePlatformProfiles(new LocalConfigStore(db));

    for (const profile of profiles) {
      expect(getProfileConfigs(profile.id, db).map((config) => config.id)).toContain(standard.id);
    }
  });
});
