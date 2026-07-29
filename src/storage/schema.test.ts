import { describe, expect, test } from "bun:test";
import { instructionsSchemaSql } from "./schema";

describe("instructionsSchemaSql", () => {
  test("reconciles duplicate target paths before adding a unique index", () => {
    const sql = instructionsSchemaSql();
    const reconciliation = sql.find((statement) => statement.includes("configs_target_path_unique_idx"));

    expect(reconciliation).toBeDefined();
    expect(reconciliation).toContain("COUNT(*) FROM config_snapshots");
    expect(reconciliation).toContain("INSERT INTO profile_configs");
    expect(reconciliation).toContain("DELETE FROM configs");
    expect(reconciliation!.indexOf("DELETE FROM configs")).toBeLessThan(
      reconciliation!.indexOf("CREATE UNIQUE INDEX"),
    );
    expect(reconciliation).toContain("WHERE target_path IS NOT NULL");
  });
});
