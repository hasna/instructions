import { LocalConfigStore } from "../data/config-store";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConfig, getConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { getProfileConfigs } from "../db/profiles";
import { ensurePlatformProfiles, PLATFORM_PROFILE_PRESETS } from "./platform-profiles";
import {
  PROJECT_DASHBOARD_PROFILE_VARIABLES,
  PROJECT_DASHBOARD_STANDARD_CONTENT,
  PROJECT_DASHBOARD_STANDARD_SLUG,
  ensureProjectDashboardStandardConfig,
} from "./project-dashboard-standard";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["CONFIGS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

describe("project dashboard standard", () => {
  test("seeds the agent-managed project dashboard reference", async () => {
    const config = await ensureProjectDashboardStandardConfig(new LocalConfigStore(db));

    expect(config.slug).toBe(PROJECT_DASHBOARD_STANDARD_SLUG);
    expect(config.kind).toBe("reference");
    expect(config.category).toBe("workspace");
    expect(config.agent).toBe("global");
    expect(config.tags).toEqual(expect.arrayContaining(["projects-dashboard", "json-render"]));
    expect(config.content).toContain(".hasna/project/dashboard/render.json");
    expect(config.content).toContain("projects dashboard serve");
    expect(config.content).toContain("iproj-<project-slug>");
    expect(config.content).not.toContain(`sk-${"proj"}-`);
  });

  test("updates stale seeded content instead of creating a duplicate", async () => {
    createConfig({
      name: "Agent Managed Project Dashboard Standard",
      category: "workspace",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: "old content",
    }, db);

    const config = await ensureProjectDashboardStandardConfig(new LocalConfigStore(db));
    const stored = getConfig(PROJECT_DASHBOARD_STANDARD_SLUG, db);

    expect(config.id).toBe(stored.id);
    expect(stored.content).toBe(PROJECT_DASHBOARD_STANDARD_CONTENT);
    expect(stored.version).toBe(2);
  });

  test("platform profiles include dashboard variables and link the standard config", async () => {
    const standard = await ensureProjectDashboardStandardConfig(new LocalConfigStore(db));
    const profiles = await ensurePlatformProfiles(new LocalConfigStore(db));

    for (const preset of PLATFORM_PROFILE_PRESETS) {
      expect(preset.variables).toMatchObject(PROJECT_DASHBOARD_PROFILE_VARIABLES);
    }
    for (const profile of profiles) {
      expect(profile.variables).toMatchObject(PROJECT_DASHBOARD_PROFILE_VARIABLES);
      expect(getProfileConfigs(profile.id, db).map((config) => config.id)).toContain(standard.id);
    }
  });
});
