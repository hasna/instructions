import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  INBOX_CONVERSATIONS_MINIMUM_VERSION,
  inspectManagedSkillRuntimes,
  reconcileManagedSkillRuntimes,
  writeSkillContractsTransactional,
} from "./managed-skill-runtimes";
import { tempRootPath } from "./test-temp-root";

const roots: string[] = [];
const canonicalSkill = `---
name: inbox
description: Test contract for the package-owned conversations watcher.
---

There is no separate inbox executable.
Run conversations watch --from <agent> --all --interval 60000 --full-content.
`;

function makeRoot(label: string): string {
  const root = tempRootPath(`managed-skill-runtimes-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function writeCanonicalAsset(root: string): string {
  const assetPath = join(root, "canonical-inbox-SKILL.md");
  writeFileSync(assetPath, canonicalSkill);
  return assetPath;
}

function installInboxSkill(homeDir: string, agentHome = ".claude", content = "stale inbox contract\n"): string {
  const skillDir = join(homeDir, agentHome, "skills", "inbox");
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, content);
  return skillPath;
}

function writeConversationsRuntime(
  root: string,
  options: { version?: string; watchHelp?: string; heartbeatExit?: number } = {},
): string {
  const commandPath = join(root, "conversations");
  const version = options.version ?? INBOX_CONVERSATIONS_MINIMUM_VERSION;
  const watchHelp = options.watchHelp ?? [
    "--from <agent>",
    "--all",
    "--full-content",
  ].join("\\n");
  writeFileSync(
    commandPath,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (args[0] === "watch" && args[1] === "--help") {
  console.log(${JSON.stringify(watchHelp)});
  process.exit(0);
}
if (args[0] === "agents" && args[1] === "heartbeat") {
  console.log(JSON.stringify({ ok: ${options.heartbeatExit ?? 0} === 0 }));
  process.exit(${options.heartbeatExit ?? 0});
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  chmodSync(commandPath, 0o755);
  return commandPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("managed inbox skill runtime", () => {
  test("does not report an installed inbox skill healthy when conversations watch is unavailable", () => {
    const homeDir = makeRoot("missing-runtime");
    installInboxSkill(homeDir);

    const report = inspectManagedSkillRuntimes({
      homeDir,
      conversationsCommand: join(homeDir, "missing-conversations"),
    });

    expect(report).toMatchObject({
      skills_present: 1,
      healthy: 0,
      missing: 1,
    });
    expect(report.runtimes[0]).toMatchObject({
      skill: "inbox",
      runtime: "conversations watch",
      runtime_present: false,
      healthy: false,
      reason: "conversations command unavailable",
    });
  });

  test("dry-run predicts skill contract updates without writing or creating a legacy executable", async () => {
    const root = makeRoot("dry-run");
    const homeDir = join(root, "home");
    const skillPath = installInboxSkill(homeDir);
    const assetPath = writeCanonicalAsset(root);
    const conversationsCommand = writeConversationsRuntime(root);

    const result = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
      dryRun: true,
    });

    expect(result).toMatchObject({
      changed: 1,
      failed: 0,
      dry_run: true,
    });
    expect(result.runtimes[0]).toMatchObject({
      action: "update",
      skill_contracts_changed: 1,
      hosted_heartbeat: "unverified",
      manual_fallback_ready: true,
      healthy: false,
      reason: "hosted heartbeat unverified; manual fallback required",
    });
    expect(readFileSync(skillPath, "utf8")).toBe("stale inbox contract\n");
    expect(existsSync(join(homeDir, ".hasna", "bin", "inbox"))).toBe(false);
    expect(existsSync(join(homeDir, ".local", "bin", "inbox"))).toBe(false);
  });

  test("updates every installed skill contract and converges on conversations watch only", async () => {
    const root = makeRoot("apply");
    const homeDir = join(root, "home");
    const claudeSkill = installInboxSkill(homeDir, ".claude");
    const codexSkill = installInboxSkill(homeDir, ".codex");
    const assetPath = writeCanonicalAsset(root);
    const conversationsCommand = writeConversationsRuntime(root);

    const result = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
      agent: "test-agent",
      deliveryVerified: true,
    });

    expect(result).toMatchObject({
      changed: 1,
      failed: 0,
      dry_run: false,
    });
    expect(result.runtimes[0]).toMatchObject({
      action: "update",
      skill_contracts_changed: 2,
      runtime_version: INBOX_CONVERSATIONS_MINIMUM_VERSION,
      watch_supports_from: true,
      watch_supports_all: true,
      watch_supports_full_content: true,
      hosted_heartbeat: "passed",
      delivery_verified: true,
      manual_fallback_ready: true,
      healthy: true,
      reason: "ready",
    });
    expect(readFileSync(claudeSkill, "utf8")).toBe(canonicalSkill);
    expect(readFileSync(codexSkill, "utf8")).toBe(canonicalSkill);
    expect(existsSync(join(homeDir, ".hasna", "bin", "inbox"))).toBe(false);
    expect(existsSync(join(homeDir, ".local", "bin", "inbox"))).toBe(false);

    const second = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
      agent: "test-agent",
      deliveryVerified: true,
    });
    expect(second).toMatchObject({ changed: 0, failed: 0 });
    expect(second.runtimes[0]).toMatchObject({ action: "unchanged", healthy: true });
  });

  test("preserves an earlier concurrent edit when a later target fails its stale-write check", () => {
    const root = makeRoot("rollback-concurrent-edit");
    const firstSkill = installInboxSkill(root, ".claude", "old-first\n");
    const secondSkill = installInboxSkill(root, ".codex", "old-second\n");
    let writeCount = 0;

    const transaction = writeSkillContractsTransactional(
      [
        { path: firstSkill, content: "old-first\n", mode: 0o644 },
        { path: secondSkill, content: "old-second\n", mode: 0o644 },
      ],
      canonicalSkill,
      {
        lstat: (path) => {
          try {
            return lstatSync(path);
          } catch {
            return null;
          }
        },
        read: (path) => readFileSync(path, "utf8"),
        write: (path, content, mode) => {
          writeFileSync(path, content, { mode });
          writeCount += 1;
          if (writeCount === 1) {
            writeFileSync(firstSkill, "concurrent-first\n");
            writeFileSync(secondSkill, "concurrent-second\n");
          }
        },
      },
    );

    expect(transaction).toEqual({
      ok: false,
      error: "managed skill changed after inspection; refusing a stale write",
      rollback_conflicts: [
        `${firstSkill}: changed after this reconciliation wrote it`,
      ],
    });
    expect(readFileSync(firstSkill, "utf8")).toBe("concurrent-first\n");
    expect(readFileSync(secondSkill, "utf8")).toBe("concurrent-second\n");
  });

  test("restores an earlier still-owned write when a later target fails its stale-write check", () => {
    const root = makeRoot("rollback-owned-write");
    const firstSkill = installInboxSkill(root, ".claude", "old-first\n");
    const secondSkill = installInboxSkill(root, ".codex", "old-second\n");
    let writeCount = 0;

    const transaction = writeSkillContractsTransactional(
      [
        { path: firstSkill, content: "old-first\n", mode: 0o644 },
        { path: secondSkill, content: "old-second\n", mode: 0o644 },
      ],
      canonicalSkill,
      {
        lstat: (path) => {
          try {
            return lstatSync(path);
          } catch {
            return null;
          }
        },
        read: (path) => readFileSync(path, "utf8"),
        write: (path, content, mode) => {
          writeFileSync(path, content, { mode });
          writeCount += 1;
          if (writeCount === 1) {
            writeFileSync(secondSkill, "concurrent-second\n");
          }
        },
      },
    );

    expect(transaction).toEqual({
      ok: false,
      error: "managed skill changed after inspection; refusing a stale write",
      rollback_conflicts: [],
    });
    expect(readFileSync(firstSkill, "utf8")).toBe("old-first\n");
    expect(readFileSync(secondSkill, "utf8")).toBe("concurrent-second\n");
  });

  test("does not call heartbeat-only acceptance ready before channel and DM canaries", async () => {
    const root = makeRoot("delivery-required");
    const homeDir = join(root, "home");
    const skillPath = installInboxSkill(homeDir);
    const assetPath = writeCanonicalAsset(root);
    const conversationsCommand = writeConversationsRuntime(root);

    const result = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
      agent: "test-agent",
    });

    expect(result).toMatchObject({ changed: 1, failed: 0 });
    expect(result.runtimes[0]).toMatchObject({
      hosted_heartbeat: "passed",
      delivery_verified: false,
      manual_fallback_ready: true,
      healthy: false,
      reason: "hosted heartbeat passed; channel and DM delivery verification required",
    });
    expect(readFileSync(skillPath, "utf8")).toBe(canonicalSkill);
  });

  test("fails closed for an old or incomplete conversations watcher", async () => {
    const root = makeRoot("runtime-contract");
    const homeDir = join(root, "home");
    const skillPath = installInboxSkill(homeDir);
    const assetPath = writeCanonicalAsset(root);
    const conversationsCommand = writeConversationsRuntime(root, {
      version: "0.5.27",
      watchHelp: "--from <agent>\\n--full-content",
    });

    const result = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
    });

    expect(result).toMatchObject({ changed: 0, failed: 1 });
    expect(result.runtimes[0]).toMatchObject({
      action: "failed",
      runtime_version: "0.5.27",
      watch_supports_from: true,
      watch_supports_all: false,
      healthy: false,
    });
    expect(readFileSync(skillPath, "utf8")).toBe("stale inbox contract\n");
  });

  test("installs the manual fallback but stays degraded when hosted heartbeat fails", async () => {
    const root = makeRoot("hosted-degraded");
    const homeDir = join(root, "home");
    const skillPath = installInboxSkill(homeDir);
    const assetPath = writeCanonicalAsset(root);
    const conversationsCommand = writeConversationsRuntime(root, { heartbeatExit: 1 });

    const result = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
      agent: "test-agent",
    });

    expect(result).toMatchObject({ changed: 1, failed: 0 });
    expect(result.runtimes[0]).toMatchObject({
      action: "update",
      hosted_heartbeat: "failed",
      manual_fallback_ready: true,
      healthy: false,
      reason: "hosted heartbeat failed; manual fallback required",
    });
    expect(readFileSync(skillPath, "utf8")).toBe(canonicalSkill);
  });

  test("does not follow a symlinked managed skill target", async () => {
    const root = makeRoot("symlink");
    const homeDir = join(root, "home");
    const externalPath = join(root, "external-skill.md");
    writeFileSync(externalPath, "external content\n");
    const skillDir = join(homeDir, ".claude", "skills", "inbox");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(externalPath, join(skillDir, "SKILL.md"));
    const assetPath = writeCanonicalAsset(root);
    const conversationsCommand = writeConversationsRuntime(root);

    const result = await reconcileManagedSkillRuntimes({
      homeDir,
      assetPath,
      conversationsCommand,
    });

    expect(result).toMatchObject({ changed: 0, failed: 1 });
    expect(result.runtimes[0]).toMatchObject({
      action: "failed",
      reason: "managed skill target is not a regular file",
    });
    expect(readFileSync(externalPath, "utf8")).toBe("external content\n");
  });
});
