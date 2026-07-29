import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-only helper. It exists because `os.tmpdir()` on macOS returns a path under
// `/var/folders/...` and `/var` is a symlink to `/private/var`. The managed-file
// code rejects a workspace root with a symlinked ancestor — correctly, that is a
// guard against a swapped path — so every suite that rooted a workspace at the raw
// temp dir failed on macOS with PROJECT_CONTEXT_SYMLINK_REJECTED before reaching
// the behaviour it meant to test. That is why the suite had never been run on the
// platform holding 14 of the 16 fleet machines, and why a real defect there
// survived a month of green Linux runs.
//
// Canonicalizing is identity on Linux, so the two platforms exercise the same
// paths. Tests that mean to exercise symlink rejection still create their own
// symlink inside the returned root; canonicalizing the root does not weaken them.

/** An existing, symlink-free temp directory: the canonical form of os.tmpdir(). */
export function realTempDir(): string {
  return realpathSync(tmpdir());
}

/** A fresh, symlink-free temp directory, safe to use as a managed workspace root. */
export function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(realTempDir(), prefix)));
}

/** A symlink-free path under the temp dir for a caller that creates it itself. */
export function tempRootPath(name: string): string {
  return join(realTempDir(), name);
}
