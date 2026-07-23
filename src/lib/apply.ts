import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ApplyResult, Config, ConfigOutput } from "../types/index.js";
import { ConfigApplyError } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";
import type { ProfileVariables } from "../types/index.js";
import { isRetiredOrUnsupportedConfigAgent } from "./config-agents.js";
import { renderMachineAwareContent, renderMachineAwareContentPreview } from "./machine.js";
import {
  ANTIGRAVITY_RULE_FILE_CHAR_LIMIT,
  SESSION_RENDER_PROFILE_ENTRYPOINTS,
  SESSION_RENDERER_OWNER_ID,
} from "./session-render.js";
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

export interface ConfigApplySkippedTarget {
  config_id: string;
  config_slug: string;
  path: string;
  owner: typeof SESSION_RENDERER_OWNER_ID | "equivalent-profile-config" | "retired-provider-config";
  reason: string;
}

export interface ConfigApplyPreviewFailure {
  config_id: string;
  config_slug: string;
  message: string;
}

export interface ConfigApplyPreview {
  results: ApplyResult[];
  skipped: ConfigApplySkippedTarget[];
  failures: ConfigApplyPreviewFailure[];
}

interface PreparedConfigBatch {
  configs: Config[];
  skipped: ConfigApplySkippedTarget[];
  failures: ConfigApplyPreviewFailure[];
}

async function writeConfigResult(
  config: Config,
  targetPath: string,
  content: string,
  opts: ApplyOptions,
  meta: Pick<ApplyResult, "agent" | "transform"> = {}
): Promise<ApplyResult> {
  const renderedTarget = opts.vars
    ? renderForApply(targetPath, opts.vars, opts.dryRun === true)
    : { content: targetPath, unresolved: [] };
  const rendered = opts.vars
    ? renderForApply(content, opts.vars, opts.dryRun === true)
    : { content, unresolved: [] };
  const renderedTargetPath = renderedTarget.content;
  const renderedContent = rendered.content;
  const targetAgent = meta.agent ?? config.agent;
  if (isAntigravityRuleTarget(targetAgent, renderedTargetPath) && renderedContent.length > ANTIGRAVITY_RULE_FILE_CHAR_LIMIT) {
    throw new ConfigApplyError(
      `Antigravity rule file ${renderedTargetPath} is ${renderedContent.length} characters; split it before applying because Antigravity limits rule files to ${ANTIGRAVITY_RULE_FILE_CHAR_LIMIT} characters.`
    );
  }
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
    unresolved_template_vars: [...new Set([
      ...renderedTarget.unresolved,
      ...rendered.unresolved,
    ])].sort(),
    ...meta,
  };
}

function renderForApply(
  content: string,
  variables: ProfileVariables,
  preview: boolean,
): { content: string; unresolved: string[] } {
  if (preview) return renderMachineAwareContentPreview(content, variables);
  return {
    content: renderMachineAwareContent(content, variables),
    unresolved: [],
  };
}

function isAntigravityRuleTarget(agent: Config["agent"] | undefined, targetPath: string): boolean {
  return agent === "antigravity" && /\.(md|mdc|markdown)$/i.test(targetPath);
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
  if (opts.outputAgent && isRetiredOrUnsupportedConfigAgent(opts.outputAgent)) {
    throw new ConfigApplyError(`Config output agent "${opts.outputAgent}" is retired or unsupported — cannot apply to disk.`);
  }
  if (isRetiredOrUnsupportedConfigAgent(config.agent)) {
    throw new ConfigApplyError(`Config "${config.name}" uses retired or unsupported agent "${config.agent}" — cannot apply to disk.`);
  }

  const selectedOutputs = opts.outputAgent
    ? config.outputs.filter((output) => output.agent === opts.outputAgent)
    : config.outputs.filter((output) => !isRetiredOrUnsupportedConfigAgent(output.agent));
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
    result.unresolved_template_vars = [...new Set([
      ...(result.unresolved_template_vars ?? []),
      ...outputResults.flatMap((output) => output.unresolved_template_vars ?? []),
    ])].sort();
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
  const prepared = prepareConfigBatch(configs);
  if (prepared.failures.length > 0) {
    throw new ConfigApplyError(prepared.failures.map((failure) => failure.message).join("; "));
  }
  const results: ApplyResult[] = [];
  for (const config of prepared.configs) {
    if (config.kind === "reference") continue;
    if (isRetiredOrUnsupportedConfigAgent(config.agent)) continue;
    results.push(await applyConfig(config, opts));
  }
  return results;
}

export async function previewConfigs(
  configs: Config[],
  opts: Omit<ApplyOptions, "dryRun"> = {},
): Promise<ConfigApplyPreview> {
  const prepared = prepareConfigBatch(configs);
  const results: ApplyResult[] = [];
  const failures = [...prepared.failures];
  for (const config of prepared.configs) {
    if (config.kind === "reference" || isRetiredOrUnsupportedConfigAgent(config.agent)) continue;
    try {
      results.push(await applyConfig(config, { ...opts, dryRun: true }));
    } catch (error) {
      failures.push({
        config_id: config.id,
        config_slug: config.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    results,
    skipped: prepared.skipped,
    failures,
  };
}

function prepareConfigBatch(configs: Config[]): PreparedConfigBatch {
  const skipped: ConfigApplySkippedTarget[] = [];
  const activeConfigs = configs.filter((config) => {
    if (!isRetiredOrUnsupportedConfigAgent(config.agent)) return true;
    for (const target of configTargets(config)) {
      skipped.push({
        config_id: config.id,
        config_slug: config.slug,
        path: target.path,
        owner: "retired-provider-config",
        reason: `retired or unsupported provider config "${config.agent}" is excluded from profile apply`,
      });
    }
    return false;
  });
  const { configs: deduplicated, duplicates } = deduplicateEquivalentProfileConfigs(activeConfigs);
  for (const duplicate of duplicates) {
    for (const target of configTargets(duplicate)) {
      skipped.push({
        config_id: duplicate.id,
        config_slug: duplicate.slug,
        path: target.path,
        owner: sessionRendererOwnsTarget(target.path)
          ? SESSION_RENDERER_OWNER_ID
          : "equivalent-profile-config",
        reason: sessionRendererOwnsTarget(target.path)
          ? "provider instruction entrypoint is owned by the Instructions session renderer"
          : "equivalent profile config is superseded by the newer identical source",
      });
    }
  }

  const prepared = deduplicated.flatMap((config) => {
    const primaryOwned = config.target_path ? sessionRendererOwnsTarget(config.target_path) : false;
    const outputs = config.outputs.filter((output) => {
      const retiredOutput = isRetiredOrUnsupportedConfigAgent(output.agent);
      const sessionOwned = sessionRendererOwnsTarget(output.target_path) || output.agent === "antigravity";
      if (!retiredOutput && !sessionOwned) return true;
      skipped.push({
        config_id: config.id,
        config_slug: config.slug,
        path: normalizeTargetPath(output.target_path),
        owner: retiredOutput ? "retired-provider-config" : SESSION_RENDERER_OWNER_ID,
        reason: retiredOutput
          ? `retired or unsupported provider output "${output.agent}" is excluded from profile apply`
          : output.agent === "antigravity"
            ? "project-scoped Antigravity rules are owned by the Instructions session renderer"
            : "provider instruction entrypoint is owned by the Instructions session renderer",
      });
      return false;
    });
    if (primaryOwned && config.target_path) {
      skipped.push({
        config_id: config.id,
        config_slug: config.slug,
        path: normalizeTargetPath(config.target_path),
        owner: SESSION_RENDERER_OWNER_ID,
        reason: "provider instruction entrypoint is owned by the Instructions session renderer",
      });
    }
    if (primaryOwned && outputs.length === 0) return [];
    if (!primaryOwned && outputs.length === config.outputs.length) return [config];
    return [{
      ...config,
      target_path: primaryOwned ? null : config.target_path,
      outputs,
    }];
  });

  const failures = duplicateTargetFailures(prepared);
  return { configs: prepared, skipped, failures };
}

function deduplicateEquivalentProfileConfigs(configs: Config[]): {
  configs: Config[];
  duplicates: Config[];
} {
  const groups = new Map<string, Config[]>();
  const withoutPrimary: Config[] = [];
  for (const config of configs) {
    if (!config.target_path) {
      withoutPrimary.push(config);
      continue;
    }
    const key = JSON.stringify([
      normalizeTargetPath(config.target_path),
      config.agent,
      config.category,
      config.content,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), config]);
  }
  const kept = [...withoutPrimary];
  const duplicates: Config[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at) || left.slug.localeCompare(right.slug)
    );
    kept.push(ordered[0]!);
    duplicates.push(...ordered.slice(1));
  }
  const order = new Map(configs.map((config, index) => [config.id, index]));
  kept.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  return { configs: kept, duplicates };
}

function configTargets(config: Config): Array<{ path: string; owner: string }> {
  return [
    ...(config.target_path
      ? [{ path: normalizeTargetPath(config.target_path), owner: `${config.slug}:primary` }]
      : []),
    ...config.outputs.map((output) => ({
      path: normalizeTargetPath(output.target_path),
      owner: `${config.slug}:output:${output.agent}`,
    })),
  ];
}

function duplicateTargetFailures(configs: Config[]): ConfigApplyPreviewFailure[] {
  const targets = new Map<string, Array<{ config: Config; owner: string }>>();
  for (const config of configs) {
    for (const target of configTargets(config)) {
      targets.set(target.path, [
        ...(targets.get(target.path) ?? []),
        { config, owner: target.owner },
      ]);
    }
  }
  return [...targets.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([path, owners]) => ({
      config_id: owners[0]!.config.id,
      config_slug: owners[0]!.config.slug,
      message: `Multiple profile writers target ${path}: ${owners.map((owner) => owner.owner).join(", ")}`,
    }));
}

function sessionRendererOwnsTarget(targetPath: string): boolean {
  const normalized = normalizeTargetPath(targetPath);
  return SESSION_RENDER_PROFILE_ENTRYPOINTS.some((relativePath) =>
    normalized === normalizeTargetPath(join(getConfigHome(), ...relativePath.split("/")))
  );
}
