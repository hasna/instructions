import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database";
import { createConfig } from "./configs";
import { createSnapshot, listSnapshots, getSnapshot, getSnapshotByVersion, pruneSnapshots } from "./snapshots";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

describe("snapshots", () => {
  test("creates and retrieves a snapshot", () => {
    const c = createConfig({ name: "Config", category: "rules", content: "v1" }, db);
    const snap = createSnapshot(c.id, "v1", 1, db);
    expect(snap.config_id).toBe(c.id);
    expect(snap.content).toBe("v1");
    expect(snap.version).toBe(1);
  });

  test("listSnapshots returns in version desc order", () => {
    const c = createConfig({ name: "C", category: "rules", content: "" }, db);
    createSnapshot(c.id, "v1", 1, db);
    createSnapshot(c.id, "v2", 2, db);
    const snaps = listSnapshots(c.id, db);
    expect(snaps[0]!.version).toBe(2);
    expect(snaps[1]!.version).toBe(1);
  });

  test("getSnapshot returns null for unknown id", () => {
    expect(getSnapshot("nope", db)).toBeNull();
  });

  test("getSnapshotByVersion returns correct snapshot", () => {
    const c = createConfig({ name: "C", category: "rules", content: "" }, db);
    createSnapshot(c.id, "v1", 1, db);
    createSnapshot(c.id, "v2", 2, db);
    const snap = getSnapshotByVersion(c.id, 1, db);
    expect(snap?.content).toBe("v1");
  });

  test("pruneSnapshots keeps only N most recent", () => {
    const c = createConfig({ name: "C", category: "rules", content: "" }, db);
    for (let i = 1; i <= 15; i++) createSnapshot(c.id, `v${i}`, i, db);
    pruneSnapshots(c.id, 10, db);
    expect(listSnapshots(c.id, db).length).toBe(10);
  });
});
