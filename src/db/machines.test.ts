import { describe, test, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database";
import { registerMachine, listMachines, updateMachineApplied } from "./machines";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

describe("machines", () => {
  test("registers a machine", () => {
    const m = registerMachine("myhost", "Darwin", "arm64", db);
    expect(m.hostname).toBe("myhost");
    expect(m.os).toBe("Darwin");
    expect(m.arch).toBe("arm64");
    expect(m.last_applied_at).toBeNull();
  });

  test("is idempotent — same hostname returns same machine", () => {
    const m1 = registerMachine("myhost", "Darwin", "arm64", db);
    const m2 = registerMachine("myhost", "Darwin", "arm64", db);
    expect(m1.id).toBe(m2.id);
  });

  test("listMachines returns all", () => {
    registerMachine("host1", "Darwin", "arm64", db);
    registerMachine("host2", "Linux", "arm64", db);
    expect(listMachines(db).length).toBe(2);
  });

  test("updateMachineApplied sets last_applied_at", () => {
    registerMachine("myhost", "Darwin", "arm64", db);
    updateMachineApplied("myhost", db);
    const machines = listMachines(db);
    expect(machines[0]!.last_applied_at).not.toBeNull();
  });

  test("registerMachine updates os/arch for an existing hostname", () => {
    registerMachine("myhost", "Linux", "x64", db);
    const updated = registerMachine("myhost", "Darwin", "arm64", db);
    expect(updated.os).toBe("Darwin");
    expect(updated.arch).toBe("arm64");
  });
});
