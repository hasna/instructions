import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { LocalConfigStore } from "../data/config-store";
import { createConfig, getConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { getProfileConfigs } from "../db/profiles";
import { ensurePlatformProfiles } from "./platform-profiles";
import { planSessionRender, sourceFromConfig } from "./session-render";
import {
  GLOBAL_AGENT_RULES_STANDARD_CONTENT,
  GLOBAL_AGENT_RULES_STANDARD_SLUG,
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
    expect(config.tags).toEqual(expect.arrayContaining(["global-agent-rules", "system-prompt"]));

    const content = config.content;
    expect(content).toContain("automatic session renaming");
    expect(content).toContain("Repo mutation must happen in a task-scoped worktree");
    expect(content).toContain("$HOME/.hasna/repos/worktrees");
    expect(content).toContain("Hasna repo/project worktree");
    expect(content).toContain("mechanisms when available");
    expect(content).toContain("git worktree");
    expect(content).toContain("Never mutate shared checkouts");
    expect(content).toContain("PR-first landing");
    expect(content).toMatch(/Never push directly to `main`, the default branch, or any protected branch/);
    expect(content).toContain("Act autonomously");
    expect(content).toContain("owning\n   CLIs, packages, and workflows");
    expect(content).toContain("destructive decisions, secret-bearing decisions, user-only authority");
    expect(content).toContain("`todos`, `conversations`,\n   `mementos`, `knowledge`, `projects`, `repos`, `accounts`,");
    expect(content).toContain("`instructions`, `machines`, `secrets`, and `access`");
    expect(content).toContain("Secrets safety is mandatory");
    expect(content).toContain("Never expose secrets in prompts, tasks");
    expect(content).toContain("Reference vault item names, secret identifiers, and\n   access grants only");
    expect(content).toContain("`announcements`");
    expect(content).toContain("`incidents`");
    expect(content).toContain("`git-publishing`");
    expect(content).toContain("`git-prs`, `git-commits`, and `git-releases`");
    expect(content).toContain("`hq`");
    expect(content).toContain("`agent-policy`");
    expect(content).toContain("project/product\n   channels");
    expect(content).toContain("`conversations blockers`");
    expect(content).toContain("Do not invent or refer to a literal blockers channel");
    expect(content).toContain("Never set Codewith goal/token budgets or goal-plan budgets");
    expect(content).not.toContain("#blockers");
  });

  test("updates stale seeded global rules instead of creating a duplicate", async () => {
    createConfig({
      name: "Global Agent Rules Standard",
      category: "rules",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: "old content",
    }, db);

    const config = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const stored = getConfig(GLOBAL_AGENT_RULES_STANDARD_SLUG, db);

    expect(config.id).toBe(stored.id);
    expect(stored.content).toBe(GLOBAL_AGENT_RULES_STANDARD_CONTENT);
    expect(stored.version).toBe(2);
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
    expect(plan.files[0]?.content).toContain("Global Coding Agent Rules Standard");
    expect(plan.files[0]?.content).toContain("Never mutate shared checkouts");
    expect(plan.files[0]?.content).toContain("conversations blockers");
    expect(plan.manifest.sources[0]?.layer).toBe("global");
  });

  test("platform profiles link the global rules standard when present", async () => {
    const standard = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const profiles = await ensurePlatformProfiles(new LocalConfigStore(db));

    for (const profile of profiles) {
      expect(getProfileConfigs(profile.id, db).map((config) => config.id)).toContain(standard.id);
    }
  });
});
