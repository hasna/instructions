import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

describe("configs session CLI", () => {
  test("help lists accepted source layers and aliases", () => {
    const result = runCli(["session", "plan", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("global|provider|tool|account|identity|agent|project|local");
    expect(result.stdout).toContain("--project-root");
    expect(result.stdout).toContain("--allow-empty-sources");
  });

  test("fails closed when no sources are provided unless explicitly allowed", () => {
    const home = mkdtempSync(join(tmpdir(), "open-configs-session-cli-"));
    try {
      const env = {
        HOME: home,
        HASNA_CONFIGS_HOME: join(home, ".hasna", "configs"),
      };
      const failed = runCli([
        "session",
        "plan",
        "--tool",
        "codex",
        "--profile",
        "account999",
        "--json",
      ], env);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("no instruction sources");

      const allowed = runCli([
        "session",
        "plan",
        "--tool",
        "codex",
        "--profile",
        "account999",
        "--allow-empty-sources",
        "--json",
      ], env);
      expect(allowed.status).toBe(0);
      const plan = JSON.parse(allowed.stdout) as { warnings: string[] };
      expect(plan.warnings).toContain("No instruction sources were provided.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("expands quoted source and target paths before planning", () => {
    const home = mkdtempSync(join(tmpdir(), "open-configs-session-cli-"));
    try {
      mkdirSync(join(home, "sources"), { recursive: true });
      writeFileSync(join(home, "sources", "global.md"), "Global CLI source");

      const result = runCli([
        "session",
        "plan",
        "--tool",
        "codex",
        "--profile",
        "account999",
        "--target-home",
        '"~/session-home"',
        "--source",
        'global:global-cli="~/sources/global.md"',
        "--json",
      ], {
        HOME: home,
        HASNA_CONFIGS_HOME: join(home, ".hasna", "configs"),
      });

      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout) as {
        targetHome: string;
        manifest: { sources: Array<{ path: string | null }> };
      };
      expect(plan.targetHome).toBe(join(home, "session-home"));
      expect(plan.manifest.sources[0]?.path).toBe(join(home, "sources", "global.md"));
      expect(result.stdout).not.toContain("Global CLI source");
      expect(plan).not.toHaveProperty("files.0.content");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applies session files only outside dry-run", () => {
    const home = mkdtempSync(join(tmpdir(), "open-configs-session-cli-"));
    try {
      mkdirSync(join(home, "sources"), { recursive: true });
      writeFileSync(join(home, "sources", "global.md"), "Global CLI apply source");
      const env = {
        HOME: home,
        HASNA_CONFIGS_HOME: join(home, ".hasna", "configs"),
      };

      const dryRun = runCli([
        "session",
        "apply",
        "--tool",
        "codex",
        "--profile",
        "account999",
        "--target-home",
        "~/session-home",
        "--source",
        "global:global-cli=~/sources/global.md",
        "--dry-run",
        "--json",
      ], env);

      expect(dryRun.status).toBe(0);
      expect(existsSync(join(home, "session-home", "AGENTS.md"))).toBe(false);

      const apply = runCli([
        "session",
        "apply",
        "--tool",
        "codex",
        "--profile",
        "account999",
        "--target-home",
        "~/session-home",
        "--source",
        "global:global-cli=~/sources/global.md",
        "--json",
      ], env);

      expect(apply.status).toBe(0);
      expect(readFileSync(join(home, "session-home", "AGENTS.md"), "utf-8")).toContain("Global CLI apply source");
      const result = JSON.parse(apply.stdout) as { applied: boolean; conflicts: unknown[] };
      expect(result.applied).toBe(true);
      expect(result.conflicts).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loads OpenIdentities configs exports and provider layer aliases", () => {
    const home = mkdtempSync(join(tmpdir(), "open-configs-session-cli-"));
    try {
      const exportPath = join(home, "instructions.json");
      writeFileSync(exportPath, JSON.stringify({
        contract: "hasna.identities.configs-instructions/v1",
        validation: { valid: true },
        sources: [
          {
            id: "provider-codewith",
            label: "Provider Codewith",
            layer: "tool",
            merge: "append",
            order: 200,
            content: "Codewith provider rules.",
            targetProviders: ["codewith"],
          },
          {
            id: "claude-only",
            label: "Claude Only",
            layer: "tool",
            merge: "append",
            order: 201,
            content: "Claude only.",
            targetProviders: ["claude"],
          },
        ],
      }));
      mkdirSync(join(home, "sources"), { recursive: true });
      writeFileSync(join(home, "sources", "project.md"), "Project CLI source");

      const result = runCli([
        "session",
        "plan",
        "--tool",
        "codewith",
        "--profile",
        "account999",
        "--target-home",
        "~/codewith-home",
        "--identity-export",
        exportPath,
        "--source",
        "project:project-cli=~/sources/project.md",
        "--json",
      ], {
        HOME: home,
        HASNA_CONFIGS_HOME: join(home, ".hasna", "configs"),
      });

      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout) as { manifest: { sources: Array<{ id: string; layer: string }> } };
      expect(plan.manifest.sources.map((source) => source.id)).toEqual(["provider-codewith", "project-cli"]);
      expect(plan.manifest.sources.map((source) => source.layer)).toEqual(["tool", "project"]);
      expect(result.stdout).not.toContain("Claude only.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applies canonical identity exports with source paths and filters rule provider blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "open-configs-session-cli-"));
    try {
      const exportDir = join(home, "identity-export");
      mkdirSync(join(exportDir, "providers"), { recursive: true });
      writeFileSync(join(exportDir, "providers", "codewith.md"), "CLI resolved path-only Codewith rules.");
      const exportPath = join(exportDir, "instructions.json");
      writeFileSync(exportPath, JSON.stringify({
        version: 1,
        package: "@hasna/identities",
        exportedAt: "2026-07-01T00:00:00.000Z",
        sources: [
          {
            id: "canonical-path-only-codewith",
            kind: "provider-rules",
            title: "Canonical Path Only Codewith",
            owner: { kind: "provider", id: "codewith" },
            sensitivity: "internal",
            precedence: 200,
            mergePolicy: "append",
            safety: "standard",
            nonOverridable: false,
            ruleIds: ["rule:provider-filter"],
            targetProviders: ["codewith"],
            providerCompatibility: [],
            sourcePaths: [{ path: "providers/codewith.md", editable: true, required: true }],
            globs: [],
            hash: "sha256:canonical-path",
            provenance: { createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
            metadata: {},
            rules: [
              {
                id: "rule:provider-filter",
                path: "rules/provider-filter.md",
                content: [
                  "CLI shared provider-filter rule.",
                  "<!-- @hasna-provider: claude -->",
                  "CLI Claude-only rule leak.",
                  "<!-- @hasna-end-provider -->",
                  "<!-- @hasna-provider: codewith -->",
                  "CLI Codewith-only rule.",
                  "<!-- @hasna-end-provider -->",
                ].join("\n"),
              },
            ],
          },
        ],
        validation: { valid: true, sourceCount: 1, issues: [], effectiveHash: "sha256:canonical", nonOverridableSafetyRules: [] },
        metadata: {},
      }));

      const result = runCli([
        "session",
        "apply",
        "--tool",
        "codewith",
        "--profile",
        "account999",
        "--target-home",
        "~/codewith-home",
        "--identity-export",
        exportPath,
        "--json",
      ], {
        HOME: home,
        HASNA_CONFIGS_HOME: join(home, ".hasna", "configs"),
      });

      expect(result.status).toBe(0);
      const rendered = readFileSync(join(home, "codewith-home", "CODEWITH.md"), "utf-8");
      expect(rendered).toContain("CLI resolved path-only Codewith rules.");
      expect(rendered).toContain("CLI Codewith-only rule.");
      expect(rendered).not.toContain("CLI Claude-only rule leak.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
