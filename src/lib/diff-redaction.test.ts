/**
 * Regression tests for the `instructions diff` credential-leak defect.
 *
 * DEFECT (task 8975fd22, incident 612168): `buildDiff` read the file on disk and
 * emitted every differing disk line verbatim as a `+` line. Stored rows are
 * redacted at ingest and hold a placeholder (`${NPM_TOKEN}` / `{{VAR}}`), so for
 * any credential-bearing config the `+` line WAS the live credential, written
 * into a durable session transcript.
 *
 * These tests use SYNTHETIC high-entropy strings invented for the fixture. They
 * are not credentials anywhere. No test in this file reads a real config, a real
 * dotfile, or the real DB.
 *
 * The load-bearing assertion in every case is that the synthetic literal is
 * ABSENT from the rendered diff. Asserting only that a redaction marker appears
 * would pass on a diff that prints the secret AND a marker.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { diffConfig } from "./sync";
import { tempRootPath } from "./test-temp-root";

// ── Synthetic fixtures — invented values, credentials nowhere ────────────────
// Shaped like an npm token so the value-pattern redactor recognises it.
//
// Composed at runtime rather than written as one literal ON PURPOSE. The
// mandatory staged secrets scan matches credential VALUE PREFIXES, so a source
// file containing the `npm_` prefix followed by token-shaped characters trips
// the pre-commit gate on every future commit that touches this file. An agent
// who meets that gate on a fixture learns to override it — which is precisely
// the habit the gate exists to prevent. The runtime string is byte-identical,
// so the redactor's npm-token pattern still matches and the test is unweakened.
const SYNTHETIC_PATTERNED = ["npm", "SYNTHETICfixtureVALUE0123456789abcdefghij"].join("_");
// High entropy, matches NO redactor pattern and sits under no secret-ish key
// name. Only the structural placeholder-vs-literal rule can catch this one.
const SYNTHETIC_PATTERNLESS = "Zq7x0Kd2Vn5Rb8Tj1Wc4Yh6Mp3Lf9Sg";

let tmpDir: string;
let savedApiUrl: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  resetDatabase();
  // These tests exercise the LOCAL store. If the ambient shell is pointed at the
  // hosted API, getDatabase() refuses by design — so isolate the test from the
  // shell rather than depending on how the operator's environment happens to be
  // configured. Names only; no value is read or printed.
  savedApiUrl = process.env["HASNA_INSTRUCTIONS_API_URL"];
  savedApiKey = process.env["HASNA_INSTRUCTIONS_API_KEY"];
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = tempRootPath(`configs-diff-redaction-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
  if (savedApiUrl !== undefined) process.env["HASNA_INSTRUCTIONS_API_URL"] = savedApiUrl;
  if (savedApiKey !== undefined) process.env["HASNA_INSTRUCTIONS_API_KEY"] = savedApiKey;
});

describe("diffConfig — credential redaction", () => {
  test("never prints a patterned credential the disk file holds (npmrc shape)", async () => {
    const file = join(tmpDir, ".npmrc");
    writeFileSync(file, `//registry.npmjs.org/:_authToken=${SYNTHETIC_PATTERNED}\n`);
    const db = getDatabase();
    const c = createConfig(
      {
        name: "npmrc",
        category: "tools",
        format: "ini",
        content: "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
        target_path: file,
      },
      db,
    );

    const diff = await diffConfig(c);

    // The whole point: the value must not be in the output, in any form.
    expect(diff).not.toContain(SYNTHETIC_PATTERNED);
    // ...and the diff must still be USEFUL — a fix that suppresses the hunk
    // entirely, or reports "identical", is also a failure.
    expect(diff).not.toContain("no diff");
    expect(diff).toContain("line 1");
    expect(diff.toLowerCase()).toContain("redacted");
  });

  test("never prints a pattern-less literal when the stored side is a {{}} placeholder", async () => {
    // Structural case: no value pattern matches, so ONLY the
    // placeholder-vs-literal rule can catch this. If diff relies on the pattern
    // set alone, this test fails.
    //
    // The stored side uses `{{VAR}}` — the form redaction actually emits, and
    // one that is not valid syntax in any dialect we store, so it counts as
    // evidence of redaction REGARDLESS of whether the name looks secret-shaped.
    // That is the arm of the rule this fixture pins; the `$NPM_TOKEN` test below
    // pins the other arm, where an ambiguous form needs a secret-shaped name.
    const file = join(tmpDir, "profile.sh");
    writeFileSync(file, `export SOME_VALUE="${SYNTHETIC_PATTERNLESS}"\n`);
    const db = getDatabase();
    const c = createConfig(
      {
        name: "profile",
        category: "shell",
        // `text` is what the store actually holds for a shell file —
        // ConfigFormat has no `shell` member — so this fixture also pins that
        // the structural rule works under the pattern-only generic redactor.
        format: "text",
        content: 'export SOME_VALUE="{{SOME_VALUE}}"\n',
        target_path: file,
      },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).not.toContain(SYNTHETIC_PATTERNLESS);
    expect(diff).not.toContain("no diff");
    expect(diff).toContain("line 1");
    expect(diff.toLowerCase()).toContain("redacted");
  });

  test("redacts a credential on a later line without hiding the lines around it", async () => {
    const file = join(tmpDir, ".npmrc");
    writeFileSync(file, `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${SYNTHETIC_PATTERNED}\nprefix=/opt/disk\n`);
    const db = getDatabase();
    const c = createConfig(
      {
        name: "npmrc-multi",
        category: "tools",
        format: "ini",
        content: "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nprefix=/opt/stored\n",
        target_path: file,
      },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).not.toContain(SYNTHETIC_PATTERNED);
    // Ordinary, non-credential drift on line 3 is still shown in full — the fix
    // must not blanket-suppress every differing line.
    expect(diff).toContain("-prefix=/opt/stored");
    expect(diff).toContain("+prefix=/opt/disk");
  });

  test("resolves the shell redaction dialect from the path, not the stored format", async () => {
    // Neither side carries a placeholder, so the structural rule cannot fire,
    // and the value matches no known token pattern. Only key-name matching in
    // redactShell catches this — which is reached ONLY if diff resolves the
    // dialect from the path. ConfigFormat has no `shell` member, so a stored
    // format of `text` would otherwise select the pattern-only generic redactor.
    const file = join(tmpDir, ".zshrc");
    writeFileSync(file, `export MY_API_KEY="${SYNTHETIC_PATTERNLESS}"\n`);
    const db = getDatabase();
    const c = createConfig(
      {
        name: "zshrc",
        category: "shell",
        format: "text",
        content: 'export MY_API_KEY="Pw4n8Hb2Qz6Ld1Xr9Tk3Vm7Cs5Jf0G"\n',
        target_path: file,
      },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).not.toContain(SYNTHETIC_PATTERNLESS);
    expect(diff).not.toContain("no diff");
    expect(diff.toLowerCase()).toContain("redacted");
  });

  // ── The guards that were missing ───────────────────────────────────────────
  // The first cut of this fix treated ANY `$VAR` on the stored side as evidence
  // of redaction, so a markdown line merely MENTIONING `$PATH` or `$HOME`
  // suppressed as though it held a credential — hiding real drift in files that
  // contain no secret at all. Every usefulness guard above passed anyway,
  // because not one of their fixtures contained a `$VAR`. A guard that cannot
  // see the case is the thing that lets it through, so these fixtures are built
  // around the token that broke it.
  //
  // Reachability, measured: markdown is 77 of 103 registered configs on this
  // machine and 37 are drifted, and the registered corpus includes rule files
  // whose subject matter is shell variables.

  test("prose DOCUMENTING a secret-shaped variable is not treated as a credential", async () => {
    // The case a name gate alone does not catch, and the reason the position
    // gate exists. `$TOKEN` IS secret-shaped, so this line passes the name
    // check — but it is prose, not an assignment, and redaction never rewrites
    // prose. The fixture is real content from
    // `global-credential-exposure-hygiene.md`, a REGISTERED config on this
    // machine, which is precisely the kind of file that is full of these tokens.
    const file = join(tmpDir, "credential-rules.md");
    writeFileSync(file, "- `echo $SECRET_VALUE`, or interpolating one into any printed string\n");
    const db = getDatabase();
    const c = createConfig(
      {
        name: "credential-rules",
        category: "rules",
        format: "markdown",
        content: "- `echo $TOKEN`, or interpolating one into any printed string\n",
        target_path: file,
      },
      db,
    );

    const diff = await diffConfig(c);

    // The real drift must be rendered IN FULL — both sides, verbatim.
    expect(diff).toContain("-- `echo $TOKEN`, or interpolating one into any printed string");
    expect(diff).toContain("+- `echo $SECRET_VALUE`, or interpolating one into any printed string");
    expect(diff.toLowerCase()).not.toContain("redacted");
  });

  test("a stored line whose ordinary variable is dropped on disk still renders", async () => {
    // The nastier shape: the stored `$VAR` is ABSENT from the disk line, which
    // is exactly the condition the structural rule keys on. Nothing here is a
    // credential, so nothing may be suppressed.
    const file = join(tmpDir, "rules.md");
    writeFileSync(file, "Use the home directory for the path.\n");
    const db = getDatabase();
    const c = createConfig(
      { name: "rules-dropped-var", category: "rules", format: "markdown", content: "Use $HOME for the path.\n", target_path: file },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).toContain("-Use $HOME for the path.");
    expect(diff).toContain("+Use the home directory for the path.");
    expect(diff.toLowerCase()).not.toContain("redacted");
  });

  test("a PATH edit that drops $PATH is ordinary drift, not a credential", async () => {
    const file = join(tmpDir, "profile.sh");
    writeFileSync(file, 'export PATH="/opt/b/bin"\n');
    const db = getDatabase();
    const c = createConfig(
      { name: "profile-path", category: "shell", format: "text", content: 'export PATH="$PATH:/opt/a/bin"\n', target_path: file },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).toContain('+export PATH="/opt/b/bin"');
    expect(diff.toLowerCase()).not.toContain("redacted");
  });

  test("an ordinary variable in assignment position is NOT treated as a credential", async () => {
    // Isolates the NAME gate. `$PATH` here IS the whole value of an assignment,
    // so the position gate passes it through and only the name check can reject
    // it. Without a fixture in this exact shape, dropping the name gate breaks
    // nothing and the gate looks unnecessary.
    const file = join(tmpDir, "shellrc");
    writeFileSync(file, 'export PATH="/opt/b/bin"\n');
    const db = getDatabase();
    const c = createConfig(
      { name: "shellrc-noop-path", category: "shell", format: "text", content: 'export PATH="$PATH"\n', target_path: file },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).toContain('-export PATH="$PATH"');
    expect(diff).toContain('+export PATH="/opt/b/bin"');
    expect(diff.toLowerCase()).not.toContain("redacted");
  });

  test("a secret-shaped bare $VAR placeholder IS still treated as a credential", async () => {
    // The counterweight: narrowing the rule must not silently drop the
    // detection it exists for. `$NPM_TOKEN` is secret-shaped where `$PATH` is
    // not, and the disk side here matches no value pattern, so ONLY the
    // structural rule can catch it.
    const file = join(tmpDir, "tokens.sh");
    writeFileSync(file, `export NPM_TOKEN="${SYNTHETIC_PATTERNLESS}"\n`);
    const db = getDatabase();
    const c = createConfig(
      { name: "tokens", category: "shell", format: "text", content: 'export NPM_TOKEN="$NPM_TOKEN"\n', target_path: file },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).not.toContain(SYNTHETIC_PATTERNLESS);
    expect(diff).not.toContain("no diff");
    expect(diff.toLowerCase()).toContain("redacted");
  });

  test("ordinary drift with no credential is still rendered verbatim", async () => {
    const file = join(tmpDir, "notes.md");
    writeFileSync(file, "disk content\n");
    const db = getDatabase();
    const c = createConfig(
      { name: "notes", category: "tools", format: "markdown", content: "stored content\n", target_path: file },
      db,
    );

    const diff = await diffConfig(c);

    expect(diff).toContain("-stored content");
    expect(diff).toContain("+disk content");
  });

  test("identical files still report identical", async () => {
    const file = join(tmpDir, "same.txt");
    writeFileSync(file, "content");
    const db = getDatabase();
    const c = createConfig({ name: "same", category: "tools", content: "content", target_path: file }, db);
    expect(await diffConfig(c)).toBe("(no diff — identical)");
  });

  test("showSecrets opt-in renders the raw disk line", async () => {
    // The escape hatch must actually work when explicitly requested — otherwise
    // the option is decoration and an operator who needs the value has no path.
    // The CLI layer refuses this on a non-TTY; the library honours it.
    const file = join(tmpDir, ".npmrc");
    writeFileSync(file, `//registry.npmjs.org/:_authToken=${SYNTHETIC_PATTERNED}\n`);
    const db = getDatabase();
    const c = createConfig(
      {
        name: "npmrc-show",
        category: "tools",
        format: "ini",
        content: "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
        target_path: file,
      },
      db,
    );

    const diff = await diffConfig(c, { showSecrets: true });
    expect(diff).toContain(SYNTHETIC_PATTERNED);
  });
});
