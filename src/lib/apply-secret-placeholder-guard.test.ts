// Regression cover for todos e043e6df, on top of the guard #39 merged.
//
// #39 introduced `wouldDestroyACredential` and closed the common case. It decided
// from ONE signal — the total number of times the exact string `{{NAME}}` appears
// in the target versus in the write — and that scalar is defeated two ways, both
// MEASURED on main @ 4d34861 with a positive control, not argued:
//
//   BYPASS 1  RELOCATION. Disk holds `prose mentions {{NPM_TOKEN}}` and
//             `token = "<live>"`. The write drops the token from the prose line
//             and puts it on the value line. Total is 1 before and 1 after, so
//             `current < rendered` is false and the write proceeds. Value gone.
//
//   BYPASS 2  THE `{{NAME:default}}` SPELLING. VAR_PATTERN is
//             `\{\{([A-Z0-9_]+)(?::([^}]*))?\}\}` and the renderer preserves that
//             WHOLE form when it cannot resolve the name. `{{AUTHORIZATION:x}}`
//             contains no `{{AUTHORIZATION}}` substring, so an exact-string count
//             scores it zero and the guard never sees it at all.
//
// A scalar per file cannot see WHERE, so every rewrite conserving the total is
// invisible to it. The answer is not a better scalar and not line matching —
// line matching sees the relocation but ALSO refuses an ordinary prose edit on
// the line carrying the placeholder, which would stop the credential-hygiene
// rules file from ever shipping an edit. There is a test for that below, because
// a backstop that fires on correct behaviour is how a guard gets routed around.
//
// The answer is to stop inferring and ask: IS A LIVE CREDENTIAL IN THE TARGET
// RIGHT NOW? `redact.ts`'s own `scanSecrets` — the detector whose output creates
// these placeholders — answers that directly, with no position, no counting and
// no line matching, and it is symmetric with ingest by construction.
//
// Every test asserts the SURVIVING BYTES on disk, never an error string. A guard
// that throws or skips while still having written is the failure this exists to
// catch, and an assertion on the message cannot see it.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LocalConfigStore } from "../data/config-store";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { applyConfigsWithReport, previewConfigs } from "./apply";
import { makeTempRoot } from "./test-temp-root";

let tmpDir: string;
let previousApiUrl: string | undefined;
let previousApiKey: string | undefined;

// Synthetic, and never a credential. It only has to be a distinctive byte string
// whose disappearance is unambiguous. It is deliberately shaped like a real
// value so the format-aware detectors treat it as one.
const LIVE_VALUE = "sk-live-e043e6df-not-a-real-credential-0123456789";

beforeEach(() => {
  // The hosted-store env would otherwise select the SHARED FLEET STORE even with
  // a DB path set (defect b19d3d37). Stripped here so isolation is a property of
  // the suite rather than of how it happened to be invoked.
  previousApiUrl = process.env["HASNA_INSTRUCTIONS_API_URL"];
  previousApiKey = process.env["HASNA_INSTRUCTIONS_API_KEY"];
  delete process.env["HASNA_INSTRUCTIONS_API_URL"];
  delete process.env["HASNA_INSTRUCTIONS_API_KEY"];
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = makeTempRoot("apply-secret-guard-");
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

describe("a write never destroys a live credential", () => {
  test("BYPASS 1 — RELOCATION: total count conserved, placeholder moved onto the live slot", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "relocated.toml");
    writeFileSync(target, `# prose mentions {{NPM_TOKEN}}\ntoken = "${LIVE_VALUE}"\n`);

    const config = createConfig(
      {
        name: "relocated",
        category: "tools",
        format: "toml",
        content: `# prose no longer mentions it\ntoken = "{{NPM_TOKEN}}"\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(LIVE_VALUE);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
  });

  test("BYPASS 2 — the {{NAME:default}} spelling an exact-string count scores as zero", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "defaulted.toml");
    writeFileSync(target, `authorization = "${LIVE_VALUE}"\n`);

    const config = createConfig(
      {
        name: "defaulted",
        category: "tools",
        format: "toml",
        content: `authorization = "{{AUTHORIZATION:fallback}}"\n`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(LIVE_VALUE);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
  });

  test("the original blocker — {{AUTHORIZATION}} over a live codex value", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "config.toml");
    writeFileSync(target, `authorization = "${LIVE_VALUE}"\nhome = "/home/x"\n`);

    const config = createConfig(
      {
        name: "codex-like",
        category: "tools",
        format: "toml",
        content: `authorization = "{{AUTHORIZATION}}"\nhome = "{{HOME_DIR}}"\n`,
        target_path: target,
      },
      db,
    );

    await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(LIVE_VALUE);
  });

  test("the second blocker — {{PRIMARYAPIKEY}} over a live value in a JSON target", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "claude.json");
    writeFileSync(target, `{"primaryApiKey":"${LIVE_VALUE}","other":1}`);

    const config = createConfig(
      {
        name: "claude-json-like",
        category: "tools",
        format: "json",
        content: `{"primaryApiKey":"{{PRIMARYAPIKEY}}","other":2}`,
        target_path: target,
      },
      db,
    );

    await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(LIVE_VALUE);
  });

  test("adding a SECOND occurrence over a live value is still refused", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "mixed.toml");
    writeFileSync(target, `# prose mentions {{NPM_TOKEN}}\ntoken = "${LIVE_VALUE}"\n`);

    const config = createConfig(
      {
        name: "mixed",
        category: "tools",
        format: "toml",
        content: `# prose mentions {{NPM_TOKEN}}\ntoken = "{{NPM_TOKEN}}"\n`,
        target_path: target,
      },
      db,
    );

    await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain(LIVE_VALUE);
  });
});

describe("prose keeps shipping — the guard must not fire on correct behaviour", () => {
  test("POSITIVE CONTROL — a prose placeholder already on disk still writes", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "credential-exposure.md");
    writeFileSync(target, "old rule text\nnever commit {{NPM_TOKEN}} anywhere\n");

    const config = createConfig(
      {
        name: "rules-like",
        category: "rules",
        format: "markdown",
        content: "NEW rule text\nnever commit {{NPM_TOKEN}} anywhere\n",
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    const onDisk = readFileSync(target, "utf-8");
    expect(onDisk).toContain("NEW rule text");
    expect(onDisk).toContain("{{NPM_TOKEN}}");
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
  });

  test("POSITIVE CONTROL — EDITING the prose ON the placeholder's own line still writes", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "credential-exposure.md");
    writeFileSync(target, "preface\nnever commit {{NPM_TOKEN}} anywhere\n");

    const config = createConfig(
      {
        name: "rules-edited-line",
        category: "rules",
        format: "markdown",
        // The placeholder's LINE changes. A line-context rule refuses this and
        // would stop the credential-hygiene rules file shipping any edit to the
        // line that documents the token — which is most of its edits.
        content: "preface\nnever commit {{NPM_TOKEN}} anywhere, not even in an encoding\n",
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toContain("not even in an encoding");
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
  });

  test("POSITIVE CONTROL — non-secret unresolved tokens still reach disk untouched", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "claude-ish.json");
    writeFileSync(target, `{"a":1}`);

    const config = createConfig(
      {
        name: "prose-tokens",
        category: "tools",
        format: "json",
        // The three ~/.claude.json really carries alongside the credential.
        content: `{"a":2,"g":"{{GUIDE_TEMPLATE}}","u":"{{USAGE_DATA}}","w":"{{WINDOW_DAYS}}"}`,
        target_path: target,
      },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    const onDisk = readFileSync(target, "utf-8");
    expect(onDisk).toContain("{{GUIDE_TEMPLATE}}");
    expect(onDisk).toContain(`"a":2`);
    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
  });

  test("POSITIVE CONTROL — a resolvable variable still expands and writes", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "hooks.ini");
    writeFileSync(target, "hooksPath = stale\n");

    const config = createConfig(
      { name: "gitconfig-like", category: "tools", format: "ini", content: "hooksPath = {{HOME_DIR}}/hooks\n", target_path: target },
      db,
    );

    await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(readFileSync(target, "utf-8")).toBe("hooksPath = /home/x/hooks\n");
  });

  test("an ABSENT target is written — the guard is pointed at destruction, not at every placeholder", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "fresh.toml");

    const config = createConfig(
      { name: "fresh", category: "tools", format: "toml", content: `authorization = "{{AUTHORIZATION}}"\n`, target_path: target },
      db,
    );

    await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    // Nothing existed, so nothing was destroyed; bootstrap on a fresh machine works.
    expect(existsSync(target)).toBe(true);
  });

  test("a byte-identical write is never refused", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "same.toml");
    writeFileSync(target, `authorization = "{{AUTHORIZATION}}"\n`);

    const config = createConfig(
      { name: "same", category: "tools", format: "toml", content: `authorization = "{{AUTHORIZATION}}"\n`, target_path: target },
      db,
    );

    const report = await applyConfigsWithReport([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(false);
    expect(report.results[0]!.primary_changed).toBe(false);
  });

  test("--dry-run PREDICTS the refusal and writes nothing", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "config.toml");
    writeFileSync(target, `authorization = "${LIVE_VALUE}"\n`);

    const config = createConfig(
      { name: "codex-like", category: "tools", format: "toml", content: `authorization = "{{AUTHORIZATION}}"\n`, target_path: target },
      db,
    );

    const report = await previewConfigs([config], { store: store(), vars: { HOME_DIR: "/home/x" } });

    expect(report.skipped.some((s) => s.owner === "unresolved-secret-placeholder")).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain(LIVE_VALUE);
  });
});
