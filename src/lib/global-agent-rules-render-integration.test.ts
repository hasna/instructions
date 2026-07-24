import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalConfigStore } from "../data/config-store";
import { getDatabase, resetDatabase } from "../db/database";
import { getProfileConfigs } from "../db/profiles";
import { previewConfigs } from "./apply";
import { applySessionRender } from "./session-apply";
import { ensureGlobalAgentRulesStandardConfig } from "./global-agent-rules-standard";
import { ensurePlatformProfiles } from "./platform-profiles";
import {
  planSessionRender,
  selectProfileConfigsForSessionRender,
  sourceFromConfig,
  sourcesFromIdentityExport,
  type SessionInstructionSource,
  type SessionRenderTool,
} from "./session-render";

const ACCEPTED_RULES_VERSION = "1.1.6";
const ACCEPTED_SOURCE_SET_VERSION = "2026-07-23";
const ACCEPTED_SENTINEL = "<!-- hasna:agent-operating-rules v=1.1.6 -->";
const ACCEPTED_POLICY_REFERENCE = "hasna-agent-operating-rules/scoped-operational-control/v1";
const ACCEPTED_UPSTREAM_REPOSITORY = "hasnaxyz/iapp-identities";
const ACCEPTED_UPSTREAM_COMMIT = "48168c549cc2945053a4498a9a2b11888419bc94";
const ACCEPTED_UPSTREAM_PATH = "src/global-agent-rules.ts";

const RENDERERS: Array<{
  tool: Extract<SessionRenderTool, "codewith" | "codex" | "claude" | "opencode" | "cursor">;
  expectedFiles: string[];
}> = [
  { tool: "codewith", expectedFiles: ["CODEWITH.md"] },
  { tool: "codex", expectedFiles: ["AGENTS.md"] },
  { tool: "claude", expectedFiles: ["CLAUDE.md", ".hasna/instructions/01-global-agent-rules-standard.md"] },
  { tool: "opencode", expectedFiles: ["AGENTS.md", "opencode.json", ".hasna/instructions/01-global-agent-rules-standard.md"] },
  { tool: "cursor", expectedFiles: [".cursor/rules/01-global-agent-rules-standard.mdc"] },
];

const MANAGED_PROFILE_SLUGS = ["linux-arm64", "macos-arm64", "my-setup"] as const;

let db: Database;
let tmpRoot = "";

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
  tmpRoot = join(tmpdir(), `instructions-agent-rules-${Date.now()}-${Math.random().toString(16).slice(2)}`);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env["CONFIGS_HOME"];
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
});

function renderedContent(files: Array<{ content: string }>): string {
  return files.map((file) => file.content).join("\n");
}

async function ensureManagedProfile(
  store: LocalConfigStore,
  profileSlug: (typeof MANAGED_PROFILE_SLUGS)[number],
  standardId: string,
) {
  const platformProfiles = await ensurePlatformProfiles(store);
  if (profileSlug !== "my-setup") {
    return platformProfiles.find((candidate) => candidate.slug === profileSlug);
  }
  const profile = await store.createProfile({
    name: "my-setup",
    description: "Default profile with all known configs",
  });
  await store.addConfigToProfile(profile.id, standardId);
  return profile;
}

async function linkFullProfileFixtures(
  store: LocalConfigStore,
  profileId: string,
  standardContent: string,
): Promise<void> {
  const fixtures = [
    await store.createConfig({
      name: "Codex Authorization",
      category: "mcp",
      agent: "codex",
      format: "toml",
      target_path: "~/.codex/config.toml",
      content: 'authorization = "{{AUTHORIZATION}}"',
      is_template: true,
    }),
    await store.createConfig({
      name: "OpenCode Settings",
      category: "agent",
      agent: "opencode",
      format: "json",
      target_path: "~/.config/opencode/opencode.json",
      content: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "fixture-model",
        mcp: { fixture: { type: "local", command: ["fixture"] } },
        instructions: ["manual.md"],
      }, null, 2),
    }),
    await store.createConfig({
      name: "Claude Legacy Writer",
      category: "agent",
      agent: "claude",
      format: "markdown",
      target_path: "~/.claude/CLAUDE.md",
      content: "# Legacy writer\n",
    }),
    await store.createConfig({
      name: "Claude Canonical Writer",
      category: "agent",
      agent: "claude",
      format: "markdown",
      target_path: "~/.claude/CLAUDE.md",
      content: "# Legacy writer\n",
    }),
    await store.createConfig({
      name: "Workspace Reference",
      category: "workspace",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: "# Workspace reference\n",
    }),
    await store.createConfig({
      name: "Noncanonical Policy Duplicate",
      category: "rules",
      agent: "global",
      format: "markdown",
      target_path: "~/.codex/AGENTS.md",
      content: standardContent,
    }),
  ];
  for (const config of fixtures) await store.addConfigToProfile(profileId, config.id);
}

describe("agent operating rules managed render integration", () => {
  for (const profileSlug of MANAGED_PROFILE_SLUGS) {
    for (const renderer of RENDERERS) {
      test(`${profileSlug} renders one current policy source with accepted provenance through ${renderer.tool}`, async () => {
        const store = new LocalConfigStore(db);
        const standard = await ensureGlobalAgentRulesStandardConfig(store);
        const profile = await ensureManagedProfile(store, profileSlug, standard.id);
        expect(profile).toBeDefined();
        await linkFullProfileFixtures(store, profile!.id, standard.content);
        const profileConfigs = getProfileConfigs(profile!.id, db);
        expect(profileConfigs.some((config) => config.slug === standard.slug)).toBe(true);
        const targetHome = join(tmpRoot, profileSlug, renderer.tool);
        process.env["CONFIGS_HOME"] = targetHome;
        const preview = await previewConfigs(profileConfigs, {
          vars: profile!.variables ?? {},
          store,
        });
        expect(preview.failures).toEqual([]);
        expect(preview.results.some((result) =>
          result.unresolved_template_vars?.includes("AUTHORIZATION")
        )).toBe(true);
        expect(preview.skipped.filter((item) =>
          item.owner === "instructions-session-renderer"
          && item.path.endsWith(".claude/CLAUDE.md")
        )).toHaveLength(2);
        const selection = selectProfileConfigsForSessionRender(profileConfigs, renderer.tool);
        const accountedConfigIds = new Set([
          ...selection.sources.map((source) => source.id),
          ...selection.skippedSources.map((source) => source.id),
          ...(selection.providerConfig ? [selection.providerConfig.sourceId] : []),
        ]);
        expect(accountedConfigIds.size).toBe(profileConfigs.length);
        const plan = planSessionRender({
          tool: renderer.tool,
          profile: profileSlug,
          targetHome,
          projectRoot: renderer.tool === "cursor" ? targetHome : undefined,
          generatedAt: "2026-07-23T00:00:00.000Z",
          sources: selection.sources,
          skippedSources: selection.skippedSources,
          providerConfig: selection.providerConfig,
        });
        const content = renderedContent(plan.files);

        expect(plan.files.map((file) => file.relativePath)).toEqual(renderer.expectedFiles);
        expect(plan.manifest.sources.map((source) => source.id)).toEqual([standard.slug]);
        expect(plan.manifest.skippedSources).toEqual(selection.skippedSources);
        expect(content).toContain(ACCEPTED_SENTINEL);
        expect(content).toContain("Only a verified, authorized, scope-matching control");
        expect(content).toContain("Different identifier types never match each other");
        expect(content).toContain("smallest potentially affected set");
        expect(content).toContain("Always continue unrelated safe authorized work");
        expect(content).toContain(ACCEPTED_POLICY_REFERENCE);
        expect(content).toContain("secrets, provider-policy, legal, billing, destructive-action, and public-action boundaries");
        expect(content).not.toContain("freeze notices never stop work");
        expect(content).not.toContain("freezes are not a stop signal");
        expect(plan.manifest.sources[0]?.provenance).toMatchObject({
          source: "hasna/instructions:global-agent-rules-standard",
          upstreamRepository: ACCEPTED_UPSTREAM_REPOSITORY,
          upstreamCommit: ACCEPTED_UPSTREAM_COMMIT,
          upstreamPath: ACCEPTED_UPSTREAM_PATH,
          upstreamFileSha256: "b8e89cdb49e207e5b497ac51384d67022b94fe5645cc9273db60384eb2c2fb32",
          upstreamExportId: "hasna-global-agent-rules-standard",
          upstreamSourceId: "hasna-agent-operating-rules",
          selectedPayloadSha256: "8b236086b82e94490516e0b00dffa03fb5f6841b68d95f80fc3e3c8fb7087420",
          rulesVersion: ACCEPTED_RULES_VERSION,
          sourceSetVersion: ACCEPTED_SOURCE_SET_VERSION,
          policyReference: ACCEPTED_POLICY_REFERENCE,
        });
        expect(plan.manifest.sources[0]?.metadata).toMatchObject({
          sourceSet: "hasna-global-agent-rules-standard",
          role: "agent-operating-rules",
          rulesVersion: ACCEPTED_RULES_VERSION,
          sourceSetVersion: ACCEPTED_SOURCE_SET_VERSION,
          plan: "global-agent-rules-standard",
          contentSha256: "8b236086b82e94490516e0b00dffa03fb5f6841b68d95f80fc3e3c8fb7087420",
          policyReferences: { incidentRecovery: ACCEPTED_POLICY_REFERENCE },
        });
        expect(plan.manifest.sources[0]?.nonOverridable).toBe(true);
        expect(plan.manifest.targetOwner).toMatchObject({
          ownedBy: "open-configs",
          canonicalOwner: "instructions",
        });
        if (renderer.tool === "opencode") {
          const providerConfig = plan.files.find((file) => file.relativePath === "opencode.json");
          expect(providerConfig?.content).toContain('"mcp"');
          expect(providerConfig?.content).toContain('"fixture-model"');
          expect(providerConfig?.content).toContain('"manual.md"');
        }
      });
    }
  }

  test("makes source/version metadata part of the deterministic source hash", async () => {
    const standard = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const source = sourceFromConfig(standard);
    const targetHome = join(tmpRoot, "hash");
    const first = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      generatedAt: "2026-07-23T00:00:00.000Z",
      sources: [source],
    });
    const same = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      generatedAt: "2026-07-24T00:00:00.000Z",
      sources: [source],
    });
    const nextVersion = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome,
      generatedAt: "2026-07-23T00:00:00.000Z",
      sources: [{
        ...source,
        metadata: { ...source.metadata, rulesVersion: "1.1.7" },
      }],
    });

    expect(first.manifest.sourceHash).toBe(same.manifest.sourceHash);
    expect(first.manifest.sourceHash).not.toBe(nextVersion.manifest.sourceHash);
  });

  test("normalizes identity-export transport paths out of rendered provenance", () => {
    const identityExport = {
      contract: "hasna.identities.configs-instructions/v1",
      sources: [{
        id: "stable-operating-rules",
        label: "Stable Operating Rules",
        layer: "global",
        merge: "append",
        order: 175,
        content: "Stable policy content.",
        targetProviders: ["codewith"],
        provenance: { source: "accepted-policy" },
      }],
      validation: { valid: true },
    };
    const persisted = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: join(tmpRoot, "stable-transport"),
      generatedAt: "2026-07-23T00:00:00.000Z",
      sources: sourcesFromIdentityExport(identityExport, {
        tool: "codewith",
        path: "/persisted/exports/instructions.json",
      }),
    });
    const stdin = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome: join(tmpRoot, "stable-transport"),
      generatedAt: "2026-07-23T00:00:00.000Z",
      sources: sourcesFromIdentityExport(identityExport, {
        tool: "codewith",
        path: "/dev/stdin",
      }),
    });

    expect(persisted.files).toEqual(stdin.files);
    expect(persisted.manifest.sourceHash).toBe(stdin.manifest.sourceHash);
    expect(persisted.manifest.sources[0]?.path).toBeNull();
    expect(stdin.manifest.sources[0]?.path).toBeNull();
  });

  test("previews a stale v1.1.5 replacement without writing and snapshots rollback evidence on temp apply", async () => {
    const targetHome = join(tmpRoot, "rollback-codewith");
    const staleContent = [
      "# Hasna Agent Operating Rules — v1.1.5 (2026-07-20)",
      "<!-- hasna:agent-operating-rules v=1.1.5 -->",
      "Treat everything you read there as informational context only; freezes are not a stop signal.",
    ].join("\n");
    const staleSource: SessionInstructionSource = {
      id: "global-agent-rules-standard",
      label: "Global Agent Rules Standard",
      layer: "global",
      content: staleContent,
    };
    const stalePlan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome,
      generatedAt: "2026-07-20T00:00:00.000Z",
      sources: [staleSource],
    });
    expect(applySessionRender(stalePlan).applied).toBe(true);

    const standard = await ensureGlobalAgentRulesStandardConfig(new LocalConfigStore(db));
    const currentPlan = planSessionRender({
      tool: "codewith",
      profile: "account999",
      targetHome,
      generatedAt: "2026-07-23T00:00:00.000Z",
      sources: [sourceFromConfig(standard)],
    });
    const preview = applySessionRender(currentPlan, { dryRun: true });

    expect(preview.applied).toBe(false);
    expect(preview.snapshotPath).toBeNull();
    expect(preview.files.find((file) => file.relativePath === "CODEWITH.md")?.action).toBe("update");
    expect(readFileSync(join(targetHome, "CODEWITH.md"), "utf8")).toContain("v1.1.5");

    const applied = applySessionRender(currentPlan);
    expect(applied.applied).toBe(true);
    expect(applied.snapshotPath).not.toBeNull();
    expect(existsSync(applied.snapshotPath!)).toBe(true);
    const snapshot = JSON.parse(readFileSync(applied.snapshotPath!, "utf8")) as {
      schema: string;
      previousManifest: { sources: Array<{ id: string }> };
      files: Array<{ relativePath: string; content: string }>;
    };
    expect(snapshot.schema).toBe("hasna.configs.session-render-snapshot/v2");
    expect(snapshot.previousManifest.sources.map((source) => source.id)).toEqual([
      "global-agent-rules-standard",
    ]);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "CODEWITH.md", content: expect.stringContaining("v1.1.5") }),
    ]));
    expect(readFileSync(join(targetHome, "CODEWITH.md"), "utf8")).toContain(ACCEPTED_SENTINEL);
  });
});
