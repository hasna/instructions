import { describe, expect, test } from "bun:test";
import type { TypedQueryClient } from "../generated/storage-kit/index.js";
import { updateConfig } from "./cloud-store.js";

describe("cloud config snapshots", () => {
  test("snapshots the previous content before updating a config", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const reads: string[] = [];
    const snapshots = new Map<string, Record<string, unknown>>();
    let transactionRuns = 0;
    let config = {
      id: "config-1",
      name: "Config",
      slug: "config",
      kind: "file",
      category: "rules",
      agent: "claude",
      target_path: null,
      outputs: [],
      format: "markdown",
      content: "v1",
      description: null,
      tags: [],
      is_template: false,
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      synced_at: null,
    };

    const transactionClient = {
      async get(sql: string, params: readonly unknown[] = []) {
        reads.push(sql);
        if (sql.includes("FROM configs WHERE id = $1 OR slug = $1")) return config;
        if (sql.includes("FROM config_snapshots WHERE id = $1")) {
          return snapshots.get(String(params[0])) ?? null;
        }
        return null;
      },
      async execute(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO config_snapshots")) {
          snapshots.set(String(params[0]), {
            id: params[0],
            config_id: params[1],
            content: params[2],
            version: params[3],
            created_at: "2026-01-02T00:00:00.000Z",
          });
        }
        if (sql.startsWith("UPDATE configs SET")) {
          config = {
            ...config,
            content: String(params[0]),
            version: config.version + 1,
            updated_at: "2026-01-02T00:00:00.000Z",
          };
        }
      },
    } as unknown as TypedQueryClient;
    const client = {
      ...transactionClient,
      async transaction<T>(fn: (transactionClient: TypedQueryClient) => Promise<T>) {
        transactionRuns++;
        return fn(transactionClient);
      },
    } as unknown as TypedQueryClient;

    const updated = await updateConfig(client, config.id, { content: "v2" });

    expect(updated.content).toBe("v2");
    expect(updated.version).toBe(2);
    expect(transactionRuns).toBe(1);
    expect(reads[0]).toContain("FOR UPDATE");
    expect([...snapshots.values()]).toEqual([
      expect.objectContaining({
        config_id: "config-1",
        content: "v1",
        version: 1,
      }),
    ]);
    expect(calls.findIndex(({ sql }) => sql.includes("INSERT INTO config_snapshots")))
      .toBeLessThan(calls.findIndex(({ sql }) => sql.startsWith("UPDATE configs SET")));
  });
});
