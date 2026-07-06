/**
 * Secret redaction engine.
 *
 * Detects and replaces sensitive values with {{VARNAME}} template placeholders
 * so they are NEVER stored in the DB. The config becomes a template that can
 * be rendered with real values at apply-time.
 *
 * Strategy:
 *  1. Key-name matching — if an assignment's LHS looks like a secret key name
 *  2. Value-pattern matching — known token formats (npm, GitHub, Anthropic, etc.)
 *     regardless of key name
 */

export interface RedactResult {
  content: string;
  redacted: RedactedVar[];
  isTemplate: boolean;
}

export interface RedactedVar {
  varName: string;   // e.g. "ANTHROPIC_API_KEY"
  line: number;      // 1-based line number
  reason: string;    // why it was redacted
}

// ── Key names that always indicate a secret ───────────────────────────────────
const SECRET_KEY_PATTERN = /^(.*_?API_?KEY|.*_?TOKEN|.*_?SECRET|.*_?PASSWORD|.*_?PASSWD|.*_?CREDENTIAL|.*_?AUTH(?:_TOKEN|_KEY|ORIZATION)?|.*_?PRIVATE_?KEY|.*_?ACCESS_?KEY|.*_?CLIENT_?SECRET|.*_?SIGNING_?KEY|.*_?ENCRYPTION_?KEY|.*_AUTH_TOKEN)$/i;

// ── Known token value patterns (matched regardless of key name) ───────────────
const VALUE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /npm_[A-Za-z0-9]{36,}/,                   reason: "npm token" },
  { re: /gh[pousr]_[A-Za-z0-9_]{36,}/,            reason: "GitHub token" },
  { re: /sk-ant-[A-Za-z0-9\-_]{40,}/,             reason: "Anthropic API key" },
  { re: /sk-[A-Za-z0-9]{48,}/,                    reason: "OpenAI API key" },
  { re: /xoxb-[0-9]+-[A-Za-z0-9\-]+/,             reason: "Slack bot token" },
  { re: /AIza[0-9A-Za-z\-_]{35}/,                 reason: "Google API key" },
  { re: /ey[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\./, reason: "JWT token" },
  { re: /AKIA[0-9A-Z]{16}/,                        reason: "AWS access key" },
];

// Minimum length for a value to be considered a secret (avoids "yes"/"true" etc.)
const MIN_SECRET_VALUE_LEN = 8;

// ── Per-format redaction ──────────────────────────────────────────────────────

/**
 * Redact shell configs (.zshrc, .zprofile, .bashrc, .env, .secrets).
 * Handles: export KEY="value", export KEY=value, KEY=value
 */
function redactShell(content: string): RedactResult {
  const redacted: RedactedVar[] = [];
  const lines = content.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Match: export KEY="value" | export KEY=value | KEY=value
    const m = line.match(/^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*=\s*)(['"]?)(.+?)\4\s*$/);
    if (m) {
      const [, prefix, key, eq, quote, value] = m;
      if (shouldRedactKeyValue(key!, value!)) {
        const reason = reasonFor(key!, value!);
        redacted.push({ varName: key!, line: i + 1, reason });
        out.push(`${prefix}${key}${eq}${quote}{{${key}}}${quote}`);
        continue;
      }
    }
    out.push(line);
  }

  return { content: out.join("\n"), redacted, isTemplate: redacted.length > 0 };
}

/**
 * Redact JSON configs (settings.json, claude.json, etc.).
 * Handles: "key": "value"
 */
function redactJson(content: string): RedactResult {
  const redacted: RedactedVar[] = [];
  const lines = content.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^(\s*"([^"]+)"\s*:\s*)"([^"]+)"(,?)(\s*)$/);
    if (m) {
      const [, prefix, key, value, comma, trail] = m;
      if (shouldRedactKeyValue(key!, value!)) {
        const varName = key!.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        redacted.push({ varName, line: i + 1, reason: reasonFor(key!, value!) });
        out.push(`${prefix}"{{${varName}}}"${comma}${trail}`);
        continue;
      }
    }
    // Also catch value-pattern matches anywhere in the line
    let newLine = line;
    for (const { re, reason } of VALUE_PATTERNS) {
      newLine = newLine.replace(re, (match) => {
        const varName = `REDACTED_${reason.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
        redacted.push({ varName, line: i + 1, reason });
        return `{{${varName}}}`;
      });
    }
    out.push(newLine);
  }

  return { content: out.join("\n"), redacted, isTemplate: redacted.length > 0 };
}

/**
 * Redact TOML configs (codex config.toml, bunfig.toml).
 * Handles: key = "value"
 */
function redactToml(content: string): RedactResult {
  const redacted: RedactedVar[] = [];
  const lines = content.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^(\s*)([a-zA-Z][a-zA-Z0-9_\-]*)(\s*=\s*)(['"]?)(.+?)\4\s*$/);
    if (m) {
      const [, indent, key, eq, quote, value] = m;
      if (shouldRedactKeyValue(key!, value!)) {
        const varName = key!.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        redacted.push({ varName, line: i + 1, reason: reasonFor(key!, value!) });
        out.push(`${indent}${key}${eq}${quote}{{${varName}}}${quote}`);
        continue;
      }
    }
    out.push(line);
  }

  return { content: out.join("\n"), redacted, isTemplate: redacted.length > 0 };
}

/**
 * Redact INI / .npmrc files.
 * Handles: key=value, //registry:_authToken=value
 */
function redactIni(content: string): RedactResult {
  const redacted: RedactedVar[] = [];
  const lines = content.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // //registry:_authToken=value (npmrc style)
    const authM = line.match(/^(\/\/[^:]+:_authToken=)(.+)$/);
    if (authM && !isReferenceValue(authM[2]!.trim())) {
      redacted.push({ varName: "NPM_TOKEN", line: i + 1, reason: "npm auth token" });
      out.push(`${authM[1]}\${NPM_TOKEN}`);
      continue;
    }
    // key=value
    const m = line.match(/^(\s*)([a-zA-Z][a-zA-Z0-9_\-]*)(\s*=\s*)(.+?)\s*$/);
    if (m) {
      const [, indent, key, eq, value] = m;
      if (shouldRedactKeyValue(key!, value!)) {
        const varName = key!.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        redacted.push({ varName, line: i + 1, reason: reasonFor(key!, value!) });
        out.push(`${indent}${key}${eq}{{${varName}}}`);
        continue;
      }
    }
    out.push(line);
  }

  return { content: out.join("\n"), redacted, isTemplate: redacted.length > 0 };
}

/**
 * Generic redaction — scan for known value patterns only (no key-name heuristics).
 * Used for markdown and plain text.
 */
function redactGeneric(content: string): RedactResult {
  const redacted: RedactedVar[] = [];
  const lines = content.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    for (const { re, reason } of VALUE_PATTERNS) {
      line = line.replace(re, (match) => {
        const varName = reason.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        redacted.push({ varName, line: i + 1, reason });
        return `{{${varName}}}`;
      });
    }
    out.push(line);
  }

  return { content: out.join("\n"), redacted, isTemplate: redacted.length > 0 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shouldRedactKeyValue(key: string, value: string): boolean {
  if (!value || value.startsWith("{{")) return false; // already redacted
  if (isReferenceValue(value.trim())) return false; // env/template references are safe to store
  if (value.length < MIN_SECRET_VALUE_LEN) return false;
  // Skip obviously non-secret values
  if (/^(true|false|yes|no|on|off|null|undefined|\d+)$/i.test(value)) return false;
  // Key-name match
  if (SECRET_KEY_PATTERN.test(key)) return true;
  // Value-pattern match
  for (const { re } of VALUE_PATTERNS) {
    if (re.test(value)) return true;
  }
  return false;
}

function reasonFor(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return `secret key name: ${key}`;
  for (const { re, reason } of VALUE_PATTERNS) {
    if (re.test(value)) return reason;
  }
  return "secret value pattern";
}

function isReferenceValue(value: string): boolean {
  return (
    /^\{\{[A-Z][A-Z0-9_]*\}\}$/.test(value) ||
    /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value) ||
    /^\$[A-Z][A-Z0-9_]*$/.test(value) ||
    /^%[A-Z][A-Z0-9_]*%$/.test(value)
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export type RedactFormat = "shell" | "json" | "toml" | "ini" | "markdown" | "text" | "yaml";

export function redactContent(content: string, format: RedactFormat): RedactResult {
  switch (format) {
    case "shell": return redactShell(content);
    case "json":  return redactJson(content);
    case "toml":  return redactToml(content);
    case "ini":   return redactIni(content);
    default:      return redactGeneric(content);
  }
}

/** Detect secrets without modifying content. Returns list of findings. */
export function scanSecrets(content: string, format: RedactFormat): RedactedVar[] {
  const r = redactContent(content, format);
  return r.redacted;
}

/** Returns true if content contains any detectable secrets. */
export function hasSecrets(content: string, format: RedactFormat): boolean {
  return scanSecrets(content, format).length > 0;
}
