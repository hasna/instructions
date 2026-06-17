import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database";
import { createConfig } from "./configs";
import { createProfile, getProfile, listProfiles, updateProfile, deleteProfile, addConfigToProfile, removeConfigFromProfile, getProfileConfigs, resolveProfileForMachine } from "./profiles";
import type { Database } from "bun:sqlite";
import { detectMachineContext } from "../lib/machine";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["CONFIGS_DB_PATH"] = ":memory:";
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
});
