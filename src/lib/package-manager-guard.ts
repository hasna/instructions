import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type PackageManagerSurface =
  | "repo-npmrc"
  | "home-npmrc"
  | "bun-config"
  | "lockfile"
  | "shell-profile";

export type PackageManagerSeverity = "error" | "warning";

export interface PackageManagerFinding {
  path: string;
  line: number;
  rule: string;
  surface: PackageManagerSurface;
  severity: PackageManagerSeverity;
  tracked: boolean;
  detail: string;
}

export interface PackageManagerScanOptions {
  roots?: string[];
  includeHome?: boolean;
  cwd?: string;
}

export interface PackageManagerScanResult {
  clean: boolean;
  scannedFiles: number;
  scannedRoots: string[];
  findings: PackageManagerFinding[];
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const HOME_FILES = [
  ".npmrc",
  ".bunfig.toml",
  "bunfig.toml",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
];

const TOKEN_VALUE_PATTERNS: Array<{ re: RegExp; rule: string; detail: string }> = [
  { re: /npm_[A-Za-z0-9]{36,}/, rule: "literal-npm-token", detail: "literal npm token-like value" },
  { re: /gh[pousr]_[A-Za-z0-9_]{36,}/, rule: "literal-github-token", detail: "literal GitHub token-like value" },
  { re: /sk-ant-[A-Za-z0-9\-_]{40,}/, rule: "literal-anthropic-key", detail: "literal Anthropic key-like value" },
  { re: /sk-[A-Za-z0-9]{48,}/, rule: "literal-openai-key", detail: "literal OpenAI key-like value" },
  { re: /AKIA[0-9A-Z]{16}/, rule: "literal-aws-access-key", detail: "literal AWS access-key-like value" },
  { re: /xoxb-[0-9]+-[A-Za-z0-9-]+/, rule: "literal-slack-token", detail: "literal Slack token-like value" },
];

export function scanPackageManagerSecrets(options: PackageManagerScanOptions = {}): PackageManagerScanResult {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const roots = (options.roots && options.roots.length > 0 ? options.roots : [cwd])
    .map((root) => resolve(cwd, root));
  const findings: PackageManagerFinding[] = [];
  let scannedFiles = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const tracked = trackedFiles(root);
    for (const file of collectRepoFiles(root)) {
      const rel = toPosix(relative(root, file));
      const isTracked = tracked.has(rel);
      const text = readTextFile(file);
      if (text === null) continue;
      scannedFiles++;
      findings.push(...scanFile(file, text, classifyRepoFile(file), isTracked, root));
    }
  }

  if (options.includeHome) {
    const home = homedir();
    for (const name of HOME_FILES) {
      const file = join(home, name);
      if (!existsSync(file)) continue;
      const text = readTextFile(file);
      if (text === null) continue;
      scannedFiles++;
      findings.push(...scanFile(file, text, classifyHomeFile(name), false, home));
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));

  return {
    clean: findings.length === 0,
    scannedFiles,
    scannedRoots: roots,
    findings,
  };
}

function collectRepoFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const file = join(dir, entry.name);
      if (shouldScanRepoFile(file)) out.push(file);
    }
  };
  visit(root);
  return out;
}

function shouldScanRepoFile(file: string): boolean {
  const name = basename(file);
  return name === ".npmrc" || isBunConfigName(name) || LOCKFILE_NAMES.has(name);
}

function classifyRepoFile(file: string): PackageManagerSurface {
  const name = basename(file);
  if (name === ".npmrc") return "repo-npmrc";
  if (isBunConfigName(name)) return "bun-config";
  return "lockfile";
}

function classifyHomeFile(name: string): PackageManagerSurface {
  if (name === ".npmrc") return "home-npmrc";
  if (isBunConfigName(name)) return "bun-config";
  return "shell-profile";
}

function isBunConfigName(name: string): boolean {
  return name === "bunfig.toml" || name === ".bunfig.toml";
}

function readTextFile(file: string): string | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 5_000_000) return null;
    const buf = readFileSync(file);
    if (buf.includes(0)) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

function scanFile(file: string, text: string, surface: PackageManagerSurface, tracked: boolean, root: string): PackageManagerFinding[] {
  const findings: PackageManagerFinding[] = [];
  const path = displayPath(file, root);
  const lines = text.split(/\r?\n/);
  let inBunReleaseAgeExcludes = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (surface === "repo-npmrc" || surface === "home-npmrc") {
      findings.push(...scanNpmrcLine(line, path, lineNo, surface, tracked));
    } else if (surface === "bun-config") {
      const bun = scanBunConfigLine(line, path, lineNo, tracked, inBunReleaseAgeExcludes);
      findings.push(...bun.findings);
      inBunReleaseAgeExcludes = bun.inReleaseAgeExcludes;
    } else if (surface === "shell-profile") {
      findings.push(...scanShellProfileLine(line, path, lineNo, tracked));
    } else {
      findings.push(...scanLockfileLine(line, path, lineNo, tracked));
    }
  }
  return findings;
}

function scanNpmrcLine(lineText: string, path: string, line: number, surface: PackageManagerSurface, tracked: boolean): PackageManagerFinding[] {
  const findings: PackageManagerFinding[] = [];
  const stripped = lineText.trim();
  if (stripped === "" || stripped.startsWith("#") || stripped.startsWith(";")) return findings;

  const auth = stripped.match(/(?:^|:)(_[A-Za-z]*(?:auth|password)[A-Za-z]*|password)\s*=\s*(.+)$/i);
  if (auth) {
    const value = stripQuotes(stripInlineComment(auth[2]!.trim()));
    if (value && !isSafeReference(value)) {
      findings.push({
        path,
        line,
        rule: "npmrc-literal-auth",
        surface,
        severity: "error",
        tracked,
        detail: tracked
          ? "tracked npm auth entry uses a literal value"
          : "npm auth entry uses a literal value",
      });
    }
  }

  findings.push(...scanKnownTokenPatterns(stripped, path, line, surface, tracked));
  return findings;
}

function scanBunConfigLine(
  lineText: string,
  path: string,
  line: number,
  tracked: boolean,
  inReleaseAgeExcludes: boolean,
): { findings: PackageManagerFinding[]; inReleaseAgeExcludes: boolean } {
  const findings: PackageManagerFinding[] = [];
  const stripped = lineText.trim();
  if (stripped === "" || stripped.startsWith("#")) return { findings, inReleaseAgeExcludes };

  if (/^minimumReleaseAge\s*=\s*(0|"0"|'0')\s*(?:#.*)?$/i.test(stripped)) {
    findings.push({
      path,
      line,
      rule: "bun-release-age-disabled",
      surface: "bun-config",
      severity: "error",
      tracked,
      detail: "Bun release-age quarantine is disabled",
    });
  }

  const startsReleaseAgeExcludes = /minimumReleaseAgeExcludes/i.test(stripped);
  const scanExcludes = startsReleaseAgeExcludes || inReleaseAgeExcludes;
  if (scanExcludes) {
    const quoted = [...stripped.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const item of quoted) {
      if (item === "*" || item.endsWith("/*") || !item.startsWith("@hasna/")) {
        findings.push({
          path,
          line,
          rule: "bun-release-age-broad-exclude",
          surface: "bun-config",
          severity: "error",
          tracked,
          detail: "Bun release-age exclude must be an exact @hasna package name",
        });
      }
    }
  }

  const nextInReleaseAgeExcludes = startsReleaseAgeExcludes
    ? stripped.includes("[") && !stripped.includes("]")
    : inReleaseAgeExcludes && !stripped.includes("]");
  findings.push(...scanKnownTokenPatterns(stripped, path, line, "bun-config", tracked));
  return { findings, inReleaseAgeExcludes: nextInReleaseAgeExcludes };
}

function scanShellProfileLine(lineText: string, path: string, line: number, tracked: boolean): PackageManagerFinding[] {
  const findings: PackageManagerFinding[] = [];
  const stripped = lineText.trim();
  if (stripped === "" || stripped.startsWith("#")) return findings;

  const assignment = stripped.match(/^(?:export\s+)?(NPM(?:_CONFIG)?_[A-Z0-9_]*TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN)\s*=\s*(.+)$/);
  if (assignment) {
    const value = stripQuotes(stripInlineComment(assignment[2]!.trim()));
    if (value && !isSafeReference(value)) {
      findings.push({
        path,
        line,
        rule: "shell-literal-package-token",
        surface: "shell-profile",
        severity: "error",
        tracked,
        detail: "shell profile package-manager token uses a literal value",
      });
    }
  }

  findings.push(...scanKnownTokenPatterns(stripped, path, line, "shell-profile", tracked));
  return findings;
}

function scanLockfileLine(lineText: string, path: string, line: number, tracked: boolean): PackageManagerFinding[] {
  const findings = scanKnownTokenPatterns(lineText, path, line, "lockfile", tracked);
  if (/(?:^|:)_authToken\s*=\s*/i.test(lineText) && !/\$\{[A-Z0-9_]+\}|\{\{[A-Z0-9_]+\}\}/.test(lineText)) {
    findings.push({
      path,
      line,
      rule: "lockfile-auth-token",
      surface: "lockfile",
      severity: "error",
      tracked,
      detail: "lockfile contains package-manager auth token material",
    });
  }
  return findings;
}

function scanKnownTokenPatterns(lineText: string, path: string, line: number, surface: PackageManagerSurface, tracked: boolean): PackageManagerFinding[] {
  const findings: PackageManagerFinding[] = [];
  for (const pattern of TOKEN_VALUE_PATTERNS) {
    if (pattern.re.test(lineText)) {
      findings.push({
        path,
        line,
        rule: pattern.rule,
        surface,
        severity: "error",
        tracked,
        detail: pattern.detail,
      });
    }
  }
  return findings;
}

function trackedFiles(root: string): Set<string> {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(output.split("\0").filter(Boolean).map(toPosix));
  } catch {
    return new Set();
  }
}

function isSafeReference(value: string): boolean {
  const trimmed = stripQuotes(value.trim());
  return (
    /^\$\{[A-Z][A-Z0-9_]*\}$/.test(trimmed) ||
    /^\$[A-Z][A-Z0-9_]*$/.test(trimmed) ||
    /^\{\{[A-Z][A-Z0-9_]*\}\}$/.test(trimmed) ||
    /^%[A-Z][A-Z0-9_]*%$/.test(trimmed)
  );
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stripInlineComment(value: string): string {
  return value.replace(/\s[#;].*$/, "").trim();
}

function displayPath(file: string, root: string): string {
  const home = homedir();
  if (root === home && (file === home || file.startsWith(home + "/"))) return "~/" + toPosix(relative(home, file));
  if (isAbsolute(root) && file.startsWith(root + "/")) return toPosix(relative(root, file));
  if (file === home || file.startsWith(home + "/")) return "~/" + toPosix(relative(home, file));
  return file;
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}
