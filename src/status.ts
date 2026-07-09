import { existsSync, readFileSync } from "node:fs";
import { resolveConfigStore, type ConfigStore } from "./data/config-store.js";
import type { Config } from "./types/index.js";
import { expandPath } from "./lib/apply.js";
import { isRetiredOrUnsupportedConfigAgent } from "./lib/config-agents.js";
import { getPackageVersion } from "./lib/package-version.js";
import { redactContent, scanSecrets, type RedactFormat } from "./lib/redact.js";

const PACKAGE_NAME = "@hasna/instructions";
const PACKAGE_VERSION = getPackageVersion();

type ActiveDbEnv = "HASNA_INSTRUCTIONS_DB_PATH" | null;
type DatabaseKind = "memory" | "file";
type ContractStatus = "ok" | "warn";

export interface ConfigsStatusContract {
  service: "configs";
  schemaVersion: "1.0";
  package: {
    name: string;
    version: string;
  };
  env: {
    database: {
      primary: "HASNA_INSTRUCTIONS_DB_PATH";
      active: ActiveDbEnv;
      kind: DatabaseKind;
    };
  };
  counts: {
    configs: {
      total: number;
      file: number;
      reference: number;
      templates: number;
      retiredAgentRows: number;
    };
    byCategory: Record<string, number>;
    byAgent: Record<string, number>;
    byFormat: Record<string, number>;
    profiles: number;
    profileLinks: number;
    machines: number;
    snapshots: number;
    knownTargets: number;
  };
  health: {
    status: ContractStatus;
    databaseReachable: boolean;
    driftedTargets: number;
    missingTargets: number;
    unredactedSecretFindings: number;
    retiredAgentRows: number;
    hasDrift: boolean;
    hasMissingTargets: boolean;
    hasUnredactedSecrets: boolean;
    hasRetiredAgentRows: boolean;
  };
  safety: {
    includesConfigValues: false;
    includesPrivatePaths: false;
    includesHostnames: false;
    includesSecretValues: false;
    statusOutputIsMetadataOnly: true;
  };
}

function activeDatabaseEnv(): ActiveDbEnv {
  if (process.env["HASNA_INSTRUCTIONS_DB_PATH"]) return "HASNA_INSTRUCTIONS_DB_PATH";
  return null;
}

function configuredDatabaseKind(): DatabaseKind {
  const value = process.env["HASNA_INSTRUCTIONS_DB_PATH"] ?? "";
  return value === ":memory:" || value.startsWith("file::memory:") ? "memory" : "file";
}

function countBy<T>(items: T[], getValue: (item: T) => string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = getValue(item);
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export async function getConfigsStatus(
  store: ConfigStore = resolveConfigStore(),
): Promise<ConfigsStatusContract> {
  let databaseReachable = true;
  let configs: Config[] = [];
  let categoryStats: Record<string, number> = { total: 0 };

  try {
    configs = await store.listConfigs();
    categoryStats = await store.getConfigStats();
  } catch {
    databaseReachable = false;
  }

  const fileConfigs = configs.filter((config) => config.kind === "file");
  const retiredAgentRows = configs.filter((config) => isRetiredOrUnsupportedConfigAgent(config.agent)).length;
  let driftedTargets = 0;
  let missingTargets = 0;
  let unredactedSecretFindings = 0;
  let knownTargets = 0;

  for (const config of fileConfigs) {
    unredactedSecretFindings += scanSecrets(config.content, config.format as RedactFormat).length;
    if (isRetiredOrUnsupportedConfigAgent(config.agent)) continue;
    if (!config.target_path) continue;

    knownTargets += 1;
    const targetPath = expandPath(config.target_path);
    if (!existsSync(targetPath)) {
      missingTargets += 1;
      continue;
    }

    const disk = readFileSync(targetPath, "utf-8");
    const { content: redactedDisk } = redactContent(disk, config.format as RedactFormat);
    if (redactedDisk !== config.content) {
      driftedTargets += 1;
    }
  }

  let profiles = 0;
  let machines = 0;
  let profileLinks = 0;
  let snapshots = 0;
  if (databaseReachable) {
    try {
      const profileList = await store.listProfiles();
      profiles = profileList.length;
      machines = (await store.listMachines()).length;
      for (const profile of profileList) {
        profileLinks += (await store.getProfileConfigs(profile.id)).length;
      }
      for (const config of configs) {
        snapshots += (await store.listSnapshots(config.id)).length;
      }
    } catch {
      databaseReachable = false;
    }
  }
  const byCategory = Object.fromEntries(Object.entries(categoryStats).filter(([key]) => key !== "total"));

  const status: ContractStatus =
    databaseReachable &&
    driftedTargets === 0 &&
    missingTargets === 0 &&
    unredactedSecretFindings === 0 &&
    retiredAgentRows === 0
      ? "ok"
      : "warn";

  return {
    service: "configs",
    schemaVersion: "1.0",
    package: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    env: {
      database: {
        primary: "HASNA_INSTRUCTIONS_DB_PATH",
        active: activeDatabaseEnv(),
        kind: configuredDatabaseKind(),
      },
    },
    counts: {
      configs: {
        total: configs.length,
        file: fileConfigs.length,
        reference: configs.filter((config) => config.kind === "reference").length,
        templates: configs.filter((config) => config.is_template).length,
        retiredAgentRows,
      },
      byCategory,
      byAgent: countBy(configs, (config) => config.agent),
      byFormat: countBy(configs, (config) => config.format),
      profiles,
      profileLinks,
      machines,
      snapshots,
      knownTargets,
    },
    health: {
      status,
      databaseReachable,
      driftedTargets,
      missingTargets,
      unredactedSecretFindings,
      retiredAgentRows,
      hasDrift: driftedTargets > 0,
      hasMissingTargets: missingTargets > 0,
      hasUnredactedSecrets: unredactedSecretFindings > 0,
      hasRetiredAgentRows: retiredAgentRows > 0,
    },
    safety: {
      includesConfigValues: false,
      includesPrivatePaths: false,
      includesHostnames: false,
      includesSecretValues: false,
      statusOutputIsMetadataOnly: true,
    },
  };
}
