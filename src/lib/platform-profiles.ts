import type { CreateProfileInput, Profile } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";
import { PROJECT_DASHBOARD_PROFILE_VARIABLES } from "./project-dashboard-standard.js";

/** Pure selector check (mirrors db profileHasSelectors without touching sqlite). */
function profileHasSelectors(profile: Pick<Profile, "selectors">): boolean {
  const selectors = profile.selectors ?? {};
  return (selectors.os?.length ?? 0) > 0
    || (selectors.arch?.length ?? 0) > 0
    || (selectors.hostnames?.length ?? 0) > 0;
}

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
      ...PROJECT_DASHBOARD_PROFILE_VARIABLES,
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
      ...PROJECT_DASHBOARD_PROFILE_VARIABLES,
    },
  },
];

export async function ensurePlatformProfiles(store: ConfigStore = resolveConfigStore()): Promise<Profile[]> {
  const configs = await store.listConfigs();
  const ensured: Profile[] = [];

  for (const preset of PLATFORM_PROFILE_PRESETS) {
    let profile: Profile;
    try {
      profile = await store.getProfile(preset.name);
      if (!profileHasSelectors(profile) || Object.keys(profile.variables).length === 0) {
        profile = await store.updateProfile(profile.id, {
          description: profile.description ?? preset.description,
          selectors: profileHasSelectors(profile) ? profile.selectors : preset.selectors,
          variables: Object.keys(profile.variables).length > 0 ? profile.variables : preset.variables,
        });
      }
    } catch {
      profile = await store.createProfile(preset);
    }

    for (const config of configs) {
      await store.addConfigToProfile(profile.id, config.id);
    }
    ensured.push(profile);
  }

  return ensured;
}
