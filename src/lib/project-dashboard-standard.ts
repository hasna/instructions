import type { Database } from "bun:sqlite";
import type { Config, ProfileVariables } from "../types/index.js";
import { createConfig, getConfig, updateConfig } from "../db/configs.js";

export const PROJECT_DASHBOARD_STANDARD_SLUG = "agent-managed-project-dashboard-standard";

export const PROJECT_DASHBOARD_PROFILE_VARIABLES: ProfileVariables = {
  PROJECT_DASHBOARD_DIR: ".hasna/project",
  PROJECT_DASHBOARD_RENDER_MANIFEST: ".hasna/project/dashboard/render.json",
  PROJECT_DASHBOARD_SNAPSHOTS_DIR: ".hasna/project/dashboard/snapshots",
  PROJECT_CHANNEL_PREFIX: "iproj-",
};

export const PROJECT_DASHBOARD_STANDARD_CONTENT = `# Agent-Managed Project Dashboard Standard

This standard applies to Hasna work projects under \`Workspace/<division>/project/<slug>\`.
Humans do not work directly inside these folders; agents keep structure,
evidence, tasks, knowledge, and dashboard output consistent.

## Canonical Files

- Project manifest root: \`.hasna/project/\`
- Dashboard render manifest: \`.hasna/project/dashboard/render.json\`
- Latest snapshot: \`.hasna/project/dashboard/snapshots/latest.snapshot.json\`
- Dashboard schema ids come from \`@hasna/contracts\`.
- Project folders may contain private documents, but render JSON must contain
  only ids, counts, statuses, resource refs, evidence refs, and redacted
  summaries.

## Viewer Commands

Use the Projects-owned viewer. Do not invent a separate per-project app unless
\`open-projects\` cannot express the surface.

\`\`\`bash
projects dashboard snapshot <project> --write --json
projects dashboard render <project> --json
projects dashboard validate <project> --json
PROJECTS_DASHBOARD_TOKEN=<token> projects dashboard serve <project> --host 0.0.0.0 --port <port>
\`\`\`

Non-loopback serving must use \`--token\`, \`PROJECTS_DASHBOARD_TOKEN\`, or an
explicit \`--trust-network\` choice. Never put the token in a URL, task
evidence, render spec, or report.

## Provider Panels

Provider CLIs emit bounded \`hasna.project_panel.v1\` summaries:

\`\`\`bash
todos project-panel --project <project> --json --contract
files project-panel --project <project> --json --contract
mailery status project-panel --project <project> --limit 20 --json --contract
conversations project-panel --project <project> --limit 30 --json --contract
knowledge project-panel --project <project> --scope project --limit 30 --json --contract
mementos --json project-panel --project <project> --contract
reports project-panel --project <project> --json --contract
\`\`\`

Providers must degrade to unavailable/error panels instead of dumping raw
content. Mailery is workspace-scoped until explicit project-email mapping is
configured; Knowledge must run from the project cwd or with the correct store
context.

## Coordination

- Project conversation channels use \`iproj-<project-slug>\` in the CLI and are
  displayed to humans as \`#iproj-<project-slug>\`.
- Todos tasks are the source of truth for work; messages are only coordination.
- Durable Codewith goal plans should own long-running implementation.
- New implementation/verification work should route through task-triggered fresh
  agent runs, not by opening or pasting into existing tmux panes.
- Agent handoff should reference task ids, project ids, commit ids, evidence
  paths, and dashboard URLs without exposing secrets or raw private documents.

## Report Rules

Reports and dashboards should use JSON Render/React Flow through
\`projects dashboard render\`. Include decisions, open questions, bank/document
ids, tasks, and evidence refs. Exclude raw email bodies, account numbers, tax
ids, passport numbers, credentials, and contract clauses unless an explicit
approved storage policy exists.
`;

export function ensureProjectDashboardStandardConfig(db?: Database): Config {
  const input = {
    name: "Agent Managed Project Dashboard Standard",
    category: "workspace" as const,
    agent: "global" as const,
    format: "markdown" as const,
    content: PROJECT_DASHBOARD_STANDARD_CONTENT,
    kind: "reference" as const,
    description: "Standard structure, provider commands, channel naming, and safety rules for agent-managed project dashboards",
    tags: ["projects-dashboard", "agent-projects", "json-render"],
  };

  try {
    const existing = getConfig(PROJECT_DASHBOARD_STANDARD_SLUG, db);
    if (
      existing.content !== input.content
      || existing.description !== input.description
      || existing.category !== input.category
      || existing.agent !== input.agent
      || existing.format !== input.format
      || existing.kind !== input.kind
    ) {
      return updateConfig(existing.id, input, db);
    }
    return existing;
  } catch {
    return createConfig(input, db);
  }
}
