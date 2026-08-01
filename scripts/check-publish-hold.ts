#!/usr/bin/env bun
/**
 * Refuse to publish while a release hold is in force.
 *
 * A hold that lives only in a channel post is advisory, and on 2026-08-01 an
 * advisory hold on this very package was defeated within three minutes by the
 * agent who wrote it — its own prose ran through a shell and executed the command
 * the warning named (incidents 620479). At that moment main carried two
 * independent credential-destroying defects, so any release cut for an unrelated
 * reason would have shipped both.
 *
 * So the hold is a COMMITTED FILE and lifting it is a COMMIT. Deliberately not an
 * env var and not a --force flag: both are things a person passes in a hurry, and
 * a guard you can wave past in one keystroke is the guard that is not there when
 * it matters. Deleting a tracked file is visible in a diff, attributable, and
 * reviewable — the properties a channel post lacks.
 *
 * WHAT THIS DOES NOT DO, stated so nobody trusts it further than it reaches:
 * `npm publish --ignore-scripts` skips lifecycle scripts entirely and therefore
 * skips this. Nothing expressible in package.json survives that flag. This raises
 * the cost of an ACCIDENTAL publish; it does not make a determined one
 * impossible, and it is not a substitute for branch protection or for a registry
 * -side control.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLISH_HOLD_FILE = "PUBLISH_HOLD";

export interface PublishHoldCheck {
  held: boolean;
  reason: string | null;
}

/** Read the hold state for a package root. Pure, so it is testable both ways. */
export function checkPublishHold(root: string): PublishHoldCheck {
  const marker = join(root, PUBLISH_HOLD_FILE);
  if (!existsSync(marker)) return { held: false, reason: null };
  const reason = readFileSync(marker, "utf-8").trim();
  return { held: true, reason: reason.length > 0 ? reason : null };
}

function main(): void {
  // The package root is this script's parent directory's parent (scripts/..).
  const root = join(import.meta.dir, "..");
  const { held, reason } = checkPublishHold(root);
  if (!held) return;

  console.error(
    [
      "",
      `PUBLISH REFUSED — a release hold is in force on this package.`,
      "",
      reason ?? `(${PUBLISH_HOLD_FILE} carries no reason; it should.)`,
      "",
      `To lift it: delete ${PUBLISH_HOLD_FILE} in a commit, with the reason it is`,
      `safe to publish stated in that commit. There is deliberately no flag and no`,
      `environment variable that skips this check.`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (import.meta.main) main();
