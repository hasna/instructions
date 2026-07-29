// Regression cover for the macOS staging-file defect (todos cd0f08af).
//
// `instructions session apply` could not write a single file on arm64 macOS.
// The staging file was created through an FFI declaration of openat(2) that
// passed the variadic `mode` argument as a fixed fourth argument. That matches
// the Linux integer calling convention and does not match arm64 macOS, where
// variadic arguments travel on the stack, so the kernel read an uninitialised
// slot: a 0o644 request produced 0o140 in one measurement and 0o000 in another,
// never a mode its own creator could read back. Every readback of the staged file
// failed, and the null readback compared unequal to the expected digest, which the
// renderer reported as `prepared bytes changed before installation` — a hash race
// that never happened.
//
// PLATFORM COVERAGE — read this before trusting a green run:
//   * The mode assertions below run the real, unsimulated write path. On arm64
//     macOS they fail before the fix and pass after it. On Linux they cannot
//     fail either way; there they are the control that proves the assertion is
//     satisfiable and that the anchored path is the one being measured.
//   * The unreadable-staged-file assertions DO discriminate on Linux: before the
//     fix they produce the wrong message, after it the right one.
//   * `isPreparedManagedFileModeUsable` is checked directly against the mode
//     measured on station03, so the guard has a positive control on every
//     platform rather than only on the one that can produce the defect.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectContextError,
  isPreparedManagedFileModeUsable,
  projectContextFileOpsDiagnostics,
  writeProjectContextCoordinatedFile,
} from "./project-context";
import { makeTempRoot } from "./test-temp-root";

// The modes arm64 macOS actually produced for a 0o644 request, measured on
// station03 on 2026-07-29, each with a Linux control that returned 0o644 from the
// identical call. Two different values from the same request is the point: the
// kernel is reading an uninitialised stack slot, so no single value can be
// asserted against and the guard has to reject the shape rather than a constant.
const DARWIN_MANGLED_MODES = [0o140, 0o000];

const MANAGED_MODE = 0o644;

let tmpRoot = "";
let previousUmask = 0;

beforeEach(() => {
  tmpRoot = makeTempRoot("instructions-prepared-file-");
  // Pin the umask so `0o644` is an exact expectation rather than a machine
  // property. Without this the suite passes or fails depending on the developer's
  // shell, which is the sort of environment coupling that hid this defect.
  previousUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(previousUmask);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectContextError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
  return "<no error thrown>";
}

function errorMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "<no error thrown>";
}

describe("prepared managed file staging", () => {
  test("the directory-anchored path is the one under test on this platform", () => {
    const diagnostics = projectContextFileOpsDiagnostics();
    // Guard against a silent degrade: if anchored ops stopped resolving, every
    // "anchored" case below would quietly measure the portable fallback and the
    // suite would stay green while the repaired code path went unexercised.
    expect(diagnostics.anchored_file_ops).toBe(true);
    expect(["linux", "darwin"]).toContain(diagnostics.platform);
  });

  for (const forcePortableFileOps of [false, true]) {
    const label = forcePortableFileOps ? "portable" : "anchored";

    test(`creates a managed file with the requested 0o644 mode (${label} path)`, () => {
      const target = join(tmpRoot, `${label}-create.md`);
      const content = "managed-create\n";
      const staged: { mode: number | null } = { mode: null };

      writeProjectContextCoordinatedFile({
        path: target,
        content,
        workspace_root: tmpRoot,
        expected_hash: null,
        force_portable_file_ops: forcePortableFileOps,
        test_hooks: {
          // The staged file is where the defect lands. Asserting only the
          // installed file would pass on a platform that staged an unreadable
          // file and then failed the install, so pin the mode at staging time.
          before_install: (tempPath) => {
            staged.mode = statSync(tempPath).mode & 0o7777;
          },
        },
      });

      expect(staged.mode).toBe(MANAGED_MODE);
      expect(statSync(target).mode & 0o7777).toBe(MANAGED_MODE);
      expect(readFileSync(target, "utf8")).toBe(content);
    });

    test(`replaces a managed file and keeps the 0o644 mode (${label} path)`, () => {
      const target = join(tmpRoot, `${label}-replace.md`);
      const original = "managed-before\n";
      const next = "managed-after\n";
      writeFileSync(target, original, { mode: MANAGED_MODE });
      chmodSync(target, MANAGED_MODE);
      const staged: { mode: number | null } = { mode: null };

      writeProjectContextCoordinatedFile({
        path: target,
        content: next,
        workspace_root: tmpRoot,
        expected_hash: sha256(original),
        allow_portable_replacement: forcePortableFileOps,
        force_portable_file_ops: forcePortableFileOps,
        test_hooks: {
          before_install: (tempPath) => {
            staged.mode = statSync(tempPath).mode & 0o7777;
          },
        },
      });

      expect(staged.mode).toBe(MANAGED_MODE);
      expect(statSync(target).mode & 0o7777).toBe(MANAGED_MODE);
      expect(readFileSync(target, "utf8")).toBe(next);
    });
  }

  test("rejects a staging mode the platform mangled, and accepts every umask-shaped one", () => {
    // Positive control: every mode measured on arm64 macOS must be rejected.
    for (const mangled of DARWIN_MANGLED_MODES) {
      expect(isPreparedManagedFileModeUsable(MANAGED_MODE, mangled)).toBe(false);
    }
    // A widened mode is a security problem, not merely an unreadable one.
    expect(isPreparedManagedFileModeUsable(MANAGED_MODE, 0o777)).toBe(false);
    expect(isPreparedManagedFileModeUsable(MANAGED_MODE, 0o646)).toBe(false);
    // Owner read is what the readback needs; losing it is the failure signature.
    expect(isPreparedManagedFileModeUsable(MANAGED_MODE, 0o244)).toBe(false);
    // Negative control: a umask may clear bits, and clearing bits is not a defect.
    expect(isPreparedManagedFileModeUsable(MANAGED_MODE, 0o644)).toBe(true); // umask 0o022
    expect(isPreparedManagedFileModeUsable(MANAGED_MODE, 0o640)).toBe(true); // umask 0o027
    expect(isPreparedManagedFileModeUsable(MANAGED_MODE, 0o600)).toBe(true); // umask 0o077
  });

  test("an unreadable staged file is reported as unreadable, not as a hash race", () => {
    // Reading a mode-0 file succeeds for root, which would turn this into a false
    // pass. Fail loudly rather than skip silently.
    expect(typeof process.getuid === "function" ? process.getuid() : 1).not.toBe(0);

    for (const forcePortableFileOps of [false, true]) {
      const target = join(tmpRoot, `${forcePortableFileOps ? "portable" : "anchored"}-unreadable.md`);
      const message = errorMessage(() => writeProjectContextCoordinatedFile({
        path: target,
        content: "managed-unreadable\n",
        workspace_root: tmpRoot,
        expected_hash: null,
        force_portable_file_ops: forcePortableFileOps,
        test_hooks: {
          // Reproduce the *effect* of the macOS defect — a staged file its own
          // creator cannot read back — without depending on the ABI that causes
          // it, so the distinction is exercised on Linux too.
          before_install: (tempPath) => chmodSync(tempPath, 0o000),
        },
      }));

      expect(message).toContain("could not be read back");
      // The message this defect wore for a month. It must not come back for a
      // condition that is not a concurrent write.
      expect(message).not.toContain("prepared bytes changed");
    }
  });

  test("the unreadable staged file carries its own error code and is not retried as a race", () => {
    expect(typeof process.getuid === "function" ? process.getuid() : 1).not.toBe(0);
    expect(errorCode(() => writeProjectContextCoordinatedFile({
      path: join(tmpRoot, "anchored-unreadable-code.md"),
      content: "managed-unreadable-code\n",
      workspace_root: tmpRoot,
      expected_hash: null,
      test_hooks: {
        before_install: (tempPath) => chmodSync(tempPath, 0o000),
      },
    }))).toBe("PROJECT_CONTEXT_PREPARED_FILE_UNREADABLE");
  });

  test("a staged file that really was rewritten is still reported as changed bytes", () => {
    // Discriminating control for the test above: if the new error simply replaced
    // the old one, this case would also report "could not be read back" and the
    // renamed message would be no more truthful than the one it replaced.
    for (const forcePortableFileOps of [false, true]) {
      const target = join(tmpRoot, `${forcePortableFileOps ? "portable" : "anchored"}-tampered.md`);
      const message = errorMessage(() => writeProjectContextCoordinatedFile({
        path: target,
        content: "managed-tampered\n",
        workspace_root: tmpRoot,
        expected_hash: null,
        force_portable_file_ops: forcePortableFileOps,
        test_hooks: {
          before_install: (tempPath) => writeFileSync(tempPath, "someone-else-wrote-this\n"),
        },
      }));

      expect(message).toContain("changed before");
      expect(message).not.toContain("could not be read back");
    }
  });
});
