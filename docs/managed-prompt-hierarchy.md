# Managed Prompt Hierarchy

## Goal

`open-instructions` is the source of truth for Hasna coding-agent prompts. It
stores canonical instruction fragments, renders them into each agent's native
files, records provenance, and detects drift.

The system must support every active coding-agent surface while keeping one
canonical source per rule. Google Antigravity is the only active Google coding
agent target.

## Layers

Render sources are composed in this order:

| Layer | Purpose |
| --- | --- |
| `global` | Non-overridable Hasna rules and default agent behavior. |
| `tool` | Tool/provider-specific behavior such as Codewith, Claude, Codex, Cursor, OpenCode, Antigravity, or aicopilot. |
| `account` | Account or auth-profile overlays such as `live-codewith`. |
| `machine` | Host-specific rules for machines such as `spark01`, Apple laptops, or fleet nodes. |
| `division` | Area-level rules for repo families such as `opensource`, `hasnastudio`, `hasnatools`, or `infra`. |
| `workspace` | Rules for ephemeral or project workspaces such as `~/.hasna/projects/workspaces/wks_*`. |
| `repo` | Repository purpose, commands, ownership, deployment mode, boundaries, and validation. |
| `path` | Subfolder/module rules for large repos. |
| `agent` | Persona or named-agent behavior. |
| `session` | Temporary task/session-specific overlays. |
| `local` | Highest-precedence local override for explicit one-off use. |

`provider` remains a CLI alias for `tool`, and `identity` remains a CLI alias
for `agent`. Legacy identity exports that call a source `project-overlay`
continue to map to `repo`; `machine-overlay` maps to `machine`; and
`session-overlay` maps to `session`.

## Active Targets

| Tool | Managed output |
| --- | --- |
| `codewith` | `CODEWITH.md`, with optional native imports into `.hasna/instructions`. |
| `claude` | `CLAUDE.md`, with native imports into `.hasna/instructions`. |
| `codex` | Flattened `AGENTS.md`. |
| `cursor` | Project-owned `.cursor/rules/*.mdc`. |
| `opencode` | `AGENTS.md`, `opencode.json`, and `.hasna/instructions` fragments. |
| `aicopilot` | `AICOPILOT.md`, with optional `aicopilot.json` instructions in a later pass. |
| `antigravity` | Project-owned `.agents/rules/*.md`, workspace MCP at `.agents/mcp_config.json`, and Google's current legacy-named global Antigravity files at `~/.gemini/GEMINI.md` and `~/.gemini/config/mcp_config.json`. |

The retired Google coding-agent target has no active render path. Do not create
new `agent=gemini` records, do not render project `GEMINI.md` for that retired
target, and do not add new global rules that target it. Existing legacy project
files should be treated only as migration inputs into Antigravity or `AGENTS.md`.

Antigravity compatibility note: Google's current Antigravity documentation still
uses legacy-named `~/.gemini/...` paths for Antigravity global rules and global
MCP configuration. `open-instructions` should treat those paths as Antigravity
outputs only; there must be no active `gemini` agent target.

## Required Global Rules

The managed global prompt must include these rules:

1. Agents that support session naming must rename the session early to match
   the task. If the task materially pivots, rename it again.
2. Repo mutation must happen in a task-scoped worktree. First inspect the
   canonical worktree root `$HOME/.hasna/repos/worktrees`; prefer Hasna
   repo/project worktree mechanisms when available; otherwise use
   `git worktree`. Never mutate shared checkouts.
3. PR-first landing: normal changes go through branch/worktree plus PR.
4. Never push directly to `main`, the default branch, or any protected branch
   unless the user explicitly instructs that exact repo and operation.
5. Agents act autonomously: diagnose, repair, validate, and iterate on the
   owning CLIs, packages, and workflows before asking the user. Ask only when
   blocked by destructive decisions, secret-bearing decisions, user-only
   authority, or external state the agent cannot safely obtain.
6. Use Hasna CLIs/packages as source of truth: `todos`, `conversations`,
   `mementos`, `knowledge`, `projects`, `repos`, `accounts`, `instructions`,
   `machines`, `secrets`, and `access`.
7. Use the fleet conversation surfaces correctly:
   `announcements` for `[FREEZE]`, `[UNFREEZE]`, `[BREAKING]`, `[CUTOVER]`,
   `[POLICY]`, and `[RELEASE]`; `incidents` for outages, crash loops, data risk,
   or security exposure; `git-publishing` before and after package publishes;
   `git-prs`, `git-commits`, and `git-releases` for repository landing events;
   `hq` for broad coordination; `agent-policy` for agent operating-rule
   discussion; project/product channels for normal work; and `conversations
   blockers` for blocker discovery. Do not invent or refer to a literal
   blockers channel.
8. Never set Codewith goal/token budgets or goal-plan budgets unless the user
   explicitly asks for a budget. Durable goals and goal plans should be
   unbudgeted by default.
9. Never expose secrets in prompts, tasks, memories, conversations, manifests,
   reports, logs, or PR text. Reference vault item names and grants only.

## Implementation Notes

The implementation is incremental:

1. Extend the session render layer model and aliases.
2. Add active Antigravity support and remove the retired Google agent from active config sync.
3. Keep Codewith behavior compatible with existing flattened renders and the
   `HASNA_CONFIGS_CODEWITH_NATIVE_IMPORTS` gate.
4. Seed the managed `global-agent-rules-standard` reference so canonical global
   prompt content includes the required operating rules.
5. Add tests that prove layer ordering, Antigravity output paths, the
   Antigravity 12,000-character rule-file limit, active agent target coverage,
   and the seeded global rules content.
