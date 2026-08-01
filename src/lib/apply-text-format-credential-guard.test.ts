// Regression cover for todos e4d9c22e and f303dc2c — the last credential-
// destruction route left open after #39 and #40, plus the undefended branch
// beside it.
//
// THE GAP #40 LEFT. `wouldDestroyACredential` asks `scanSecrets(current, format)`
// where `format` is the config's DECLARED `ConfigFormat`. That union is
// `text | json | toml | yaml | markdown | ini` (types/index.ts) and has NO
// `shell` member, while `RedactFormat` (redact.ts) does. So the declared format
// can never select `redactShell`, and `redactShell` is the only dialect that
// matches on KEY NAME for shell assignments.
//
// `detectFormat` returns `text` for any extensionless path — `extname(".zshrc")`
// is `""` — so the three files most likely to hold a literal credential
// (`~/.zshrc`, `~/.bashrc`, `~/.npmrc`) all arrive declared `text`, and `text`
// routes to `redactGeneric`, which matches only known token SHAPES
// (`npm_[A-Za-z0-9]{36,}` and friends) and never key names.
//
// A credential whose KEY is secret-class but whose VALUE has no recognisable
// shape is therefore invisible to the scan branch on exactly those files. Pair
// that with a RELOCATION — total placeholder count conserved, placeholder moved
// onto the live slot — and the count backstop does not fire either. Both arms
// miss, and the write proceeds at rc=0 printing `✓ (changed)`.
//
// This is NOT a regression from #40: it destroys on 0.4.14 too. #40 closed the
// `toml`/`json`/`ini` instances of the same shape and stopped at the format
// boundary.
//
// THE FIX reuses the seam the repo already ships: `redactFormatForTarget`
// (sync.ts) resolves the dialect from the TARGET PATH rather than inheriting the
// declared format. It is path-keyed rather than a widening of the union, so
// `.md` still resolves to `markdown` and the prose controls below still pass.
//
// Every test here asserts the SURVIVING BYTES on disk, never an exit code and
// never an error string — the entire defect is that the destroying path exits 0
// and reports success, so an assertion on status cannot see it.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LocalConfigStore } from "../data/config-store";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { applyConfigsWithReport } from "./apply";
import { scanSecrets } from "./redact";
import { detectFormat } from "./sync";
import { makeTempRoot } from "./test-temp-root";

let tmpDir: string;
let previousApiUrl: string | undefined;
let previousApiKey: string | undefined;

// Synthetic and never a credential. Deliberately DETECTOR-BLIND under the
// generic redactor: it carries none of the vendor token prefixes or shapes in
// redact.ts's VALUE_PATTERNS list. Its only secret signal is the KEY it is
// assigned to, which is precisely the signal `text` throws away. It is long
// enough to clear MIN_SECRET_VALUE_LEN so that the shell dialect genuinely
// would catch it — that asymmetry IS the defect.
//
// The prefixes themselves are deliberately NOT spelled out here: the mandated
// staged secrets scan matches on value prefixes and fires on any source line
// that lists them, including a comment explaining that a fixture avoids them.
const BLIND_VALUE = "Zq7-relocation-e4d9c22e-live-value-not-a-real-credential";

beforeEach(() => {
  // The hosted-store env selects the SHARED FLEET STORE even with a DB path set
  // (defect b19d3d37). Stripped so isolation is a property of the suite rather
  // than of how it happened to be invoked.
  previousApiUrl = process.env["HASNA_INSTRUCTIONS_API_URL"];
  previousApiKey = process.env["HASNA_INSTRUCTIONS_API_KEY"];
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = makeTempRoot("apply-text-format-guard-");
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
  if (previousApiUrl === undefined) delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  else process.env["HASNA_INSTRUCTIONS_API_URL"] = previousApiUrl;
  if (previousApiKey === undefined) delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  else process.env["HASNA_INSTRUCTIONS_API_KEY"] = previousApiKey;
});

/** Injected everywhere, so `resolveConfigStore()` is never reached and the shared
 *  fleet store cannot be touched however the environment is configured. */
function store() {
  return new LocalConfigStore(getDatabase());
}

// ── The premises the tests below rest on ─────────────────────────────────────
// Asserted rather than assumed, because if any of them silently stopped holding
// the tests would keep passing while no longer exercising the defect — the
// vacuous-coverage shape these tests exist to prevent.
describe("premises — the fixture really is on the blind side of the format boundary", () => {
  test("detectFormat declares the shell dotfiles `text`", () => {
    expect(detectFormat("/home/x/.zshrc")).toBe("text");
    expect(detectFormat("/home/x/.bashrc")).toBe("text");
    expect(detectFormat("/home/x/.npmrc")).toBe("text");
  });

  test("the fixture value is invisible to `text` and visible to `shell` — the asymmetry IS the bug", () => {
    const line = `export NPM_TOKEN="${BLIND_VALUE}"\n`;
    // Declared format on a dotfile: sees nothing.
    expect(scanSecrets(line, "text")).toHaveLength(0);
    // Path-resolved dialect: sees it, by key name.
    expect(scanSecrets(line, "shell").length).toBeGreaterThan(0);
  });

  test("the same asymmetry holds for the ini dialect and ~/.npmrc", () => {
    // The REAL ~/.npmrc line shape. A bare `_authToken=` is matched by neither
    // ini branch — the registry branch needs the `//host/:` prefix and the
    // generic `key=value` branch requires the key to START with a letter, which
    // `_authToken` does not. That is a separate detector gap, filed rather than
    // widened here; this fixture uses the form that actually ships.
    const line = `//registry.npmjs.org/:_authToken=${BLIND_VALUE}\n`;
    expect(scanSecrets(line, "text")).toHaveLength(0);
    expect(scanSecrets(line, "ini").length).toBeGreaterThan(0);
  });
});

describe("e4d9c22e — a `text`-declared shell target never loses its credential", () => {
  test("RELOCATION on ~/.zshrc: count conserved, both arms blind, value must survive", async () => {
    const db = getDatabase();
    const target = join(tmpDir, ".zshrc");
    // Disk: the placeholder sits in PROSE, the live value sits in the slot.
    writeFileSync(target, `# rotate {{NPM_TOKEN}} quarterly\nexport NPM_TOKEN="${BLIND_VALUE}"\n`);

    const config = createConfig(
      {
        name: "zshrc-like",
        category: "tools",
        // What `detectFormat` actually produces for this path. Declaring it here
        // is the defect, not a contrivance of the test.
        format: "text",
        // Write: prose drops the token, the slot gains it. Total 1 -> 1, so the
        // count backstop cannot fire; `text` blinds the scan; nothing refuses.
        content: `# rotate it quarterly\nexport NPM_TOKEN="{{NPM_TOKEN}}"\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(BLIND_VALUE);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
  });

  test("RELOCATION on ~/.npmrc: the ini dialect is reached from the path too", async () => {
    const db = getDatabase();
    const target = join(tmpDir, ".npmrc");
    writeFileSync(target, `; keep {{NPM_TOKEN}} out of git\n//registry.npmjs.org/:_authToken=${BLIND_VALUE}\n`);

    const config = createConfig(
      {
        name: "npmrc-like",
        category: "tools",
        format: "text",
        content: `; keep it out of git\n//registry.npmjs.org/:_authToken={{NPM_TOKEN}}\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(BLIND_VALUE);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
  });

  test("~/.bashrc is covered by the same path resolution", async () => {
    const db = getDatabase();
    const target = join(tmpDir, ".bashrc");
    writeFileSync(target, `# {{ANTHROPIC_API_KEY}} lives in the vault\nexport ANTHROPIC_API_KEY="${BLIND_VALUE}"\n`);

    const config = createConfig(
      {
        name: "bashrc-like",
        category: "tools",
        format: "text",
        content: `# it lives in the vault\nexport ANTHROPIC_API_KEY="{{ANTHROPIC_API_KEY}}"\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(BLIND_VALUE);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
  });
});

describe("f303dc2c — the {{NAME:default}} branch of countPlaceholder, defended", () => {
  // The branch is REAL protection that no test would notice the loss of:
  // reverting `countPlaceholder` to a plain exact-string count passes every
  // other test in the suite. `#40`'s BYPASS-2 fixture cannot defend it, because
  // that target is a TOML `authorization` key which `scanSecrets` catches by key
  // name — the scan arm closes it first and the count arm never runs.
  //
  // Defending it therefore needs a target the DETECTOR CANNOT SEE, so the scan
  // arm is guaranteed to return empty and the count arm is the only thing left
  // standing between the write and the credential.
  test("a detector-blind target carrying {{NAME:default}} is refused by the count arm alone", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "opaque.txt");
    // `SESSION_TOKEN` is secret-class BY NAME, so it reaches the guard at all;
    // the value is shapeless, so `redactGeneric` cannot see it; and `.txt`
    // resolves to `text` by BOTH the declared format and the path, so the fix
    // in this PR cannot rescue this case either. The count arm is alone here.
    writeFileSync(target, `SESSION_TOKEN=${BLIND_VALUE}\n`);

    // Pin the premise: if a future change makes the detector see this, the test
    // would silently stop exercising the branch it exists to defend.
    expect(scanSecrets(readFileSync(target, "utf-8"), "text")).toHaveLength(0);

    const config = createConfig(
      {
        name: "opaque-defaulted",
        category: "tools",
        format: "text",
        // `{{SESSION_TOKEN:fallback}}` contains no `{{SESSION_TOKEN}}` substring.
        // A plain exact-string count scores it 0 and the guard never sees it.
        content: `SESSION_TOKEN={{SESSION_TOKEN:fallback}}\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(BLIND_VALUE);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
  });
});

describe("NEGATIVE CONTROLS — the guard stays targeted, never a blanket refusal", () => {
  test("a non-secret `text` config with drifted disk content still applies", async () => {
    const db = getDatabase();
    const target = join(tmpDir, ".zshenv");
    writeFileSync(target, `export EDITOR=vim\nexport PAGER=less\n`);

    const config = createConfig(
      {
        name: "zshenv-plain",
        category: "tools",
        format: "text",
        content: `export EDITOR=nvim\nexport PAGER=bat\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    // The whole point: real drift on a shell dotfile must still land.
    expect(readFileSync(target, "utf-8")).toBe(`export EDITOR=nvim\nexport PAGER=bat\n`);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
  });

  test("a shell dotfile whose secret slot is ALREADY a placeholder still applies", async () => {
    const db = getDatabase();
    const target = join(tmpDir, ".zshrc");
    // Nothing live here — the slot already holds the template form, so the write
    // is a no-op in the slot that matters and the rest must ship.
    writeFileSync(target, `export NPM_TOKEN="{{NPM_TOKEN}}"\nexport EDITOR=vim\n`);

    const config = createConfig(
      {
        name: "zshrc-templated",
        category: "tools",
        format: "text",
        content: `export NPM_TOKEN="{{NPM_TOKEN}}"\nexport EDITOR=nvim\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain("export EDITOR=nvim");
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
  });

  test("the markdown prose control is untouched — `.md` must NOT resolve to shell", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "credential-exposure.md");
    // The real rules file's shape: a bare secret-class assignment sitting in
    // PROSE, alongside a prose placeholder. Under the `shell` dialect that
    // assignment scans as a finding (`NPM_TOKEN` is a secret key name and
    // `redacted-example` clears MIN_SECRET_VALUE_LEN), the guard refuses, and
    // ~/.claude/rules/credential-exposure.md could never ship another edit.
    // `redactFormatForTarget` is path-keyed, so `.md` keeps `markdown` and this
    // stays free. The placeholder is present on BOTH sides so the count arm is
    // held constant and this control isolates the DIALECT choice, nothing else.
    writeFileSync(target, "old rule text\nnever write NPM_TOKEN=redacted-example anywhere\nprose mentions {{NPM_TOKEN}}\n");

    const config = createConfig(
      {
        name: "rules-shell-shaped-prose",
        category: "rules",
        format: "markdown",
        content:
          "NEW rule text\nnever write NPM_TOKEN=redacted-example anywhere, in any encoding\nprose mentions {{NPM_TOKEN}}\n",
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain("NEW rule text");
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
  });
});
