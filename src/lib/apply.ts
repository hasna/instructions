import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { ApplyResult, Config, ConfigOutput } from "../types/index.js";
import { ConfigApplyError } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";
import type { ProfileVariables } from "../types/index.js";
import { renderMachineAwareContent } from "./machine.js";
import { applyTransform } from "./transforms.js";

export function getConfigHome(): string {
  return process.env["CONFIGS_HOME"] || process.env["HOME"] || homedir();
}

export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(getConfigHome(), p.slice(2));
  }
  return resolve(p);
}

export function normalizeTargetPath(p: string): string {
  const expanded = expandPath(p);
  try {
    return realpathSync(expanded);
  } catch {
    let current = expanded;
    const missingSegments: string[] = [];
    while (true) {
      if (existsSync(current)) {
        try {
          return resolve(realpathSync(current), ...missingSegments);
        } catch {
          return expanded;
        }
      }
      const parent = dirname(current);
      const name = basename(current);
      if (parent === current) return expanded;
      missingSegments.unshift(name);
      current = parent;
    }
  }
}

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  store?: ConfigStore;
  vars?: ProfileVariables;
  outputAgent?: Config["agent"];
}

async function writeConfigResult(
  config: Config,
  targetPath: string,
  content: string,
  opts: ApplyOptions,
  meta: Pick<ApplyResult, "agent" | "transform"> = {}
): Promise<ApplyResult> {
  const renderedTargetPath = opts.vars
    ? renderMachineAwareContent(targetPath, opts.vars)
    : targetPath;
  const renderedContent = opts.vars
    ? renderMachineAwareContent(content, opts.vars)
    : content;
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

    if (previousContent !== null && changed) {
      const store = opts.store ?? resolveConfigStore();
      await store.createSnapshot(config.id, previousContent, config.version);
    }

    writeFileSync(path, renderedContent, "utf-8");
  }

  return {
    config_id: config.id,
    path,
    previous_content: previousContent,
    new_content: renderedContent,
    dry_run: opts.dryRun ?? false,
    changed,
    ...meta,
  };
}

function isGeneratedOutputTarget(config: Config, configs: Config[]): boolean {
  if (!config.target_path) return false;
  const targetPath = normalizeTargetPath(config.target_path);
  return configs.some((candidate) =>
    candidate.id !== config.id &&
    candidate.outputs.some((output) => normalizeTargetPath(output.target_path) === targetPath)
  );
}

export async function applyConfig(
  config: Config,
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  const selectedOutputs = opts.outputAgent
    ? config.outputs.filter((output) => output.agent === opts.outputAgent)
    : config.outputs;
  const shouldApplyPrimary = !opts.outputAgent || config.agent === opts.outputAgent;

  if (config.kind === "reference" || ((!config.target_path || !shouldApplyPrimary) && selectedOutputs.length === 0)) {
    throw new ConfigApplyError(
      `Config "${config.name}" is a reference (kind=reference) and has no target_path — cannot apply to disk.`
    );
  }

  const store = opts.store ?? resolveConfigStore();
  const contextConfigs = selectedOutputs.length > 0 || config.target_path ? await store.listConfigs() : [config];
  if (isGeneratedOutputTarget(config, contextConfigs)) {
    throw new ConfigApplyError(
      `Config "${config.name}" targets a generated output path. Apply the canonical source config instead.`
    );
  }

  const outputResults: ApplyResult[] = [];

  for (const output of selectedOutputs) {
    outputResults.push(await applyOutput(config, output, contextConfigs, opts));
  }

  let result: ApplyResult;
  if (config.target_path && shouldApplyPrimary) {
    result = await writeConfigResult(config, config.target_path, config.content, opts);
    result.outputs = outputResults;
    result.changed = result.changed || outputResults.some((output) => output.changed);
  } else {
    result = {
      ...outputResults[0]!,
      outputs: outputResults.slice(1),
      changed: outputResults.some((output) => output.changed),
    };
  }

  if (!opts.dryRun) {
    await store.updateConfig(config.id, { synced_at: new Date().toISOString() });
  }

  return result;
}

async function applyOutput(
  config: Config,
  output: ConfigOutput,
  contextConfigs: Config[],
  opts: ApplyOptions
): Promise<ApplyResult> {
  const content = applyTransform(config, output, { configs: contextConfigs });
  return writeConfigResult(config, output.target_path, content, opts, {
    agent: output.agent,
    transform: output.transform,
  });
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
