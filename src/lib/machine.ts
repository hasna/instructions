import { arch as currentArch, homedir, hostname as currentHostname, type as currentOsType } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MachineContext, Profile, ProfileVariables } from "../types/index.js";
import { isTemplate, renderTemplate } from "./template.js";

export interface MachineContextOverrides {
  hostname?: string;
  os?: string;
  arch?: string;
  home_dir?: string;
  workspace_root?: string;
  bun_bin_dir?: string;
  bun_path?: string;
  path_prefix?: string;
}

const BREW_BUN_PATH = "/opt/homebrew/bin/bun";

export function normalizeOsFamily(os?: string | null): string {
  const value = (os ?? "").trim().toLowerCase();
  if (value === "darwin" || value === "macos" || value === "mac" || value === "osx") return "macos";
  if (value === "linux") return "linux";
  if (value === "windows_nt" || value === "windows" || value === "win32") return "windows";
  return value || "unknown";
}

export function detectMachineContext(
  overrides: MachineContextOverrides = {}
): MachineContext {
  const homeDir = overrides.home_dir ?? process.env["CONFIGS_HOME"] ?? process.env["HOME"] ?? homedir();
  const os = overrides.os ?? currentOsType();
  const osFamily = normalizeOsFamily(os);
  const bunBinDir = overrides.bun_bin_dir ?? join(homeDir, ".bun", "bin");
  const defaultBunPath = osFamily === "macos" && existsSync(BREW_BUN_PATH)
    ? BREW_BUN_PATH
    : join(bunBinDir, "bun");

  return {
    id: "current-machine",
    hostname: overrides.hostname ?? currentHostname(),
    os,
    arch: overrides.arch ?? currentArch(),
    last_applied_at: null,
    created_at: "",
    os_family: osFamily,
    home_dir: homeDir,
    workspace_root: overrides.workspace_root ?? join(homeDir, osFamily === "macos" ? "Workspace" : "workspace"),
    bun_bin_dir: bunBinDir,
    bun_path: overrides.bun_path ?? defaultBunPath,
    path_prefix: overrides.path_prefix ?? (osFamily === "macos" ? `${join("/opt", "homebrew", "bin")}:${bunBinDir}` : bunBinDir),
  };
}

export function machineContextToVariables(machine: MachineContext): ProfileVariables {
  return {
    HOSTNAME: machine.hostname,
    OS: machine.os ?? "",
    OS_FAMILY: machine.os_family,
    ARCH: machine.arch ?? "",
    HOME_DIR: machine.home_dir,
    WORKSPACE_ROOT: machine.workspace_root,
    BUN_BIN_DIR: machine.bun_bin_dir,
    BUN_PATH: machine.bun_path,
    PATH_PREFIX: machine.path_prefix,
  };
}

export function resolveProfileVariables(
  profile: Pick<Profile, "variables"> | null | undefined,
  machine: MachineContext
): ProfileVariables {
  const base = machineContextToVariables(machine);
  const raw = profile?.variables ?? {};
  const resolved: ProfileVariables = { ...base };
  const pending = new Map(Object.entries(raw));
  const maxPasses = Math.max(4, pending.size * 2);

  for (let pass = 0; pass < maxPasses && pending.size > 0; pass++) {
    let progress = false;
    for (const [key, value] of [...pending.entries()]) {
      try {
        resolved[key] = isTemplate(value) ? renderTemplate(value, resolved) : value;
        pending.delete(key);
        progress = true;
      } catch {
        // Wait for dependent vars to resolve in a later pass.
      }
    }
    if (!progress) break;
  }

  for (const [key, value] of pending.entries()) {
    resolved[key] = value;
  }

  return resolved;
}

function replaceKnownPath(content: string, actual: string, placeholder: string): string {
  if (!actual || actual === placeholder) return content;
  return content.split(actual).join(placeholder);
}

export function templateizeMachineContent(
  content: string,
  machine: MachineContext
): { content: string; changed: boolean } {
  const vars = machineContextToVariables(machine);
  let next = content;
  const replacements: Array<[string, string]> = [
    [vars["WORKSPACE_ROOT"]!, "{{WORKSPACE_ROOT}}"],
    [vars["BUN_PATH"]!, "{{BUN_PATH}}"],
    [vars["BUN_BIN_DIR"]!, "{{BUN_BIN_DIR}}"],
    [vars["PATH_PREFIX"]!, "{{PATH_PREFIX}}"],
    [vars["HOME_DIR"]!, "{{HOME_DIR}}"],
  ];

  for (const [actual, placeholder] of replacements) {
    next = replaceKnownPath(next, actual, placeholder);
  }

  next = next
    .replace(/~\/workspace/g, "{{WORKSPACE_ROOT}}")
    .replace(/~\/Workspace/g, "{{WORKSPACE_ROOT}}")
    .replace(/\/opt\/homebrew\/bin\/bun/g, "{{BUN_PATH}}");

  return { content: next, changed: next !== content };
}

export function renderMachineAwareContent(
  content: string,
  variables: ProfileVariables
): string {
  return isTemplate(content) ? renderTemplate(content, variables) : content;
}
