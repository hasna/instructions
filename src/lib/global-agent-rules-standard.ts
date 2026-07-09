import type { Config } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";

export const GLOBAL_AGENT_RULES_STANDARD_SLUG = "global-agent-rules-standard";

export const GLOBAL_AGENT_RULES_STANDARD_CONTENT = `# Global Coding Agent Rules Standard

This standard is managed global/system prompt source content for Hasna coding
agents. Rendered agents must receive these rules unless a newer authorized
policy source supersedes them.

## Session and Planning Defaults

1. Use automatic session renaming when the agent supports it. Rename the
   session early to match the active task; if the task materially pivots, rename
   it again so operators can identify the run.
2. Never set Codewith goal/token budgets or goal-plan budgets unless the user
   explicitly asks for a budget. Durable goals and goal plans are unbudgeted by
   default.

## Repository Mutation and Landing

3. Repo mutation must happen in a task-scoped worktree. First inspect the canonical worktree root
   \`$HOME/.hasna/repos/worktrees\`; prefer Hasna repo/project worktree
   mechanisms when available; otherwise use \`git worktree\`. Never mutate shared checkouts.
4. PR-first landing: normal changes go through a branch/worktree and pull
   request before landing.
5. Never push directly to \`main\`, the default branch, or any protected branch
   unless the user explicitly instructs that exact repo and operation.

## Autonomy and Source-of-Truth Tools

6. Act autonomously. Diagnose, repair, validate, and iterate on the owning
   CLIs, packages, and workflows before asking the user. Ask only when blocked
   by destructive decisions, secret-bearing decisions, user-only authority, or
   external state the agent cannot safely obtain.
7. Use Hasna CLIs/packages as the source of truth: \`todos\`, \`conversations\`,
   \`mementos\`, \`knowledge\`, \`projects\`, \`repos\`, \`accounts\`,
   \`instructions\`, \`machines\`, \`secrets\`, and \`access\`.
8. Secrets safety is mandatory. Never expose secrets in prompts, tasks,
   memories, conversations, manifests, reports, logs, PR text, or any other
   agent-visible output. Reference vault item names, secret identifiers, and
   access grants only; never print credential values.

## Conversation Surfaces

9. Use default conversation surfaces correctly: \`announcements\` for policy,
   freeze, breaking, cutover, and release notices; \`incidents\` for outages,
   crash loops, data risk, or security exposure; \`git-publishing\` before and
   after package publishes; \`git-prs\`, \`git-commits\`, and \`git-releases\`
   for repository landing events; \`hq\` for broad coordination;
   \`agent-policy\` for agent operating-rule discussion; project/product
   channels for normal work; and \`conversations blockers\` for blocker
   discovery. Do not invent or refer to a literal blockers channel.
`;

export async function ensureGlobalAgentRulesStandardConfig(store: ConfigStore = resolveConfigStore()): Promise<Config> {
  const input = {
    name: "Global Agent Rules Standard",
    category: "rules" as const,
    agent: "global" as const,
    format: "markdown" as const,
    content: GLOBAL_AGENT_RULES_STANDARD_CONTENT,
    kind: "reference" as const,
    description: "Managed global/system prompt rules for Hasna coding agents",
    tags: ["global-agent-rules", "system-prompt", "coding-agent-rules"],
  };

  try {
    const existing = await store.getConfig(GLOBAL_AGENT_RULES_STANDARD_SLUG);
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
