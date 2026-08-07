import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database";
import { createConfig } from "./configs";
import { createProfile, getProfile, listProfiles, listProfilesPage, updateProfile, deleteProfile, addConfigToProfile, removeConfigFromProfile, getProfileConfigs, getProfileConfigsPage, resolveProfileForMachine, resolveProfileForMachineRead } from "./profiles";
import type { Database } from "bun:sqlite";
import { detectMachineContext } from "../lib/machine";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

describe("profiles", () => {
  test("creates and retrieves a profile", () => {
    const p = createProfile({
      name: "My Setup",
      selectors: { os: ["linux"], arch: ["arm64"] },
      variables: { WORKSPACE_ROOT: "{{HOME_DIR}}/workspace" },
    }, db);
    expect(p.name).toBe("My Setup");
    expect(p.slug).toBe("my-setup");
    expect(p.selectors.os).toEqual(["linux"]);
    expect(p.variables["WORKSPACE_ROOT"]).toBe("{{HOME_DIR}}/workspace");
  });

  test("getProfile by slug", () => {
    const p = createProfile({ name: "Test Profile" }, db);
    expect(getProfile(p.slug, db).id).toBe(p.id);
  });

  test("throws ProfileNotFoundError for missing", () => {
    expect(() => getProfile("nope", db)).toThrow("Profile not found: nope");
  });

  test("listProfiles returns all", () => {
    createProfile({ name: "A" }, db);
    createProfile({ name: "B" }, db);
    expect(listProfiles(db).length).toBe(2);
  });

  test("listProfilesPage returns exact source-bounded metadata", () => {
    for (const name of ["A", "B", "C", "D", "E"]) createProfile({ name }, db);
    const page = listProfilesPage({ limit: 2, cursor: 2 }, db);

    expect(page.items.map((profile) => profile.name)).toEqual(["C", "D"]);
    expect(page).toMatchObject({
      total: 5,
      limit: 2,
      cursor: 2,
      next_cursor: 4,
      has_more: true,
      complete: false,
      truncated: false,
    });
  });

  test("updateProfile changes name and slug", () => {
    const p = createProfile({ name: "Old" }, db);
    const updated = updateProfile(p.id, {
      name: "New",
      selectors: { os: ["macos"], arch: ["arm64"], hostnames: ["macos-node-a"] },
      variables: { BUN_PATH: "/opt/homebrew/bin/bun" },
    }, db);
    expect(updated.name).toBe("New");
    expect(updated.slug).toBe("new");
    expect(updated.selectors.hostnames).toEqual(["macos-node-a"]);
    expect(updated.variables["BUN_PATH"]).toBe("/opt/homebrew/bin/bun");
  });

  test("deleteProfile removes it", () => {
    const p = createProfile({ name: "Del" }, db);
    deleteProfile(p.id, db);
    expect(() => getProfile(p.id, db)).toThrow();
  });

  test("addConfigToProfile and getProfileConfigs", () => {
    const p = createProfile({ name: "P" }, db);
    const c = createConfig({ name: "C", category: "rules", content: "" }, db);
    addConfigToProfile(p.id, c.id, db);
    const configs = getProfileConfigs(p.id, db);
    expect(configs.length).toBe(1);
    expect(configs[0]!.id).toBe(c.id);
  });

  test("getProfileConfigsPage bounds membership rows at the source", () => {
    const p = createProfile({ name: "P" }, db);
    for (let i = 1; i <= 5; i++) {
      const config = createConfig({ name: `C${i}`, category: "rules", content: "" }, db);
      addConfigToProfile(p.id, config.id, db);
    }
    const page = getProfileConfigsPage(p.id, { limit: 2, cursor: 4 }, db);

    expect(page.items.map((config) => config.slug)).toEqual(["c5"]);
    expect(page).toMatchObject({
      total: 5,
      limit: 2,
      cursor: 4,
      next_cursor: null,
      has_more: false,
      complete: true,
      truncated: false,
    });
  });

  test("removeConfigFromProfile removes it", () => {
    const p = createProfile({ name: "P" }, db);
    const c = createConfig({ name: "C", category: "rules", content: "" }, db);
    addConfigToProfile(p.id, c.id, db);
    removeConfigFromProfile(p.id, c.id, db);
    expect(getProfileConfigs(p.id, db).length).toBe(0);
  });

  test("resolveProfileForMachine picks the most specific selector match", () => {
    createProfile({
      name: "linux-arm64",
      selectors: { os: ["linux"], arch: ["arm64"] },
      variables: { WORKSPACE_ROOT: "{{HOME_DIR}}/workspace" },
    }, db);
    createProfile({
      name: "macos-arm64",
      selectors: { os: ["macos"], arch: ["arm64"], hostnames: ["macos-node-a"] },
      variables: { WORKSPACE_ROOT: "{{HOME_DIR}}/Workspace" },
    }, db);

    const profile = resolveProfileForMachine(detectMachineContext({
      hostname: "macos-node-a",
      os: "Darwin",
      arch: "arm64",
      home_dir: "/Users/hasna",
    }), db);

    expect(profile?.slug).toBe("macos-arm64");
  });

  test("resolveProfileForMachineRead scans every source page before resolving", () => {
    for (let i = 1; i <= 4; i++) {
      createProfile({ name: `A${i}`, selectors: { hostnames: [`other-${i}`] } }, db);
    }
    createProfile({ name: "Z target", selectors: { hostnames: ["station02"] } }, db);

    const resolution = resolveProfileForMachineRead(detectMachineContext({
      hostname: "station02",
      os: "Linux",
      arch: "x64",
    }), { limit: 2 }, db);

    expect(resolution.profile?.slug).toBe("z-target");
    expect(resolution).toMatchObject({
      scanned: 5,
      total: 5,
      batch_limit: 2,
      complete: true,
      truncated: false,
    });
  });
});
