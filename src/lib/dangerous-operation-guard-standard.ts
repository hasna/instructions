import type { Config } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";

export const DANGEROUS_OPERATION_GUARD_STANDARD_SLUG = "dangerous-operation-guard-standard";

export const DANGEROUS_OPERATION_GUARD_STANDARD_CONTENT = `# Dangerous Operation Guard Standard

This standard is the managed instruction/config source for sustained Hasna
coding agents on station01 and compatible fleet machines. Its purpose is to
route risky shell commands, file edits, git operations, package installs, and
secret-adjacent access through native guard surfaces where the runtime supports
them, or through a documented wrapper/plugin fallback where it does not.

## Scope

- Apply this guard to sustained Codewith, Codex, Claude Code, Qwen Code,
  OpenCode, Cursor, and Google Antigravity agents on station01.
- Do not target Gemini CLI. Gemini is retired for Hasna coding-agent rollout
  purposes; Antigravity is the active Google agent target.
- Keep guard policy in managed instructions/config. Do not repair rollout gaps
  by hand-editing generated agent files outside the managed renderer.

## Codewith and Codex

- Use managed Codewith/Codex config and requirements where supported.
- A managed requirements policy should set \`allow_managed_hooks_only = true\`
  so unmanaged local/project hooks cannot bypass the managed guard set.
- \`PreToolUse\` is a hard-deny and context-injection surface. It may block a
  dangerous operation or allow a safe rewrite supported by the runtime, but it
  must not try to ask the user for approval.
- Approval decisions belong in \`PermissionRequest\` hooks. If a dangerous
  operation needs human approval, let the runtime raise a permission request
  and decide there; do not return \`permissionDecision: "ask"\` from
  \`PreToolUse\`.
- The current managed hook set should cover shell commands, file writes,
  patch/edit tools, MCP file-modifying tools, branch/worktree safety,
  secret-adjacent paths, package installs, staged secret scans before commit or
  push, and fleet freeze/blocker gates.

## Claude Code

- Use Claude Code native hooks in managed \`settings.json\` where available.
- Claude \`PreToolUse\` can use its native approval/defer semantics, but the
  shared classifier must keep runtime-specific adapters so Claude behavior is
  not collapsed into Codewith/Codex semantics.
- When native hooks are unavailable, use the managed wrapper that launches
  Claude with the guarded hook profile rather than copying one-off rules into a
  local prompt file.

## Qwen Code

- Session rendering writes Qwen Code \`QWEN.md\` instructional context. This is
  policy context only; hard enforcement still requires native hooks or a
  managed wrapper/plugin.
- Use Qwen Code native \`settings.json\` hooks for hard enforcement. User-level
  settings live at \`~/.qwen/settings.json\`; project-level settings live at
  \`.qwen/settings.json\`.
- Qwen hooks are configured under the \`hooks\` object with event arrays such
  as \`PreToolUse\`; each hook entry should be a managed command or HTTP hook
  with an explicit name, description, matcher, timeout, and shell where needed.
- If the installed Qwen hook payload is not compatible with the shared
  classifier yet, use a managed extension or wrapper fallback that preserves
  the same deny-before-execute behavior.

## OpenCode

- Use native \`opencode.json\` instructions and the OpenCode plugin surface
  where a plugin is available.
- If no native plugin is installed, launch through the managed wrapper that
  runs the shared guard before auto-approved operations.

## Cursor

- Use project-owned \`.cursor/rules/*.mdc\` for policy rendering.
- Because Cursor rule files are advisory prompt context rather than a verified
  pre-tool hard gate, require a managed wrapper/plugin fallback for enforcement
  before claiming the dangerous-operation guard is active.

## Antigravity

- Use project-owned \`.agents/rules/*.md\` and Antigravity-owned MCP/config
  paths where available.
- Antigravity may still use legacy-named \`~/.gemini/...\` global paths for
  Antigravity-owned files, but this must never reintroduce an active
  \`gemini\` target.
- If no native pre-tool hook is verified, use a managed wrapper/plugin
  fallback before claiming hard enforcement.

## Verification

Before rollout is marked complete:

1. Render managed instructions for every render-supported station01 agent and
   sync managed settings/config for hook-only surfaces.
2. Verify Gemini is absent from active target lists and generated outputs.
3. Verify Codewith/Codex \`PreToolUse\` rejects ask-style approvals and
   \`PermissionRequest\` is the approval path.
4. Verify each non-Codewith runtime either has a native hook/config proof or is
   explicitly listed as wrapper/plugin fallback.
5. Run the staged secrets scan before every commit or push.
`;

export async function ensureDangerousOperationGuardStandardConfig(store: ConfigStore = resolveConfigStore()): Promise<Config> {
  const input = {
    name: "Dangerous Operation Guard Standard",
    category: "rules" as const,
    agent: "global" as const,
    format: "markdown" as const,
    content: DANGEROUS_OPERATION_GUARD_STANDARD_CONTENT,
    kind: "reference" as const,
    description: "Managed dangerous-operation guard policy for sustained Hasna coding agents",
    tags: ["dangerous-operation-guard", "hooks", "coding-agent-rules", "station01"],
  };

  try {
    const existing = await store.getConfig(DANGEROUS_OPERATION_GUARD_STANDARD_SLUG);
    if (
      existing.content !== input.content
      || existing.description !== input.description
      || existing.category !== input.category
      || existing.agent !== input.agent
      || existing.format !== input.format
      || existing.kind !== input.kind
      || JSON.stringify(existing.tags) !== JSON.stringify(input.tags)
    ) {
      return await store.updateConfig(existing.id, input);
    }
    return existing;
  } catch {
    return await store.createConfig(input);
  }
}
