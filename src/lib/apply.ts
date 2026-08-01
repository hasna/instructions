import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ApplyResult, Config, ConfigFormat, ConfigOutput } from "../types/index.js";
import { ConfigApplyError } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";
import type { ProfileVariables } from "../types/index.js";
import { isRetiredOrUnsupportedConfigAgent } from "./config-agents.js";
import {
  detectMachineContext,
  machineContextToVariables,
  renderMachineAwareContentPreview,
  resolveProfileVariables,
} from "./machine.js";
import {
  ANTIGRAVITY_RULE_FILE_CHAR_LIMIT,
  SESSION_RENDER_OWNED_CONFIG_TARGETS,
  SESSION_RENDERER_OWNER_ID,
} from "./session-render.js";
import { sessionRenderOwnsPath } from "./session-render-ownership.js";
import { isSecretVarName, scanSecrets } from "./redact.js";
import { parseTemplateVars } from "./template.js";
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
  /**
   * Opt out of the session-renderer ownership guard for one apply. Deliberately
   * separate from `force` so that "overwrite even if unchanged" can never
   * silently become "overwrite renderer-owned instruction files". Off by
   * default; the only caller is the explicit `--allow-renderer-owned` flag.
   */
  allowSessionRendererOwned?: boolean;
}

export interface ConfigApplySkippedTarget {
  config_id: string;
  config_slug: string;
  path: string;
  owner: typeof SESSION_RENDERER_OWNER_ID | "equivalent-profile-config" | "retired-provider-config" | "unresolved-secret-placeholder";
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

interface CanonicalConfigPrimary {
  path: string;
  agent: Config["agent"];
  content: string;
}

interface CanonicalConfigOutput {
  sourceIndex: number;
  path: string;
  agent: ConfigOutput["agent"];
  transform: ConfigOutput["transform"];
  content: string;
}

interface CanonicalConfigApplyBehavior {
  primary: CanonicalConfigPrimary | null;
  outputs: CanonicalConfigOutput[];
  equivalenceKey: string;
}

async function writeConfigResult(
  config: Config,
  targetPath: string,
  content: string,
  opts: ApplyOptions,
  meta: Pick<ApplyResult, "agent" | "transform"> = {}
): Promise<ApplyResult> {
  const variables = opts.vars ?? {};
  const renderedTarget = renderForApply(targetPath, variables);
  const rendered = renderForApply(content, variables);
  const renderedTargetPath = renderedTarget.content;
  const renderedContent = rendered.content;
  const targetAgent = meta.agent ?? config.agent;
  if (sessionRendererOwnsTarget(renderedTargetPath, opts)) {
    throw new ConfigApplyError(
      `Config "${config.name}" targets ${normalizeTargetPath(renderedTargetPath)}, which is owned by ${SESSION_RENDERER_OWNER_ID}; use the Instructions session renderer.`
    );
  }
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
    primary_changed: changed,
    unresolved_template_vars: [...new Set([
      ...renderedTarget.unresolved,
      ...rendered.unresolved,
    ])].sort(),
    ...meta,
  };
}

/**
 * Render for apply, expanding every variable the map defines and preserving
 * every token it does not.
 *
 * Preserving is deliberate and is not laxity. The `{{NAME}}` namespace is
 * shared with the secret redactor in ./redact.ts, which rewrites credential
 * values to `{{NPM_TOKEN}}`-style placeholders so the values never enter the
 * store. Those placeholders MUST come out the other side untouched, and files
 * such as ~/.codex/config.toml carry them in the same file as {{HOME_DIR}} —
 * so the choice cannot be made per file, only per token.
 *
 * Failing the whole write instead would stop shipping configs that apply
 * correctly today, including a rules file that only ever mentions a token in
 * prose. Unresolved names are reported on `unresolved_template_vars` so the
 * caller can surface them rather than have them pass silently.
 *
 * Dry-run and real writes now render identically, which is what makes
 * `--dry-run` a prediction of the write rather than a different computation.
 */
function renderForApply(
  content: string,
  variables: ProfileVariables,
): { content: string; unresolved: string[] } {
  return renderMachineAwareContentPreview(content, variables);
}

/**
 * The variables an apply renders with when the caller supplies none.
 *
 * Every caller used to be trusted to pass `vars`, and four did not: the
 * `apply <id>` CLI command, the `apply_config` MCP tool, `push`, and
 * `syncToDir`. A missing map did not degrade rendering, it SKIPPED it, so the
 * stored template landed on disk verbatim — which put a literal
 * `{{HOME_DIR}}/.config/hasna/git-hooks/...` into core.hooksPath and left git
 * running no hooks at all, the mandatory staged-credential secrets scan among
 * them. Defaulting here, at the single funnel every caller passes through,
 * is what stops the fifth caller repeating it. Todos 26caf1b9.
 */
/**
 * Secret-class placeholders that would land on a file currently holding
 * something else in that slot — i.e. a write that would destroy a credential.
 *
 * Three states, and only the third is dangerous:
 *   - the target does not exist          -> nothing to destroy, write it
 *   - the target already holds the same
 *     placeholder                        -> it is already a template, not a
 *                                           live value; rewriting is a no-op in
 *                                           the slot that matters. This is what
 *                                           keeps ~/.claude/rules/credential-
 *                                           exposure.md shipping — a rules file
 *                                           whose {{NPM_TOKEN}} is prose.
 *   - the target exists WITHOUT it       -> the slot holds something real.
 *                                           ~/.codex/config.toml and
 *                                           ~/.claude.json are exactly this
 *                                           today; refuse.
 *
 * Deciding from observable disk state rather than from the token name is what
 * separates "documents a credential" from "is a credential", which no name-based
 * rule can do. Classification of which names are secret-class still comes from
 * redact.ts's own isSecretVarName, so the protected set cannot drift from the
 * set redaction creates.
 */
function wouldDestroyACredential(
  targetPath: string,
  renderedContent: string,
  format: ConfigFormat,
): string[] {
  const secretTokens = parseTemplateVars(renderedContent).filter(isSecretVarName);
  if (secretTokens.length === 0) return [];
  let current: string;
  try {
    const path = expandPath(targetPath);
    if (!existsSync(path)) return [];
    current = readFileSync(path, "utf-8");
  } catch {
    // Unreadable target: assume the worst rather than overwrite blind.
    return secretTokens;
  }
  // A byte-identical write cannot destroy anything, whatever it contains.
  if (current === renderedContent) return [];

  // FIRST, AND THE ONLY ONE THAT IS NOT A HEURISTIC: is a live credential
  // actually sitting in the target right now? `scanSecrets` is the SAME detector
  // whose output creates these placeholders, so asking it is symmetric with
  // ingest by construction — the thing that decided "this is a credential" on the
  // way in is the thing that decides whether one is still there on the way out.
  //
  // It answers the question the placeholder arithmetic below only approximates,
  // and it answers it without position, counting, or line matching: a live secret
  // on disk cannot survive a write, because the store never holds live values —
  // redaction is what put the placeholder in the row in the first place.
  //
  // It is also what keeps prose free. `~/.claude/rules/credential-exposure.md`
  // scans as ZERO findings: `isReferenceValue` excludes `{{...}}` outright, and a
  // markdown row goes through redactGeneric, which matches only real token SHAPES
  // (`npm_[A-Za-z0-9]{36,}` and friends) and never key names. So that file's
  // documentation of `NPM_TOKEN` is not mistaken for one, and — unlike any
  // line- or count-based rule — editing the prose around the placeholder stays
  // free.
  if (scanSecrets(current, format).length > 0) return secretTokens;

  // SECOND, as an independent backstop for a credential the detector cannot see
  // (an unknown key name carrying a value with no recognisable shape). Placeholder
  // arithmetic, but normalized: `{{NAME:default}}` counts as the same token,
  // because the renderer preserves that WHOLE form when it cannot resolve the
  // name, and an exact-string count of `{{NAME}}` therefore scores it zero and is
  // blind to it. Measured on main @ 4d34861: a stored
  // `authorization = "{{AUTHORIZATION:fallback}}"` overwrote a live value with the
  // guard fully armed.
  //
  // Kept deliberately as counts rather than promoted to line context. Counting
  // cannot see a RELOCATION (total conserved, placeholder moved onto the live
  // slot) — that case is what the scan above exists to catch. Line context would
  // see the relocation but would ALSO refuse an ordinary prose edit on the line
  // carrying the placeholder, which blocks the credential-hygiene rules file from
  // ever shipping an edit. A backstop that fires on correct behaviour is how a
  // guard gets routed around.
  return secretTokens.filter((name) => countPlaceholder(current, name) < countPlaceholder(renderedContent, name));
}

/**
 * Occurrences of one `{{NAME}}` token, counting the `{{NAME:default}}` spelling as
 * the same token. `name` reaches here only from the renderer's own capture group,
 * so it is `[A-Z0-9_]+` and carries no regex metacharacters.
 */
function countPlaceholder(content: string, name: string): number {
  return content.match(new RegExp(`\\{\\{${name}(?::[^}]*)?\\}\\}`, "g"))?.length ?? 0;
}

async function resolveApplyVariables(opts: ApplyOptions): Promise<ProfileVariables> {
  // MERGED, never chosen between. Asking "did the caller supply a map" is the
  // wrong question — reviewer sabinus measured that `vars: { FOO: "bar" }` is a
  // supplied map by any such test and still leaves {{HOME_DIR}} unexpanded,
  // which is the original defect reachable through a caller that passes
  // something. Machine defaults go underneath; whatever the caller supplies
  // wins key by key. There is then no map that can skip machine rendering.
  const machine = detectMachineContext();
  let base: ProfileVariables;
  try {
    const store = opts.store ?? resolveConfigStore();
    const profile = await store.resolveProfileForMachine(machine);
    base = resolveProfileVariables(profile, machine);
  } catch {
    // A profile lookup must never be the reason a config fails to render: the
    // machine context alone already defines every variable this repairs.
    base = machineContextToVariables(machine);
  }
  return { ...base, ...(opts.vars ?? {}) };
}

function isAntigravityRuleTarget(agent: Config["agent"] | undefined, targetPath: string): boolean {
  return agent === "antigravity" && /\.(md|mdc|markdown)$/i.test(targetPath);
}

function isGeneratedOutputTarget(
  config: Config,
  configs: Config[],
  opts: ApplyOptions,
): boolean {
  const primary = canonicalConfigApplyBehavior(config, opts, configs).primary;
  if (!primary) return false;
  return configs.some((candidate) =>
    candidate.id !== config.id &&
    canonicalConfigApplyBehavior(candidate, opts, configs).outputs.some((output) => output.path === primary.path)
  );
}

export async function applyConfig(
  config: Config,
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  // This refusal is also what keeps the direct-apply path from bypassing the
  // agent-operating-rules currency floor. That floor lives in the session-render pipeline,
  // not here, so writing the managed rules config straight to disk would skip it — but the
  // managed config is kind=reference, so it never gets past this line. If reference configs
  // ever become applicable, this path needs the floor applied explicitly.
  if (config.kind === "reference") {
    throw new ConfigApplyError(
      `Config "${config.name}" is a reference (kind=reference) and has no target_path — cannot apply to disk.`
    );
  }
  if (opts.outputAgent && isRetiredOrUnsupportedConfigAgent(opts.outputAgent)) {
    throw new ConfigApplyError(`Config output agent "${opts.outputAgent}" is retired or unsupported — cannot apply to disk.`);
  }
  if (isRetiredOrUnsupportedConfigAgent(config.agent)) {
    throw new ConfigApplyError(`Config "${config.name}" uses retired or unsupported agent "${config.agent}" — cannot apply to disk.`);
  }

  const report = await applyConfigsWithReport([config], opts);
  if (report.failures.length > 0) {
    throw new ConfigApplyError(report.failures.map((failure) => failure.message).join("; "));
  }
  const result = report.results[0];
  if (result) return result;
  const owned = report.skipped.find((entry) => entry.owner === SESSION_RENDERER_OWNER_ID);
  if (owned) {
    throw new ConfigApplyError(
      `Config "${config.name}" targets ${owned.path}, which is owned by ${SESSION_RENDERER_OWNER_ID}; use the Instructions session renderer.`
    );
  }
  throw new ConfigApplyError(`Config "${config.name}" has no writable targets after apply ownership checks.`);
}

async function applyPreparedConfig(
  config: Config,
  opts: ApplyOptions,
): Promise<ApplyResult> {
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
  if (isGeneratedOutputTarget(config, contextConfigs, opts)) {
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
    // `primary_changed` is already this target's own verdict from
    // writeConfigResult and must survive the aggregation below — the CLI and the
    // dashboard label this line with `result.path`, so OR-ing the outputs into
    // the flag they read reported a byte-identical file as "changed".
    result.changed = result.primary_changed || outputResults.some((output) => output.changed);
    result.unresolved_template_vars = [...new Set([
      ...(result.unresolved_template_vars ?? []),
      ...outputResults.flatMap((output) => output.unresolved_template_vars ?? []),
    ])].sort();
  } else {
    // No writable primary (no target_path, or it is renderer-owned): the first
    // output is promoted to the reported result. The spread keeps that output's
    // own `primary_changed`, which is correct — `path` now names that output.
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
  const report = await applyConfigsWithReport(configs, opts);
  if (report.failures.length > 0) {
    throw new ConfigApplyError(report.failures.map((failure) => failure.message).join("; "));
  }
  return report.results;
}

export async function applyConfigsWithReport(
  configs: Config[],
  opts: ApplyOptions = {},
): Promise<ConfigApplyPreview> {
  // Resolved once, before batch preparation, because the batch's duplicate-target
  // detection and the session-renderer ownership guard both compare RENDERED
  // target paths. With no variables those guards were comparing a literal
  // "{{HOME_DIR}}/..." against real homes and so could never match.
  const effective: ApplyOptions = { ...opts, vars: await resolveApplyVariables(opts) };
  const prepared = prepareConfigBatch(configs, effective);
  if (prepared.failures.length > 0) {
    return {
      results: [],
      skipped: prepared.skipped,
      failures: prepared.failures,
    };
  }
  const results: ApplyResult[] = [];
  const failures: ConfigApplyPreviewFailure[] = [];
  for (const config of prepared.configs) {
    if (config.kind === "reference" || isRetiredOrUnsupportedConfigAgent(config.agent)) continue;
    try {
      results.push(await applyPreparedConfig(config, effective));
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

export async function previewConfigs(
  configs: Config[],
  opts: Omit<ApplyOptions, "dryRun"> = {},
): Promise<ConfigApplyPreview> {
  return applyConfigsWithReport(configs, { ...opts, dryRun: true });
}

function prepareConfigBatch(configs: Config[], opts: ApplyOptions): PreparedConfigBatch {
  const skipped: ConfigApplySkippedTarget[] = [];
  const outputAgent = opts.outputAgent;
  const selectedConfigs = configs.map((config) => outputAgent
    ? {
      ...config,
      target_path: config.agent === outputAgent ? config.target_path : null,
      outputs: config.outputs.filter((output) => output.agent === outputAgent),
    }
    : config
  );
  const activeConfigs = selectedConfigs.filter((config) => {
    if (!isRetiredOrUnsupportedConfigAgent(config.agent)) return true;
    for (const target of configTargets(config, opts, selectedConfigs)) {
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
  // Rendering preserves a token it cannot resolve, which is correct for prose
  // and for a file that has no live value to lose — but NOT for a credential.
  // ~/.codex/config.toml and ~/.claude.json each hold a real secret on disk
  // while their stored rows hold {{AUTHORIZATION}} / {{PRIMARYAPIKEY}}, so
  // writing the preserved placeholder would DESTROY live auth material. Before
  // this change that was prevented only as a side effect of the throwing
  // renderer; make it explicit and visible instead.
  //
  // Classification comes from redact.ts's own isSecretVarName — the same
  // predicate that decides what becomes a placeholder in the first place — so
  // the protected set cannot drift away from the set being created. Prose
  // tokens ({{VAR}}, {{GUIDE_TEMPLATE}}, {{USAGE_DATA}}, {{WINDOW_DAYS}}) are
  // not secret-class and still apply normally.
  const renderSafeConfigs = activeConfigs.filter((config) => {
    const behavior = canonicalConfigApplyBehavior(config, opts, activeConfigs);
    const targets: Array<{ path: string; content: string }> = [
      ...(behavior.primary ? [{ path: behavior.primary.path, content: behavior.primary.content }] : []),
      ...behavior.outputs.map((output) => ({ path: output.path, content: output.content })),
    ];
    const blocked = [...new Set(targets.flatMap((target) => wouldDestroyACredential(target.path, target.content, config.format)))].sort();
    if (blocked.length === 0) return true;
    for (const target of targets) {
      skipped.push({
        config_id: config.id,
        config_slug: config.slug,
        path: target.path,
        owner: "unresolved-secret-placeholder",
        reason: `no value for ${blocked.map((name) => `{{${name}}}`).join(", ")} and the file holds something else there; writing the placeholder would overwrite a live credential`,
      });
    }
    return false;
  });

  const { configs: deduplicated, duplicates } = deduplicateEquivalentProfileConfigs(renderSafeConfigs, opts);
  for (const duplicate of duplicates) {
    for (const target of configTargets(duplicate, opts, activeConfigs)) {
      skipped.push({
        config_id: duplicate.id,
        config_slug: duplicate.slug,
        path: target.path,
        owner: sessionRendererOwnsCanonicalTarget(target.path, opts)
          ? SESSION_RENDERER_OWNER_ID
          : "equivalent-profile-config",
        reason: sessionRendererOwnsCanonicalTarget(target.path, opts)
          ? "provider instruction entrypoint is owned by the Instructions session renderer"
          : "equivalent profile config is superseded by the newer identical source",
      });
    }
  }

  const prepared = deduplicated.flatMap((config) => {
    const behavior = canonicalConfigApplyBehavior(config, opts, activeConfigs);
    const primaryOwned = behavior.primary
      ? sessionRendererOwnsCanonicalTarget(behavior.primary.path, opts)
      : false;
    const outputs = config.outputs.filter((output, sourceIndex) => {
      const canonicalOutput = behavior.outputs.find((candidate) => candidate.sourceIndex === sourceIndex)!;
      const retiredOutput = isRetiredOrUnsupportedConfigAgent(output.agent);
      const sessionOwned = sessionRendererOwnsCanonicalTarget(canonicalOutput.path, opts);
      if (!retiredOutput && !sessionOwned) return true;
      skipped.push({
        config_id: config.id,
        config_slug: config.slug,
        path: canonicalOutput.path,
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
        path: behavior.primary!.path,
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

  const failures = duplicateTargetFailures(prepared, opts);
  return { configs: prepared, skipped, failures };
}

function deduplicateEquivalentProfileConfigs(
  configs: Config[],
  opts: ApplyOptions,
): {
  configs: Config[];
  duplicates: Config[];
} {
  const groups = new Map<string, Config[]>();
  const withoutTargets: Config[] = [];
  for (const config of configs) {
    const behavior = canonicalConfigApplyBehavior(config, opts, configs);
    if (!behavior.primary && behavior.outputs.length === 0) {
      withoutTargets.push(config);
      continue;
    }
    groups.set(behavior.equivalenceKey, [
      ...(groups.get(behavior.equivalenceKey) ?? []),
      config,
    ]);
  }
  const kept = [...withoutTargets];
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

function canonicalConfigApplyBehavior(
  config: Config,
  opts: ApplyOptions,
  contextConfigs: Config[],
): CanonicalConfigApplyBehavior {
  const primary = config.target_path
    ? {
      path: canonicalApplyTargetPath(config.target_path, opts),
      agent: config.agent,
      content: canonicalApplyContent(config.content, opts),
    }
    : null;
  const outputs = config.outputs
    .map((output, sourceIndex) => ({
      sourceIndex,
      path: canonicalApplyTargetPath(output.target_path, opts),
      agent: output.agent,
      transform: output.transform,
      content: canonicalApplyContent(
        applyTransform(config, output, { configs: contextConfigs }),
        opts,
      ),
    }))
    .sort((left, right) =>
      left.path.localeCompare(right.path)
      || left.agent.localeCompare(right.agent)
      || left.transform.localeCompare(right.transform)
      || left.content.localeCompare(right.content)
    );
  const equivalenceKey = JSON.stringify({
    kind: config.kind,
    category: config.category,
    primary,
    outputs: outputs.map(({ sourceIndex: _sourceIndex, ...output }) => output),
  });
  return { primary, outputs, equivalenceKey };
}

function configTargets(
  config: Config,
  opts: ApplyOptions,
  contextConfigs: Config[],
): Array<{ path: string; owner: string }> {
  const behavior = canonicalConfigApplyBehavior(config, opts, contextConfigs);
  return [
    ...(behavior.primary
      ? [{ path: behavior.primary.path, owner: `${config.slug}:primary` }]
      : []),
    ...behavior.outputs.map((output) => ({
      path: output.path,
      owner: `${config.slug}:output:${output.agent}`,
    })),
  ];
}

function duplicateTargetFailures(
  configs: Config[],
  opts: ApplyOptions,
): ConfigApplyPreviewFailure[] {
  const targets = new Map<string, Array<{ config: Config; owner: string }>>();
  for (const config of configs) {
    for (const target of configTargets(config, opts, configs)) {
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

function canonicalApplyContent(content: string, opts: ApplyOptions): string {
  return opts.vars
    ? renderMachineAwareContentPreview(content, opts.vars).content
    : content;
}

function canonicalApplyTargetPath(targetPath: string, opts: ApplyOptions): string {
  const renderedTargetPath = opts.vars
    ? renderMachineAwareContentPreview(targetPath, opts.vars).content
    : targetPath;
  return normalizeTargetPath(renderedTargetPath);
}

function sessionRendererOwnsTarget(targetPath: string, opts: ApplyOptions): boolean {
  return sessionRendererOwnsCanonicalTarget(canonicalApplyTargetPath(targetPath, opts), opts);
}

function sessionRendererOwnsCanonicalTarget(normalized: string, opts: ApplyOptions): boolean {
  if (opts.allowSessionRendererOwned) return false;
  const homes = new Set([
    getConfigHome(),
    opts.vars?.["HOME_DIR"],
  ].filter((home): home is string => typeof home === "string" && home.length > 0));
  // Provider entrypoints, including retired ones the renderer no longer emits
  // but still must not be re-created by a stale row.
  if ([...homes].some((home) =>
    SESSION_RENDER_OWNED_CONFIG_TARGETS.some((relativePath) =>
      normalized === normalizeTargetPath(join(home, ...relativePath.split("/")))
    )
  )) return true;
  // Everything else the renderer writes: its managed directories under any
  // target home, plus any file a target home's render manifest claims.
  return sessionRenderOwnsPath(normalized);
}
