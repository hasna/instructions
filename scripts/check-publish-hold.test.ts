// Both directions, or this is not a check. A guard that always refuses and a
// guard that never refuses are equally worthless, and the second is the one that
// looks healthy.
//
// The third test is the one that matters most and is easy to omit: the guard must
// be WIRED. A correct checker that prepublishOnly never calls is a file, not a
// gate — which is the same "configured is not running" failure the hold itself
// exists to correct.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPublishHold, PUBLISH_HOLD_FILE } from "./check-publish-hold";
import { makeTempRoot } from "../src/lib/test-temp-root";

let root: string;

beforeEach(() => {
  root = makeTempRoot("publish-hold-");
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("publish hold", () => {
  test("HELD — a marker present refuses, and carries its reason through", () => {
    writeFileSync(join(root, PUBLISH_HOLD_FILE), "two credential-destroying defects on main\n");

    const result = checkPublishHold(root);

    expect(result.held).toBe(true);
    expect(result.reason).toBe("two credential-destroying defects on main");
  });

  test("POSITIVE CONTROL — no marker means no hold, so publishing is not permanently blocked", () => {
    const result = checkPublishHold(root);

    expect(result.held).toBe(false);
    expect(result.reason).toBeNull();
  });

  test("an empty marker still HOLDS — a truncated file must not read as 'lifted'", () => {
    writeFileSync(join(root, PUBLISH_HOLD_FILE), "   \n");

    const result = checkPublishHold(root);

    // Fail-closed on a malformed marker: the reason is missing, the hold is not.
    expect(result.held).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("nested directories do not leak a hold upward or downward", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, PUBLISH_HOLD_FILE), "held\n");

    expect(checkPublishHold(root).held).toBe(true);
    expect(checkPublishHold(join(root, "sub")).held).toBe(false);
  });

  test("WIRING — prepublishOnly actually invokes the check", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));

    // Asserted against the script's real path rather than a loose substring, so
    // renaming the file without rewiring fails here instead of silently passing.
    expect(pkg.scripts.prepublishOnly).toContain("scripts/check-publish-hold.ts");
    // And it must run BEFORE the build, so a held package does not spend a build
    // and then refuse.
    expect(pkg.scripts.prepublishOnly.indexOf("check-publish-hold")).toBeLessThan(
      pkg.scripts.prepublishOnly.indexOf("build"),
    );
  });

  test("the hold marker ships in the repo but NOT in the published tarball", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));

    // `files` is an allowlist; PUBLISH_HOLD must not be on it. A hold marker
    // inside a consumer's node_modules would be confusing and would do nothing.
    expect(pkg.files).not.toContain(PUBLISH_HOLD_FILE);
  });
});
