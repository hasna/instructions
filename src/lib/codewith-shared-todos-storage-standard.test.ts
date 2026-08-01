import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LocalConfigStore } from "../data/config-store";
import { createConfig, getConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { getProfileConfigs } from "../db/profiles";
import { applySessionRender } from "./session-apply";
import { planSessionRender, selectProfileConfigsForSessionRender } from "./session-render";
import { ensurePlatformProfiles } from "./platform-profiles";
import { tempRootPath } from "./test-temp-root";
import {
  CODEWITH_SHARED_TODOS_STORAGE_POLICY_REFERENCE,
  CODEWITH_SHARED_TODOS_STORAGE_STANDARD_CONTENT,
  CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG,
  ensureCodewithSharedTodosStorageStandardConfig,
} from "./codewith-shared-todos-storage-standard";

let db: Database;
let tmpRoot = "";

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase(":memory:");
  tmpRoot = tempRootPath(`instructions-codewith-todos-${Date.now()}-${Math.random().toString(16).slice(2)}`);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
});

describe("Codewith shared Todos storage standard", () => {
  test("seeds the complete operational storage contract as a Codewith-only rule", async () => {
    const config = await ensureCodewithSharedTodosStorageStandardConfig(new LocalConfigStore(db));

    expect(config.slug).toBe(CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG);
    expect(config.kind).toBe("reference");
    expect(config.category).toBe("rules");
    expect(config.agent).toBe("codewith");
    expect(config.tags).toEqual(expect.arrayContaining([
      "codewith",
      "shared-todos-storage",
      "projects-linkage",
    ]));

    const content = config.content;
    expect(content).toContain(CODEWITH_SHARED_TODOS_STORAGE_POLICY_REFERENCE);
    expect(content).toContain("all operational Codewith work");
    expect(content).toContain("repositories of every\n  name, work projects, research projects, coordinators, delegated workers, and\n  native scheduled or recurring loops");
    expect(content).toContain("It is not limited to `open-*` or\n  `iapp-*` repositories");
    expect(content).toContain("managed shared Todos service");
    expect(content).toContain("On-box SQLite or file storage is permitted only inside disposable,\n  repository-owned tests");
    expect(content).toContain("tasks, plans, locks or claims,\n  comments, verification evidence, dispatch state, or handoff state");
    expect(content).toContain("Before any operational Todos mutation");
    expect(content).toContain("authoritative Projects\n  linkage");
    expect(content).toContain("sanitized status or route metadata");
    expect(content).toContain("managed server-backed route");
    expect(content).toContain("fail closed: do not mutate Todos");
    expect(content).toContain("repair the owning configuration or service route");
    expect(content).toContain("Prior on-box-only tasks, plans, comments, locks, verification, dispatch, or\n  handoff evidence are not authoritative");
    expect(content).toContain("independently verify the shared result");
  });

  test("replaces a repository-name-scoped predecessor without creating a duplicate", async () => {
    createConfig({
      name: "Codewith Shared Todos Storage Standard",
      category: "rules",
      agent: "codewith",
      format: "markdown",
      kind: "reference",
      content: "Use shared Todos storage only for open-* and iapp-* repositories.\n",
    }, db);

    const config = await ensureCodewithSharedTodosStorageStandardConfig(new LocalConfigStore(db));
    const stored = getConfig(CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG, db);

    expect(config.id).toBe(stored.id);
    expect(stored.content).toBe(CODEWITH_SHARED_TODOS_STORAGE_STANDARD_CONTENT);
    expect(stored.content).toContain("all operational Codewith work");
    expect(stored.version).toBe(2);
  });

  test("repairs missing policy links on every existing operational profile", async () => {
    const store = new LocalConfigStore(db);
    const profiles = await Promise.all([
      store.createProfile({ name: "live-codewith" }),
      store.createProfile({ name: "research-codewith" }),
      store.createProfile({ name: "coordinator-codewith" }),
    ]);

    const standard = await ensureCodewithSharedTodosStorageStandardConfig(store);

    for (const profile of profiles) {
      expect(getProfileConfigs(profile.id, db).map((config) => config.id)).toContain(standard.id);
    }
  });

  test("applies and independently verifies a fresh live-codewith session render", async () => {
    const store = new LocalConfigStore(db);
    const profile = await store.createProfile({
      name: "live-codewith",
      description: "Fresh live Codewith policy verification fixture",
    });
    await ensureCodewithSharedTodosStorageStandardConfig(store);

    const selection = selectProfileConfigsForSessionRender(getProfileConfigs(profile.id, db), "codewith");
    expect(selection.sources[0]?.nonOverridable).toBe(true);
    const targetHome = join(tmpRoot, "live-codewith");
    const plan = planSessionRender({
      tool: "codewith",
      profile: "live-codewith",
      targetHome,
      sources: selection.sources,
      skippedSources: selection.skippedSources,
    });
    const applied = applySessionRender(plan);

    expect(applied.applied).toBe(true);
    expect(applied.conflicts).toEqual([]);
    expect(existsSync(join(targetHome, "CODEWITH.md"))).toBe(true);
    const rendered = readFileSync(join(targetHome, "CODEWITH.md"), "utf8");
    expect(rendered).toContain("Profile: live-codewith");
    expect(rendered).toContain(CODEWITH_SHARED_TODOS_STORAGE_POLICY_REFERENCE);
    expect(rendered).toContain("all operational Codewith work");
    expect(rendered).toContain("fail closed: do not mutate Todos");
    expect(rendered).toContain("on-box-only tasks, plans, comments, locks, verification, dispatch");

    const manifest = JSON.parse(
      readFileSync(join(targetHome, ".hasna", "session-render-manifest.json"), "utf8"),
    ) as {
      profile: string;
      sources: Array<{ id: string; nonOverridable: boolean; provenance: { configAgent: string } }>;
    };
    expect(manifest.profile).toBe("live-codewith");
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0]).toMatchObject({
      id: CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG,
      nonOverridable: true,
      provenance: { configAgent: "codewith" },
    });

    const codexSelection = selectProfileConfigsForSessionRender(
      getProfileConfigs(profile.id, db),
      "codex",
    );
    expect(codexSelection.sources).toEqual([]);
    expect(codexSelection.skippedSources[0]).toMatchObject({
      id: CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG,
      reason: "rule targets a different provider",
    });
  });

  test("platform profiles link the managed Codewith storage standard", async () => {
    const standard = await ensureCodewithSharedTodosStorageStandardConfig(new LocalConfigStore(db));
    const profiles = await ensurePlatformProfiles(new LocalConfigStore(db));

    for (const profile of profiles) {
      expect(getProfileConfigs(profile.id, db).map((config) => config.id)).toContain(standard.id);
    }
  });
});
