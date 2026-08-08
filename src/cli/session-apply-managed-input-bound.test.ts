import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOREIGN_INPUT_MAX_BYTES,
  SESSION_MANAGED_INPUT_MAX_BYTES,
  SESSION_MANAGED_OUTPUT_MAX_BYTES,
} from "../lib/project-context";
import { makeTempRoot } from "../lib/test-temp-root";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[]) {
  return spawnSync("bun", ["src/cli/index.tsx", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

function writeSource(path: string, bytes: number): void {
  writeFileSync(path, `${"x".repeat(bytes - 1)}\n`);
}

describe("session apply managed input bound", () => {
  test("accepts a valid managed source above the old 256 KiB foreign-input bound", () => {
    const root = makeTempRoot("instructions-session-apply-managed-input-");
    try {
      const sourcePath = join(root, "large-source.md");
      const targetHome = join(root, "target-home");
      const sourceBytes = FOREIGN_INPUT_MAX_BYTES + 16 * 1024;
      expect(sourceBytes).toBeGreaterThan(FOREIGN_INPUT_MAX_BYTES);
      expect(sourceBytes).toBeLessThan(SESSION_MANAGED_OUTPUT_MAX_BYTES);
      writeSource(sourcePath, sourceBytes);

      const first = runCli([
        "session", "apply",
        "--tool", "codex",
        "--profile", "managed-input-positive",
        "--target-home", targetHome,
        "--source", `global:large=${sourcePath}`,
        "--json",
      ]);
      expect(first.status).toBe(0);

      const agentsPath = join(targetHome, "AGENTS.md");
      expect(statSync(agentsPath).size).toBeGreaterThan(FOREIGN_INPUT_MAX_BYTES);

      const second = runCli([
        "session", "apply",
        "--tool", "codex",
        "--profile", "managed-input-positive",
        "--target-home", targetHome,
        "--source", `global:large=${sourcePath}`,
        "--json",
      ]);
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ applied: true, conflicts: [] });
      expect(readFileSync(agentsPath, "utf8")).toContain("large-source");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an oversized managed source before planning writes", () => {
    const root = makeTempRoot("instructions-session-apply-managed-input-");
    try {
      const sourcePath = join(root, "oversized-source.md");
      const targetHome = join(root, "target-home");
      writeSource(sourcePath, SESSION_MANAGED_INPUT_MAX_BYTES + 1024);

      const result = runCli([
        "session", "apply",
        "--tool", "codex",
        "--profile", "managed-input-negative",
        "--target-home", targetHome,
        "--source", `global:oversized=${sourcePath}`,
        "--json",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("SESSION_SOURCE_INPUT_TOO_LARGE");
      expect(result.stderr).toContain(`${SESSION_MANAGED_INPUT_MAX_BYTES}`);
      expect(existsSync(join(targetHome, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked managed source before reading it", () => {
    const root = makeTempRoot("instructions-session-apply-managed-input-");
    try {
      const realSource = join(root, "real-source.md");
      const symlinkSource = join(root, "symlink-source.md");
      const targetHome = join(root, "target-home");
      writeSource(realSource, 1024);
      symlinkSync(realSource, symlinkSource);

      const result = runCli([
        "session", "apply",
        "--tool", "codex",
        "--profile", "managed-input-symlink",
        "--target-home", targetHome,
        "--source", `global:symlink=${symlinkSource}`,
        "--json",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("SESSION_SOURCE_SYMLINK_REJECTED");
      expect(existsSync(join(targetHome, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
