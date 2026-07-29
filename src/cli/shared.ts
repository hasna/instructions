import chalk from "chalk";
import { existsSync, lstatSync, readFileSync, readSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { detectMachineContext, resolveProfileVariables } from "../lib/machine.js";
import {
  resolveSessionPath, sourceFromConfig, sourceFromFilePath, sourcesFromIdentityExport,
  SESSION_INSTRUCTION_LAYERS, type SessionInstructionLayer, type SessionInstructionSource,
  type SessionRenderFile, type SessionRenderPlan, type SessionRenderTool,
} from "../lib/session-render.js";
import {
  ProjectContextError, PROJECT_CONTEXT_MAX_INPUT_BYTES, type ProjectContextRuntime,
} from "../lib/project-context.js";
import type { ConfigStore } from "../data/config-store.js";
import { truncateMiddle, truncateText } from "../lib/compact-output.js";
import type { Config, Profile, ProfileSelector, ProfileVariables } from "../types/index.js";

import { createRequire } from "node:module";
export const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

// Blocking, complete write to stdout (fd 1). Fixes the pipe-truncation bug:
// console.log/process.stdout.write to a pipe is asynchronous in Bun/Node, so a
// large payload (e.g. `instructions list --json | jq`) that exceeds the 64KB
// pipe buffer is silently dropped when the process exits before the buffer
// drains. writeSync loops until every byte is delivered, retrying on EAGAIN
// (pipe full) and giving up cleanly on EPIPE (consumer closed).
const EAGAIN_SLEEP = new Int32Array(new SharedArrayBuffer(4));
function writeStdout(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(EAGAIN_SLEEP, 0, 0, 1); // wait ~1ms for the consumer to drain
        continue;
      }
      if (code === "EPIPE") return; // downstream closed the pipe; stop writing
      throw e;
    }
  }
}

/** Print a line to stdout with a guaranteed-complete blocking write. */
export function printLine(text = ""): void {
  writeStdout(`${text}\n`);
}

/** Pretty-print a JSON value to stdout with a guaranteed-complete write. */
export function printJson(value: unknown): void {
  printLine(JSON.stringify(value, null, 2));
}

export function fmtConfig(c: Config, format: string) {
  if (format === "json") return JSON.stringify(c, null, 2);
  if (format === "compact") return `${c.slug} [${c.category}/${c.agent}] ${c.kind === "reference" ? "(ref)" : truncateMiddle(c.target_path ?? "(no path)", 72)}`;
  // table
  return [
    `${chalk.bold(c.name)} ${chalk.dim(`(${c.slug})`)}`,
    `  ${chalk.cyan("category:")} ${c.category}  ${chalk.cyan("agent:")} ${c.agent}  ${chalk.cyan("kind:")} ${c.kind}`,
    `  ${chalk.cyan("format:")} ${c.format}  ${chalk.cyan("version:")} ${c.version}${c.target_path ? `  ${chalk.cyan("path:")} ${c.target_path}` : ""}`,
    c.description ? `  ${chalk.dim(c.description)}` : "",
    c.tags.length > 0 ? `  ${chalk.dim("tags: " + c.tags.join(", "))}` : "",
  ].filter(Boolean).join("\n");
}

export function pad(value: string, width: number): string {
  return truncateText(value, width).padEnd(width);
}

export function pageFooter(command: string, page: { items: unknown[]; total: number; limit: number; next_cursor: number | null }, detailsHint: string): void {
  console.log(chalk.dim(`Showing ${page.items.length} of ${page.total}${page.next_cursor !== null ? ` (next cursor: ${page.next_cursor})` : ""}.`));
  if (page.next_cursor !== null) console.log(chalk.dim(`Next: ${command} --cursor ${page.next_cursor} --limit ${page.limit}`));
  console.log(chalk.dim(detailsHint));
}

export function printConfigRows(configs: Config[]): void {
  console.log(`${pad("slug", 32)} ${pad("type", 15)} ${pad("fmt", 8)} ${pad("path", 44)} out v`);
  for (const c of configs) {
    const type = `${c.category}/${c.agent}`;
    const path = c.kind === "reference" ? "(ref)" : c.target_path ?? "(no path)";
    console.log(`${pad(c.slug, 32)} ${pad(type, 15)} ${pad(c.format, 8)} ${pad(truncateMiddle(path, 44), 44)} ${String(c.outputs.length).padStart(3)} ${c.version}`);
  }
}

export function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const SESSION_SOURCE_LAYERS = new Set<SessionInstructionLayer>(SESSION_INSTRUCTION_LAYERS);
export const SESSION_SOURCE_LAYER_HELP = "global|provider|tool|account|machine|division|workspace|project|repo|path|identity|agent|session|local";

function parseSessionLayer(value: string): SessionInstructionLayer {
  if (value === "provider") return "tool";
  if (value === "identity") return "agent";
  if (value === "project") return "repo";
  if (SESSION_SOURCE_LAYERS.has(value as SessionInstructionLayer)) return value as SessionInstructionLayer;
  throw new Error(`Invalid source layer "${value}"`);
}

function parseSessionSource(value: string, order: number, replaceIds: Set<string>): SessionInstructionSource {
  const idx = value.indexOf("=");
  let id = idx > 0 ? value.slice(0, idx).trim() : "";
  const path = idx > 0 ? value.slice(idx + 1).trim() : value.trim();
  let layer: SessionInstructionLayer = "agent";
  const layerIdx = id.indexOf(":");
  if (layerIdx > 0) {
    layer = parseSessionLayer(id.slice(0, layerIdx));
    id = id.slice(layerIdx + 1).trim();
  }
  if (!path) throw new Error(`Invalid --source "${value}" (expected path or id=path)`);
  const absPath = resolveSessionPath(path);
  if (!existsSync(absPath)) throw new Error(`Instruction source file not found: ${absPath}`);
  const content = readFileSync(absPath, "utf-8");
  const source = sourceFromFilePath(absPath, content, order);
  const resolvedId = id || source.id || basename(absPath);
  return {
    ...source,
    id: resolvedId,
    label: id ? resolvedId : source.label ?? resolvedId,
    layer,
    merge: replaceIds.has(resolvedId) ? "replace" : "append",
  };
}

function parseLayeredReference(value: string): { layer?: SessionInstructionLayer; id: string } {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(":");
  if (idx > 0) {
    const candidate = trimmed.slice(0, idx);
    if (candidate === "provider" || candidate === "identity" || candidate === "project" || SESSION_SOURCE_LAYERS.has(candidate as SessionInstructionLayer)) {
      const id = trimmed.slice(idx + 1).trim();
      if (!id) throw new Error(`Invalid layered reference "${value}"`);
      return { layer: parseSessionLayer(candidate), id };
    }
  }
  if (!trimmed) throw new Error("Instruction reference cannot be empty.");
  return { id: trimmed };
}

export async function collectSessionSources(
  opts: {
    source?: string[];
    config?: string[];
    identityExport?: string[];
    replaceSource?: string[];
  },
  tool: SessionRenderTool,
  store: ConfigStore,
): Promise<SessionInstructionSource[]> {
  const replaceIds = new Set<string>(opts.replaceSource ?? []);
  const sources = (opts.source ?? []).map((value, index) => parseSessionSource(value, index, replaceIds));

  for (const value of opts.config ?? []) {
    const { layer, id } = parseLayeredReference(value);
    sources.push(sourceFromConfig(await store.getConfig(id), sources.length, layer));
  }

  for (const value of opts.identityExport ?? []) {
    const path = resolveSessionPath(value);
    if (!existsSync(path)) throw new Error(`Identity instruction export not found: ${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    sources.push(...sourcesFromIdentityExport(parsed, { path, tool, orderOffset: sources.length }));
  }

  return sources.map((source) => replaceIds.has(source.id) ? { ...source, merge: "replace" } : source);
}

function stripSessionFileContent(file: SessionRenderFile): Omit<SessionRenderFile, "content"> {
  const { content: _content, ...rest } = file;
  return rest;
}

export function planJsonForOutput(plan: SessionRenderPlan) {
  return {
    ...plan,
    files: plan.files.map(stripSessionFileContent),
    manifestFile: stripSessionFileContent(plan.manifestFile),
    allFiles: plan.allFiles.map(stripSessionFileContent),
  };
}

export function parseProjectContextRuntime(value: string): ProjectContextRuntime {
  if (value === "codex") return "agents";
  if (value === "claude" || value === "codewith" || value === "agents") return value;
  throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `unsupported runtime ${value}; expected claude|codewith|agents|codex`);
}

export function readProjectContextBundleOption(value: string | undefined, allowMissing = false): { json?: string; sourcePath?: string } {
  if (value === undefined) return {};
  if (value === "-") return { json: readBoundedProjectContextStdin() };
  const path = resolveSessionPath(value);
  if (!existsSync(path)) {
    if (allowMissing) return {};
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_MISSING", `bundle file not found: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProjectContextError("PROJECT_CONTEXT_SYMLINK_REJECTED", "bundle input must be a regular non-symlink file");
  }
  if (stat.size > PROJECT_CONTEXT_MAX_INPUT_BYTES) {
    throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `bundle exceeds ${PROJECT_CONTEXT_MAX_INPUT_BYTES} bytes`);
  }
  return { json: readFileSync(path, "utf8"), sourcePath: path };
}

function readBoundedProjectContextStdin(): string {
  const chunks: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(4_096);
  let total = 0;
  while (true) {
    const bytesRead = readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > PROJECT_CONTEXT_MAX_INPUT_BYTES) {
      throw new ProjectContextError("PROJECT_CONTEXT_INPUT_TOO_LARGE", `bundle exceeds ${PROJECT_CONTEXT_MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ProjectContextError("PROJECT_CONTEXT_INVALID", `${label} must be a positive integer`);
  return parsed;
}

export function printProjectContextFailure(error: unknown, json: boolean): void {
  const normalized = error instanceof ProjectContextError
    ? error
    : new ProjectContextError("PROJECT_CONTEXT_FAILED", error instanceof Error ? error.message : String(error));
  if (json) printJson({ ok: false, error: { code: normalized.code, message: normalized.message } });
  else console.error(chalk.red(normalized.message));
  process.exitCode = 1;
}

export function parseVarArgs(values?: string[]): ProfileVariables | undefined {
  if (!values || values.length === 0) return undefined;
  const vars: ProfileVariables = {};
  for (const entry of values) {
    const idx = entry.indexOf("=");
    if (idx <= 0) throw new Error(`Invalid --var "${entry}" (expected KEY=VALUE)`);
    vars[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

export function parseProfileSelectors(opts: { os?: string; arch?: string; hostname?: string }): ProfileSelector | undefined {
  const selectors: ProfileSelector = {};
  const os = splitCsv(opts.os);
  const arch = splitCsv(opts.arch);
  const hostnames = splitCsv(opts.hostname);
  if (os) selectors.os = os;
  if (arch) selectors.arch = arch;
  if (hostnames) selectors.hostnames = hostnames;
  return Object.keys(selectors).length > 0 ? selectors : undefined;
}

export function formatProfileSelectorSummary(profile: Pick<Profile, "selectors">): string {
  const parts: string[] = [];
  if (profile.selectors.os?.length) parts.push(`os=${profile.selectors.os.join(",")}`);
  if (profile.selectors.arch?.length) parts.push(`arch=${profile.selectors.arch.join(",")}`);
  if (profile.selectors.hostnames?.length) parts.push(`host=${profile.selectors.hostnames.join(",")}`);
  return parts.join(" ");
}

export function formatProfileVariables(profile: Pick<Profile, "variables">): string {
  return Object.entries(profile.variables)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

export async function getMachineProfileContext(
  opts: { hostname?: string; os?: string; arch?: string },
  store: ConfigStore,
) {
  const machine = detectMachineContext({ hostname: opts.hostname, os: opts.os, arch: opts.arch });
  const profile = await store.resolveProfileForMachine(machine);
  return { machine, profile, vars: resolveProfileVariables(profile, machine) };
}

