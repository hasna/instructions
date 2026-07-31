import type { Config } from "../types/index.js";
import { normalizeTargetPath } from "./apply.js";

/**
 * Every config row that already writes to `targetPath`.
 *
 * A target path is the config's identity on disk: two rows pointing at one file
 * means an apply races itself, last writer wins, and nothing reports the
 * conflict. Callers use this to refuse creating a second owner.
 *
 * Comparison is on the NORMALIZED path, not the stored string, because the same
 * file is spelled several ways across the store — `~/.claude/CLAUDE.md` from
 * `sync`, an absolute path from `add`, and either of those through a symlinked
 * ancestor. Matching on the raw string is what let a twin row in through a
 * different spelling of a path that was already owned.
 *
 * Reference configs (`kind: "reference"`) own no target path and never match.
 */
export function findConfigsByTargetPath(configs: Config[], targetPath: string): Config[] {
  const wanted = normalizeTargetPath(targetPath);
  return configs.filter((config) => {
    if (config.kind === "reference") return false;
    if (!config.target_path) return false;
    return normalizeTargetPath(config.target_path) === wanted;
  });
}

/**
 * Groups of rows that collide on one normalized target path. Only groups with
 * more than one member are returned, so an empty result means the store is
 * clean. Used by the store audit and by anything that needs to report existing
 * corruption rather than merely prevent new corruption.
 */
export function findDuplicateTargetPathGroups(configs: Config[]): Array<{ target_path: string; configs: Config[] }> {
  const groups = new Map<string, Config[]>();
  for (const config of configs) {
    if (config.kind === "reference" || !config.target_path) continue;
    const key = normalizeTargetPath(config.target_path);
    groups.set(key, [...(groups.get(key) ?? []), config]);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([target_path, rows]) => ({ target_path, configs: rows }));
}
