import type { Database } from "bun:sqlite";
import type { CreateProfileInput, Profile } from "../types/index.js";
import { addConfigToProfile, createProfile, getProfile, profileHasSelectors, updateProfile } from "../db/profiles.js";
import { listConfigs } from "../db/configs.js";

export const PLATFORM_PROFILE_PRESETS: CreateProfileInput[] = [
  {
    name: "linux-arm64",
    description: "Default Linux arm64 profile for linux-node-a/linux-node-b-style machines",
    selectors: { os: ["linux"], arch: ["arm64"], hostnames: ["linux-node-a", "linux-node-b"] },
    variables: {
      WORKSPACE_ROOT: "{{HOME_DIR}}/workspace",
      BUN_BIN_DIR: "{{HOME_DIR}}/.bun/bin",
      BUN_PATH: "{{BUN_BIN_DIR}}/bun",
      PATH_PREFIX: "{{BUN_BIN_DIR}}",
    },
  },
  {
    name: "macos-arm64",
    description: "Default macOS arm64 profile for macos-node-a/macos-node-b-style machines",
    selectors: { os: ["macos"], arch: ["arm64"], hostnames: ["macos-node-a", "macos-node-b"] },
    variables: {
      WORKSPACE_ROOT: "{{HOME_DIR}}/Workspace",
      BUN_BIN_DIR: "{{HOME_DIR}}/.bun/bin",
      BUN_PATH: "/opt/homebrew/bin/bun",
      PATH_PREFIX: "/opt/homebrew/bin:{{BUN_BIN_DIR}}",
    },
  },
];

export function ensurePlatformProfiles(db?: Database): Profile[] {
  const configs = listConfigs(undefined, db);
  const ensured: Profile[] = [];

  for (const preset of PLATFORM_PROFILE_PRESETS) {
    let profile: Profile;
    try {
      profile = getProfile(preset.name, db);
      if (!profileHasSelectors(profile) || Object.keys(profile.variables).length === 0) {
        profile = updateProfile(profile.id, {
          description: profile.description ?? preset.description,
          selectors: profileHasSelectors(profile) ? profile.selectors : preset.selectors,
          variables: Object.keys(profile.variables).length > 0 ? profile.variables : preset.variables,
        }, db);
      }
    } catch {
      profile = createProfile(preset, db);
    }

    for (const config of configs) {
      addConfigToProfile(profile.id, config.id, db);
    }
    ensured.push(profile);
  }

  return ensured;
}
