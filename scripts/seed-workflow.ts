#!/usr/bin/env bun
/**
 * Seeds the agent-workflow template into the configs DB.
 * This is the canonical reference for how AI agents should use the @hasna ecosystem.
 */
import { getDatabase } from "../src/db/database";
import { createConfig, getConfig } from "../src/db/configs";

const db = getDatabase();

const WORKFLOW_TEMPLATE = `# Agent Workflow — @hasna Ecosystem Standard

## Session Start Protocol

\`\`\`
1. Register presence
   conversations heartbeat --name {{AGENT_NAME}} --status "starting — {{PROJECT_NAME}}"

2. Check for assigned work
   todos claim {{AGENT_NAME}}
   # or: todos next --agent {{AGENT_NAME}}

3. Load project context (use compact format for 60% token savings)
   mementos inject --project {{PROJECT_NAME}} --format compact
   mementos recall --scope global --min-importance 8

4. Check messages
   conversations read --to {{AGENT_NAME}} --unread-only
   conversations read --space {{PROJECT_SPACE}} --limit 5

5. Sync configs (if needed)
   configs pull --agent claude
\`\`\`

## During Work

\`\`\`
- Save learnings constantly
  mementos save --key "finding-name" --value "what you learned" --scope shared --importance 7

- Update presence periodically
  conversations heartbeat --name {{AGENT_NAME}} --status "working on X"

- Communicate decisions
  conversations send "shipped X" --channel {{PROJECT_SPACE}} --from {{AGENT_NAME}}

- Track progress
  todos update <task-id> --status in_progress
\`\`\`

## Session End Protocol

\`\`\`
1. Complete task with evidence
   todos done <task-id> --commit-hash <hash> --files-changed src/foo.ts

2. Save session summary
   mementos save --key "session-summary" --value "what was accomplished" --scope shared --importance 8

3. Post completion to space
   conversations send "shipped: description of changes" --channel {{PROJECT_SPACE}} --from {{AGENT_NAME}}

4. Clean up
   attachments health-check --fix   # regenerate any expired evidence links
   configs pull                     # sync any config changes
\`\`\`

## MCP Server Configuration

Set profiles to minimize context window usage:

\`\`\`bash
# In your MCP server config, set env vars:
TODOS_PROFILE=minimal        # 8 tools: claim, complete, fail, status, get, start, comment, next
MEMENTOS_PROFILE=minimal     # core memory ops only
CONFIGS_PROFILE=minimal      # 3 tools: get_status, get_config, sync_known
ATTACHMENTS_PROFILE=minimal  # 3 tools: upload, download, get_link
\`\`\`

## Environment Variables

\`\`\`bash
export ANTHROPIC_API_KEY="{{ANTHROPIC_API_KEY}}"  # Required for Claude
export OPENAI_API_KEY="{{OPENAI_API_KEY}}"        # Optional: embeddings, voice
export EXA_API_KEY="{{EXA_API_KEY}}"              # Optional: web search
export GITHUB_TOKEN="{{GITHUB_TOKEN}}"            # Optional: GitHub API
\`\`\`

## Install Everything

\`\`\`bash
bun install -g @hasna/configs
configs bootstrap    # installs all 10 @hasna packages + registers MCP servers
configs init         # syncs all known configs from disk
\`\`\`
`;

import { updateConfig } from "../src/db/configs";

try {
  const existing = getConfig("agent-workflow-template", db);
  updateConfig(existing.id, { content: WORKFLOW_TEMPLATE }, db);
  console.log(`= agent-workflow-template updated (v${existing.version + 1})`);
} catch {
  const c = createConfig({
    name: "Agent Workflow Template",
    category: "rules",
    agent: "global",
    format: "markdown",
    content: WORKFLOW_TEMPLATE,
    kind: "reference",
    is_template: true,
    description: "Canonical reference for how AI agents should use the @hasna ecosystem — session start/end protocol, MCP profiles, env vars",
    tags: ["workflow", "template", "ecosystem"],
  }, db);
  console.log(`+ ${c.slug} (reference template)`);
}
