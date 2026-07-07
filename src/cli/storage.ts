import type { Command } from "commander";
import {
  getStorageStatus,
  storagePull,
  storagePush,
  storageSync,
  type SyncResult,
} from "../db/storage-sync.js";
import { ensureLocalMode } from "./cloud-mode.js";

function parseTables(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((table) => table.trim()).filter(Boolean);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printResults(results: SyncResult[], label: string): void {
  const total = results.reduce((sum, result) => sum + result.rowsWritten, 0);
  for (const result of results) {
    const errors = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
    console.log(`  ${result.table}: ${result.rowsWritten}/${result.rowsRead} rows ${label}${errors}`);
  }
  console.log(`Done. ${total} rows ${label}.`);
}

export function registerStorageCommands(program: Command): void {
  const storageCmd = program.command("storage").description("Storage sync commands");

  storageCmd.command("status").description("Show storage config and local sync state").option("--json", "Output as JSON").action((opts: { json?: boolean }) => {
    try {
      ensureLocalMode("configs storage status");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const info = getStorageStatus();
    if (opts.json) { printJson(info); return; }
    console.log(`Storage configured: ${info.configured ? "yes" : "no"}`);
    console.log(`Tables: ${info.tables.join(", ")}`);
    if (info.sync.length === 0) console.log("Sync: no local sync history");
    for (const entry of info.sync) console.log(`  ${entry.table_name} ${entry.direction}: ${entry.last_synced_at ?? "never"}`);
  });

  storageCmd.command("push").description("Push local configs data to storage PostgreSQL").option("--tables <tables>", "Comma-separated table names").option("--json", "Output as JSON").action(async (opts: { tables?: string; json?: boolean }) => {
    try {
      ensureLocalMode("configs storage push");
      const results = await storagePush({ tables: parseTables(opts.tables) });
      if (opts.json) { printJson(results); return; }
      printResults(results, "pushed");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

  storageCmd.command("pull").description("Pull configs data from storage PostgreSQL to local SQLite").option("--tables <tables>", "Comma-separated table names").option("--json", "Output as JSON").action(async (opts: { tables?: string; json?: boolean }) => {
    try {
      ensureLocalMode("configs storage pull");
      const results = await storagePull({ tables: parseTables(opts.tables) });
      if (opts.json) { printJson(results); return; }
      printResults(results, "pulled");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

  storageCmd.command("sync").description("Bidirectional sync: pull then push").option("--tables <tables>", "Comma-separated table names").option("--json", "Output as JSON").action(async (opts: { tables?: string; json?: boolean }) => {
    try {
      ensureLocalMode("configs storage sync");
      const result = await storageSync({ tables: parseTables(opts.tables) });
      if (opts.json) { printJson(result); return; }
      printResults(result.pull, "pulled");
      printResults(result.push, "pushed");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
}
