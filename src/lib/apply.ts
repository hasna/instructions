import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { ApplyResult, Config } from "../types/index.js";
import { ConfigApplyError } from "../types/index.js";
import { getDatabase, now } from "../db/database.js";
import { updateConfig } from "../db/configs.js";
import { createSnapshot } from "../db/snapshots.js";
import type { ProfileVariables } from "../types/index.js";
import { renderMachineAwareContent } from "./machine.js";

export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  db?: ReturnType<typeof getDatabase>;
  vars?: ProfileVariables;
}

export async function applyConfig(
  config: Config,
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  if (!config.target_path) {
    throw new ConfigApplyError(
      `Config "${config.name}" is a reference (kind=reference) and has no target_path — cannot apply to disk.`
    );
  }

  const renderedTargetPath = opts.vars
    ? renderMachineAwareContent(config.target_path, opts.vars)
    : config.target_path;
  const renderedContent = opts.vars
    ? renderMachineAwareContent(config.content, opts.vars)
    : config.content;
  const path = expandPath(renderedTargetPath);
  const previousContent = existsSync(path)
    ? readFileSync(path, "utf-8")
    : null;
  const changed = previousContent !== renderedContent;

  if (!opts.dryRun) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Snapshot the old content before overwriting
    if (previousContent !== null && changed) {
      const db = opts.db || getDatabase();
      createSnapshot(config.id, previousContent, config.version, db);
    }

    writeFileSync(path, renderedContent, "utf-8");

    // Update synced_at in DB
    const db = opts.db || getDatabase();
    updateConfig(config.id, { synced_at: now() }, db);
  }

  return {
    config_id: config.id,
    path,
    previous_content: previousContent,
    new_content: renderedContent,
    dry_run: opts.dryRun ?? false,
    changed,
  };
}

export async function applyConfigs(
  configs: Config[],
  opts: ApplyOptions = {}
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const config of configs) {
    if (config.kind === "reference") continue;
    results.push(await applyConfig(config, opts));
  }
  return results;
}
