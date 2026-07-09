#!/usr/bin/env bun
/**
 * Seed the configs DB with all known AI coding agent configs.
 * Run: bun run seed
 */
import { getDatabase } from "../src/db/database";
import { getConfigStats } from "../src/db/configs";
import { syncKnown } from "../src/lib/sync";
import { LocalConfigStore } from "../src/data/config-store";
import { ensurePlatformProfiles } from "../src/lib/platform-profiles";
import { ensureProjectDashboardStandardConfig } from "../src/lib/project-dashboard-standard";
import { ensureGlobalAgentRulesStandardConfig } from "../src/lib/global-agent-rules-standard";

const db = getDatabase();
const store = new LocalConfigStore(db);

console.log("\n@hasna/configs — seeding initial configurations\n");

// Sync all known configs (CLAUDE.md, rules/*.md, settings.json, codex, antigravity, zshrc, gitconfig, npmrc, etc.)
const result = await syncKnown({ store });
console.log(`Synced known configs: +${result.added} updated:${result.updated} unchanged:${result.unchanged} skipped:${result.skipped.length}`);
if (result.skipped.length > 0) {
  console.log("  skipped (not found):", result.skipped.join(", "));
}

// Add reference docs (workspace structure + secrets schema)
const refs: Array<{ slug: string; name: string; category: "workspace" | "secrets_schema"; content: string; description: string }> = [
  {
    slug: "workspace-structure",
    name: "Workspace Structure",
    category: "workspace",
    description: "~/Workspace/ hierarchy and naming conventions",
    content: `# Workspace Structure Convention

All development work lives in ~/Workspace/, organized in a 4-level hierarchy:

\`\`\`
~/Workspace/{division}/{team}/{sub-team}/{repo}/
\`\`\`

## Divisions
hasnaai, hasnafamily, hasnafoundation, hasnastudio, hasnasystems, hasnatools, hasnaxyz

## Teams
agent, connector, engine, hook, internalapp, offer, plugin, project, scaffold, service, skill, template, tool, venture

## Sub-teams (lifecycle)
*dev (active), *maintain (maintenance), *review (under review), *archive (archived)

## Repo naming: {type}-{name}
Examples: tool-skillsmd, scaffold-mcp, engine-offer
`,
  },
  {
    slug: "secrets-schema",
    name: "Secrets Schema",
    category: "secrets_schema",
    description: "Shape of ~/.secrets — keys and purpose (no actual values stored)",
    content: `# .secrets File Schema

Location: ~/.secrets (sourced by ~/.zshrc)
Format: export KEY_NAME="value"

## Keys
| Key | Description |
|-----|-------------|
| ANTHROPIC_API_KEY | Claude/Anthropic AI |
| OPENAI_API_KEY | OpenAI/GPT |
| EXA_API_KEY | Exa semantic search |
| NPM_TOKEN | npm publish token; keep the value in the runtime environment or approved vault, never as a literal ~/.npmrc value |
| GITHUB_TOKEN | GitHub API |
`,
  },
];

console.log("\nReference docs:");
for (const ref of refs) {
  try {
    await store.getConfig(ref.slug);
    console.log(`  = ${ref.slug}`);
  } catch {
    const c = await store.createConfig({ name: ref.name, category: ref.category, agent: "global", format: "markdown", content: ref.content, kind: "reference", description: ref.description });
    console.log(`  + ${c.slug} (reference)`);
  }
}

const globalAgentRulesStandard = await ensureGlobalAgentRulesStandardConfig(store);
console.log(`  = ${globalAgentRulesStandard.slug}`);

const projectDashboardStandard = await ensureProjectDashboardStandardConfig(store);
console.log(`  = ${projectDashboardStandard.slug}`);

const machineProfiles = await ensurePlatformProfiles(store);
console.log(`\nMachine-aware profiles: ${machineProfiles.map((profile) => profile.slug).join(", ")}`);

const stats = getConfigStats(db);
console.log("\n✓ Done. DB stats:");
for (const [key, count] of Object.entries(stats)) {
  if (count > 0) console.log(`  ${key.padEnd(18)} ${count}`);
}
