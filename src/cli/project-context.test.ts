import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeProjectContextSourceHash, type ProjectContextBundleV1 } from "../lib/project-context";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], input?: string) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

function bundle(): ProjectContextBundleV1 {
  const value: ProjectContextBundleV1 = {
    schema: "hasna.projects.project_context_bundle.v1",
    generated_at: "2026-07-22T10:00:00.000Z",
    hash: "",
    revision: "rev-9",
    freshness: "fresh",
    resolution: { source: "marker", conflict: false, create_allowed: false },
    authority: { owner: "projects", mode: "api", storage: "cloud", availability: "available" },
    project: {
      id: "wks_cli",
      slug: "cli-context",
      name: "CLI Context",
      kind: "project",
      status: "active",
      path: "/safe/cli-context",
      updated_at: "2026-07-22T09:59:00.000Z",
    },
    links: {
      todos: { state: "linked", project_id: "todo-project", task_list_id: "todo-list" },
      conversations: { state: "linked", channel: "internal-cli-context" },
      mementos: { state: "linked", project_id: "memory-project", scope: "project" },
    },
    station: { station_id: "station01", machine_id: "machine01" },
    commands: [{ name: "show", argv: ["projects", "show", "wks_cli", "--json"] }],
  };
  value.hash = computeProjectContextSourceHash(value);
  return value;
}

describe("project-context CLI", () => {
  test("exposes plan/apply structured-input and stale-cache controls", () => {
    const help = runCli(["project-context", "apply", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--bundle <path|->");
    expect(help.stdout).toContain("--allow-stale-cache");
    expect(help.stdout).toContain("--expected-project-id");
    expect(help.stdout).toContain("--codewith-native-imports");
    expect(help.stdout).toContain("claude|codewith|agents|codex");
  });

  test("plans from a durable file without writing and applies through the codex alias", () => {
    const root = mkdtempSync(join(tmpdir(), "instructions-project-context-cli-"));
    try {
      const path = join(root, "bundle.json");
      writeFileSync(path, `${JSON.stringify(bundle())}\n`);
      const plan = runCli([
        "project-context", "plan",
        "--runtime", "codex",
        "--workspace-root", root,
        "--bundle", path,
        "--json",
      ]);
      expect(plan.status).toBe(0);
      const planned = JSON.parse(plan.stdout) as { ok: boolean; runtime: string; project_id: string };
      expect(planned).toMatchObject({ ok: true, runtime: "agents", project_id: "wks_cli" });
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(root, ".hasna"))).toBe(false);

      const dryRun = runCli([
        "project-context", "apply",
        "--runtime", "codex",
        "--workspace-root", root,
        "--bundle", path,
        "--dry-run",
        "--json",
      ]);
      expect(dryRun.status).toBe(0);
      expect((JSON.parse(dryRun.stdout) as { applied: boolean; dry_run: boolean })).toMatchObject({ applied: false, dry_run: true });
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(root, ".hasna"))).toBe(false);

      const apply = runCli([
        "project-context", "apply",
        "--runtime", "codex",
        "--workspace-root", root,
        "--bundle", path,
        "--json",
      ]);
      expect(apply.status).toBe(0);
      expect((JSON.parse(apply.stdout) as { ok: boolean; applied: boolean })).toMatchObject({ ok: true, applied: true });
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("CLI Context");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts stdin but records only durable cache provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "instructions-project-context-cli-"));
    try {
      const result = runCli([
        "project-context", "apply",
        "--runtime", "codewith",
        "--workspace-root", root,
        "--bundle", "-",
        "--json",
      ], `${JSON.stringify(bundle())}\n`);
      expect(result.status).toBe(0);
      const manifest = readFileSync(join(root, ".hasna", "project-context-manifest.json"), "utf8");
      expect(manifest).toContain("project-context-cache.json");
      expect(manifest).not.toContain("/dev/fd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses explicit stale cache fallback when a requested bundle file is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "instructions-project-context-cli-"));
    try {
      const seed = runCli([
        "project-context", "apply",
        "--runtime", "agents",
        "--workspace-root", root,
        "--bundle", "-",
        "--json",
      ], `${JSON.stringify(bundle())}\n`);
      expect(seed.status).toBe(0);

      const fallback = runCli([
        "project-context", "apply",
        "--runtime", "agents",
        "--workspace-root", root,
        "--bundle", join(root, "producer-did-not-create.json"),
        "--allow-stale-cache",
        "--expected-project-id", "wks_cli",
        "--max-stale-age-seconds", "604800",
        "--json",
      ]);
      expect(fallback.status).toBe(0);
      expect((JSON.parse(fallback.stdout) as { status: string }).status).toBe("stale-cache");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns a stable JSON error for strict-contract violations", () => {
    const root = mkdtempSync(join(tmpdir(), "instructions-project-context-cli-"));
    try {
      const invalid = { ...bundle(), arbitrary: true };
      const result = runCli([
        "project-context", "apply",
        "--runtime", "claude",
        "--workspace-root", root,
        "--bundle", "-",
        "--json",
      ], JSON.stringify(invalid));
      expect(result.status).toBe(1);
      const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
      expect(body).toEqual({
        ok: false,
        error: {
          code: "PROJECT_CONTEXT_INVALID",
          message: expect.stringContaining("PROJECT_CONTEXT_INVALID"),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects oversized file and stdin input before parsing", () => {
    const root = mkdtempSync(join(tmpdir(), "instructions-project-context-cli-"));
    try {
      const oversized = "x".repeat((8 * 1024) + 1);
      const path = join(root, "oversized.json");
      writeFileSync(path, oversized);
      for (const [source, input] of [[path, undefined], ["-", oversized]] as const) {
        const result = runCli([
          "project-context", "plan",
          "--runtime", "claude",
          "--workspace-root", root,
          "--bundle", source,
          "--json",
        ], input);
        expect(result.status).toBe(1);
        expect((JSON.parse(result.stdout) as { error: { code: string } }).error.code).toBe("PROJECT_CONTEXT_INPUT_TOO_LARGE");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
