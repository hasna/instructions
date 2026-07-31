// Cover for todos 43d0c1c0 defect 2 — `sync --dry-run` reporting
// `updated:N unchanged:0`, i.e. structurally unable to say "nothing to do".
//
// MEASURED 2026-07-31 against the 0.4.12 bytes: the defect as stated does NOT
// reproduce. `syncKnown({ dryRun: true })` does report `unchanged`, it converges
// after one real pass, and the live fleet store reports `unchanged:6` today. So
// there is no fix here — these tests exist to PIN the behaviour, because the
// claim was credible enough to act on and the next reader deserves a check
// rather than a paragraph.
//
// Both directions in every test: identical must read unchanged, drifted must
// still read updated.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LocalConfigStore } from "../data/config-store";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { syncKnown } from "./sync";
import { makeTempRoot } from "./test-temp-root";

let home: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  home = makeTempRoot("configs-sync-unchanged-");
  process.env["CONFIGS_HOME"] = home;
  mkdirSync(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("sync --dry-run can say 'nothing to do'", () => {
  test("an untouched store reports unchanged, not updated", async () => {
    const store = new LocalConfigStore(getDatabase());
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# rules\nhello\n");

    const first = await syncKnown({ store });
    expect(first.added).toBe(1);

    const preview = await syncKnown({ store, dryRun: true });

    expect(preview.unchanged).toBe(1);
    expect(preview.updated).toBe(0);
    expect(preview.added).toBe(0);
  });

  test("POSITIVE CONTROL — a drifted file still reports updated", async () => {
    const store = new LocalConfigStore(getDatabase());
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# rules\nhello\n");
    await syncKnown({ store });

    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# rules\nDRIFTED\n");
    const preview = await syncKnown({ store, dryRun: true });

    expect(preview.updated).toBe(1);
    expect(preview.unchanged).toBe(0);
  });

  test("converges — a second real pass is a no-op, so counts are not self-inflating", async () => {
    const store = new LocalConfigStore(getDatabase());
    // Content holding a machine-specific literal, which sync templateizes on the
    // way in. If templateizing were not idempotent every pass would re-report
    // 'updated' forever, which is exactly the shape defect 2 described.
    writeFileSync(join(home, ".claude", "CLAUDE.md"), `# rules\nworkspace at ${home}/work\n`);

    await syncKnown({ store });
    const second = await syncKnown({ store });
    const third = await syncKnown({ store });

    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(third.unchanged).toBe(1);
  });

  test("a dry run never writes — the store does not gain the row it previewed", async () => {
    const store = new LocalConfigStore(getDatabase());
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# rules\nhello\n");

    const preview = await syncKnown({ store, dryRun: true });

    expect(preview.added).toBe(1);
    expect((await store.listConfigs()).length).toBe(0);
  });
});
