import type { Config } from "../types/index.js";
import { normalizeTargetPath } from "./apply.js";
import { slugify } from "../db/database.js";

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
 * Every reference-kind row already ingested under `name`.
 *
 * A reference config (`kind: "reference"`) owns no target_path — it is not
 * mirrored 1:1 onto one file on disk, so `findConfigsByTargetPath` can never
 * find it, by design (see that function's own doc comment). That left
 * `add <path> --kind reference --update` with no identity signal at all: every
 * re-ingest of a reference config's content minted a fresh row instead of
 * updating the one that already existed, at every `--update` setting, because
 * there was nothing to match on. Measured live 2026-08-04, todos 757cefdb: 20
 * of 20 reference-kind rows in the fleet store had target_path=null.
 *
 * For a reference config, `name` IS the identity, in exactly the same sense a
 * file-kind config's target_path is its identity: re-ingest with the same
 * name, get the same row; re-ingest with a different name, get a different
 * (or new) row. Two comparisons, both needed:
 *
 *  - EXACT name match. `uniqueSlug` (db/database.ts) only de-duplicates the
 *    SLUG column, which carries a DB-level UNIQUE constraint — it never
 *    touches `name`, which carries no such constraint. So every prior
 *    duplicate this bug already produced still has the identical `name` and a
 *    `-1`, `-2`, ... suffixed slug. Measured live 2026-08-04 in the fleet
 *    store: 8 reference rows all named "Global Agent Rules Standard"
 *    (`global-agent-rules-standard-1` through `-8`), one identical SHA-256
 *    content hash across all 8, ingested on 6 different days — the exact
 *    shape this function exists to stop.
 *  - Slugified match, for a re-ingest whose `--name` differs only in case or
 *    punctuation from an existing row's name.
 *
 *    CORRECTED 2026-08-04 (todos 195272ae, Finding 1): this used to compare
 *    the query's slug against each candidate's STORED `.slug` COLUMN
 *    (`config.slug === wantedSlug`). That is sound only for a candidate whose
 *    own slug was never disambiguated — the moment two rows already collide
 *    and `uniqueSlug` has suffixed one of them (`sample-rule-1`), its stored
 *    slug no longer equals what re-slugifying its OWN name produces, so the
 *    old comparison went blind to it. Reproduced live: row A "Sample Rule"
 *    (slug "sample-rule"), row B "sample rule" (slug disambiguated to
 *    "sample-rule-1" because A already held the base slug) — querying "Sample
 *    Rule" found only A. `add --update` then updated A, reported
 *    `rest.length === 0` (no "N other rows share this name" warning), and
 *    left B — the exact row a human would call a duplicate of A — untouched
 *    and unmentioned. This is the one population the slug clause exists to
 *    catch: it is impossible for a fresh, non-colliding row to need it, since
 *    an un-disambiguated slug already matches via `slugify(name)` trivially.
 *    Comparing against `slugify(config.name)` instead — recomputed from the
 *    candidate's own name rather than trusted from its (possibly
 *    disambiguated) stored column — fixes this without weakening the EXACT
 *    name clause above, which still independently catches the byte-identical
 *    case regardless: it can only ADD matches the old comparison missed, not
 *    remove any a query's name literally shares.
 */
export function findReferenceConfigsByName(configs: Config[], name: string): Config[] {
  const wantedSlug = slugify(name);
  return configs.filter(
    (config) => config.kind === "reference" && (config.name === name || slugify(config.name) === wantedSlug)
  );
}

/**
 * Groups of reference-kind rows that collide on identity, the mirror image of
 * `findDuplicateTargetPathGroups` for the identity axis reference configs
 * actually use. Only groups with more than one member are returned, so an
 * empty result means the store is clean.
 *
 * CORRECTED 2026-08-04 (todos 195272ae, Finding 1): grouping used to key on
 * the raw, exact `config.name` string. `doctor` (which calls this) therefore
 * reported a store CLEAN for two rows whose names differ only in case or
 * punctuation — precisely the pair `findReferenceConfigsByName` above treats
 * as one identity (see its doc comment for the reproduction). The two
 * functions disagreeing about what "the same reference config" means was the
 * same defect class PR #57 fixed one level up, one file down: `doctor` a
 * store clean, `add --update` half-fixing it. Keying on `slugify(config.name)`
 * instead makes this agree with `findReferenceConfigsByName`'s identity
 * notion — a case/punctuation variant is now reported as a duplicate group
 * too, not only a byte-identical one. The reported `name` is the first
 * colliding row's own (human-authored) name, for display — the grouping key
 * itself is never surfaced.
 */
export function findDuplicateReferenceNameGroups(configs: Config[]): Array<{ name: string; configs: Config[] }> {
  const groups = new Map<string, Config[]>();
  for (const config of configs) {
    if (config.kind !== "reference") continue;
    const key = slugify(config.name);
    groups.set(key, [...(groups.get(key) ?? []), config]);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([, rows]) => ({ name: rows[0]!.name, configs: rows }));
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
