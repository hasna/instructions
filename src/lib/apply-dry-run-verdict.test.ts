// Regression cover for todos 43d0c1c0 defect 3: `apply <id> --dry-run` reported
// the PRIMARY target `(changed)` when that target was byte-identical on disk.
//
// Root cause: applyPreparedConfig OR-ed the outputs' verdicts into the primary
// result's own `changed` flag, and the CLI prints that flag on the line labelled
// with the primary's path. So a config with any drifted output reported every
// target as changed — and on this fleet the top-level rules config carries seven
// outputs, so the primary was effectively always mislabelled.
//
// `changed` stays the AGGREGATE (sync/profile counters and the MCP surface all
// consume it that way); `primary_changed` is this result's own verdict.
//
// Every test below carries BOTH directions: an identical pair must read
// unchanged AND a genuinely drifted pair must still read changed. A dry run that
// can only ever say one of the two is not a dry run.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LocalConfigStore } from "../data/config-store";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { previewConfigs } from "./apply";
import { tempRootPath } from "./test-temp-root";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = tempRootPath(`configs-dryrun-verdict-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("apply --dry-run reports the primary target's own verdict", () => {
  test("byte-identical primary reads UNCHANGED even when an output is drifted", async () => {
    const db = getDatabase();
    const primary = join(tmpDir, "a.md");
    const output = join(tmpDir, "out.md");
    writeFileSync(primary, "body\n");
    // `output` deliberately absent from disk: the output IS drifted.
    const config = createConfig(
      {
        name: "A",
        category: "tools",
        content: "body\n",
        target_path: primary,
        outputs: [{ agent: "codex", target_path: output, transform: "codex-flat" }],
      },
      db,
    );

    const report = await previewConfigs([config], { store: new LocalConfigStore(db) });
    const result = report.results[0]!;

    // The primary file on disk is byte-identical, so its own verdict is unchanged...
    expect(result.primary_changed).toBe(false);
    // ...while the aggregate still reports that this config has work to do.
    expect(result.changed).toBe(true);
    expect(result.outputs![0]!.primary_changed).toBe(true);
  });

  test("POSITIVE CONTROL — a genuinely drifted primary still reads CHANGED", async () => {
    const db = getDatabase();
    const primary = join(tmpDir, "a.md");
    writeFileSync(primary, "stale\n");
    const config = createConfig(
      { name: "A", category: "tools", content: "fresh\n", target_path: primary },
      db,
    );

    const report = await previewConfigs([config], { store: new LocalConfigStore(db) });

    expect(report.results[0]!.primary_changed).toBe(true);
    expect(report.results[0]!.changed).toBe(true);
  });

  test("POSITIVE CONTROL — a missing primary file reads CHANGED", async () => {
    const db = getDatabase();
    const config = createConfig(
      { name: "A", category: "tools", content: "fresh\n", target_path: join(tmpDir, "never-written.md") },
      db,
    );

    const report = await previewConfigs([config], { store: new LocalConfigStore(db) });

    expect(report.results[0]!.primary_changed).toBe(true);
  });

  test("everything identical reads unchanged on BOTH the primary and the aggregate", async () => {
    const db = getDatabase();
    const primary = join(tmpDir, "a.md");
    const output = join(tmpDir, "out.md");
    writeFileSync(primary, "body\n");
    const config = createConfig(
      {
        name: "A",
        category: "tools",
        content: "body\n",
        target_path: primary,
        outputs: [{ agent: "codex", target_path: output, transform: "codex-flat" }],
      },
      db,
    );
    // Write the output exactly as the transform would produce it, so nothing drifts.
    const seeded = await previewConfigs([config], { store: new LocalConfigStore(db) });
    writeFileSync(output, seeded.results[0]!.outputs![0]!.new_content);

    const report = await previewConfigs([config], { store: new LocalConfigStore(db) });
    const result = report.results[0]!;

    expect(result.primary_changed).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.outputs![0]!.primary_changed).toBe(false);
  });

  test("a dry run never writes — the drifted target is still stale afterwards", async () => {
    const db = getDatabase();
    const primary = join(tmpDir, "a.md");
    writeFileSync(primary, "stale\n");
    const config = createConfig(
      { name: "A", category: "tools", content: "fresh\n", target_path: primary },
      db,
    );

    await previewConfigs([config], { store: new LocalConfigStore(db) });

    expect(require("node:fs").readFileSync(primary, "utf-8")).toBe("stale\n");
  });
});
