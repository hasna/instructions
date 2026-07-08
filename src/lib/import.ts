import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExportManifest } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";

export type ImportConflict = "skip" | "overwrite" | "version";

export interface ImportOptions {
  conflict?: ImportConflict;
  store?: ConfigStore;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export async function importConfigs(
  bundlePath: string,
  opts: ImportOptions = {}
): Promise<ImportResult> {
  const store = opts.store ?? resolveConfigStore();
  const conflict = opts.conflict ?? "skip";
  const absPath = resolve(bundlePath);
  const tmpDir = join(tmpdir(), `configs-import-${Date.now()}`);
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    mkdirSync(tmpDir, { recursive: true });

    // Extract tar.gz
    const proc = Bun.spawn(["tar", "xzf", absPath, "-C", tmpDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar extraction failed: ${stderr}`);
    }

    // Read manifest
    const manifestPath = join(tmpDir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("Invalid bundle: missing manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExportManifest;

    // Import each config
    for (const meta of manifest.configs) {
      try {
        const ext = meta.format === "text" ? "txt" : meta.format;
        const contentFile = join(tmpDir, "contents", `${meta.slug}.${ext}`);
        const content = existsSync(contentFile) ? readFileSync(contentFile, "utf-8") : "";

        // Check if exists by slug
        let existing: Awaited<ReturnType<typeof store.getConfig>> | null = null;
        try { existing = await store.getConfig(meta.slug); } catch { /* not found */ }

        if (existing) {
          if (conflict === "skip") {
            result.skipped++;
          } else if (conflict === "overwrite" || conflict === "version") {
            await store.updateConfig(existing.id, { content, description: meta.description ?? undefined, tags: meta.tags, outputs: meta.outputs });
            result.updated++;
          }
        } else {
          await store.createConfig({
            name: meta.name,
            kind: meta.kind,
            category: meta.category,
            agent: meta.agent,
            target_path: meta.target_path ?? undefined,
            outputs: meta.outputs,
            format: meta.format,
            content,
            description: meta.description ?? undefined,
            tags: meta.tags,
            is_template: meta.is_template,
          });
          result.created++;
        }
      } catch (err) {
        result.errors.push(`${meta.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
