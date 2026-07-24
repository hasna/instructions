import { TemplateRenderError } from "../types/index.js";

export interface TemplateVar {
  name: string;
  description: string | null;
  required: boolean;
}

const VAR_PATTERN = /\{\{([A-Z0-9_]+)(?::([^}]*))?\}\}/g;

export function parseTemplateVars(content: string): string[] {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  VAR_PATTERN.lastIndex = 0;
  while ((match = VAR_PATTERN.exec(content)) !== null) {
    names.add(match[1]!);
  }
  return Array.from(names);
}

export function extractTemplateVars(content: string): TemplateVar[] {
  const vars = new Map<string, TemplateVar>();
  let match: RegExpExecArray | null;
  VAR_PATTERN.lastIndex = 0;
  while ((match = VAR_PATTERN.exec(content)) !== null) {
    const name = match[1]!;
    const description = match[2] ?? null;
    if (!vars.has(name)) {
      vars.set(name, { name, description, required: true });
    }
  }
  return Array.from(vars.values());
}

export function renderTemplate(
  content: string,
  vars: Record<string, string>
): string {
  const missing: string[] = [];
  VAR_PATTERN.lastIndex = 0;

  // First pass: find missing required vars
  let match: RegExpExecArray | null;
  while ((match = VAR_PATTERN.exec(content)) !== null) {
    const name = match[1]!;
    if (!(name in vars)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new TemplateRenderError(
      `Missing required template variables: ${missing.join(", ")}`
    );
  }

  // Second pass: replace
  VAR_PATTERN.lastIndex = 0;
  return content.replace(VAR_PATTERN, (_match, name: string) => vars[name] ?? "");
}

export function renderTemplatePreview(
  content: string,
  vars: Record<string, string>,
): { content: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  VAR_PATTERN.lastIndex = 0;
  const rendered = content.replace(VAR_PATTERN, (match, name: string) => {
    if (name in vars) return vars[name] ?? "";
    unresolved.add(name);
    return match;
  });
  return {
    content: rendered,
    unresolved: [...unresolved].sort(),
  };
}

export function isTemplate(content: string): boolean {
  VAR_PATTERN.lastIndex = 0;
  return VAR_PATTERN.test(content);
}
