import { LocalConfigStore } from "../data/config-store";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase } from "../db/database";
import { createConfig } from "../db/configs";
import { applyConfig, applyConfigs, applyConfigsWithReport } from "./apply";
import { ANTIGRAVITY_RULE_FILE_CHAR_LIMIT } from "./session-render";
import { detectMachineContext, machineContextToVariables, resolveProfileVariables } from "./machine";
import type { ConfigAgent } from "../types";
import { tempRootPath } from "./test-temp-root";

let tmpDir: string;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  tmpDir = tempRootPath(`configs-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["HASNA_INSTRUCTIONS_DB_PATH"];
  delete process.env["CONFIGS_HOME"];
});

describe("applyConfig", () => {
  test("writes content to target_path", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "test.md");
    const c = createConfig({ name: "T", category: "rules", content: "hello", target_path: target }, db);
    await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(readFileSync(target, "utf-8")).toBe("hello");
  });

  test("dry-run does not write", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "dry.md");
    const c = createConfig({ name: "T", category: "rules", content: "hello", target_path: target }, db);
    const result = await applyConfig(c, { dryRun: true, store: new LocalConfigStore(db) });
    expect(existsSync(target)).toBe(false);
    expect(result.dry_run).toBe(true);
  });

  test("creates parent directories", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "deep", "nested", "file.txt");
    const c = createConfig({ name: "T", category: "tools", content: "data", target_path: target }, db);
    await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(existsSync(target)).toBe(true);
  });

  test("returns changed=false when content identical", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "same.txt");
    writeFileSync(target, "same");
    const c = createConfig({ name: "T", category: "tools", content: "same", target_path: target }, db);
    const result = await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(result.changed).toBe(false);
  });

  test("returns previous_content when overwriting", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "existing.txt");
    writeFileSync(target, "old content");
    const c = createConfig({ name: "T", category: "tools", content: "new content", target_path: target }, db);
    const result = await applyConfig(c, { store: new LocalConfigStore(db) });
    expect(result.previous_content).toBe("old content");
    expect(result.new_content).toBe("new content");
  });

  test("throws for reference kind", async () => {
    const db = getDatabase();
    const c = createConfig({ name: "Ref", category: "workspace", content: "doc", kind: "reference" }, db);
    expect(applyConfig(c, { store: new LocalConfigStore(db) })).rejects.toThrow("reference");
  });

  test("renders machine-aware variables in content and target path", async () => {
    const db = getDatabase();
    const machine = detectMachineContext({
      hostname: "macos-node-a",
      os: "Darwin",
      arch: "arm64",
      home_dir: tmpDir,
      bun_path: "/opt/homebrew/bin/bun",
    });
    const vars = resolveProfileVariables({
      variables: {
        WORKSPACE_ROOT: "{{HOME_DIR}}/Workspace",
      },
    }, machine);
    const c = createConfig({
      name: "Machine Aware",
      category: "tools",
      content: "workspace={{WORKSPACE_ROOT}}",
      target_path: join(tmpDir, "{{HOSTNAME}}.txt"),
      is_template: true,
    }, db);
    const result = await applyConfig(c, { store: new LocalConfigStore(db), vars });
    expect(result.path).toBe(join(tmpDir, "macos-node-a.txt"));
    expect(readFileSync(result.path, "utf-8")).toBe(`workspace=${tmpDir}/Workspace`);
  });

  test("applies transformed outputs for canonical Claude configs", async () => {
    const db = getDatabase();
    const claudeTarget = join(tmpDir, ".claude", "CLAUDE.md");
    const codexTarget = join(tmpDir, ".codex", "AGENTS.md");
    const codewithTarget = join(tmpDir, ".codewith", "CODEWITH.md");
    const opencodeTarget = join(tmpDir, ".config", "opencode", "AGENTS.md");
    const aicopilotTarget = join(tmpDir, ".config", "aicopilot", "AGENTS.md");
    const cursorTarget = join(tmpDir, ".cursor", "rules", "claude.mdc");

    createConfig({
      name: "claude-rules-security.md",
      category: "rules",
      agent: "claude",
      content: "# Security\n\nNever commit secrets.",
      target_path: join(tmpDir, ".claude", "rules", "security.md"),
      format: "markdown",
    }, db);
    const c = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: [
        "# Claude Prompt",
        "",
        "Shared system guidance.",
        "",
        "<!-- claude-only:start -->",
        "Claude-specific local detail.",
        "<!-- claude-only:end -->",
      ].join("\n"),
      target_path: claudeTarget,
      format: "markdown",
      outputs: [
        { agent: "codex", target_path: codexTarget, transform: "codex-flat" },
        { agent: "codewith", target_path: codewithTarget, transform: "codex-flat" },
        { agent: "opencode", target_path: opencodeTarget, transform: "opencode-flat" },
        { agent: "aicopilot", target_path: aicopilotTarget, transform: "opencode-flat" },
        { agent: "cursor", target_path: cursorTarget, transform: "cursor-mdc" },
      ],
    }, db);

    const result = await applyConfig(c, { store: new LocalConfigStore(db) });

    expect(result.outputs?.length).toBe(5);
    expect(readFileSync(claudeTarget, "utf-8")).toContain("Claude-specific local detail");
    for (const target of [codexTarget, codewithTarget, opencodeTarget, aicopilotTarget]) {
      const content = readFileSync(target, "utf-8");
      expect(content).toContain("Shared system guidance.");
      expect(content).toContain("# Security");
      expect(content).not.toContain("Claude-specific local detail");
    }
    const cursor = readFileSync(cursorTarget, "utf-8");
    expect(cursor).toContain("alwaysApply: true");
    expect(cursor).toContain("Shared system guidance.");
  });

  test("skips oversized Antigravity legacy outputs before apply validation", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const antigravityTarget = join(tmpDir, ".gemini", "GEMINI.md");
    const c = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "x".repeat(ANTIGRAVITY_RULE_FILE_CHAR_LIMIT + 1),
      target_path: join(tmpDir, ".claude", "CLAUDE.md"),
      format: "markdown",
      outputs: [
        { agent: "antigravity", target_path: antigravityTarget, transform: "codex-flat" },
      ],
    }, db);

    const report = await applyConfigsWithReport([c], { store: new LocalConfigStore(db) });
    expect(report.failures).toEqual([]);
    expect(report.skipped.some((entry) => entry.path === antigravityTarget)).toBe(true);
    expect(existsSync(antigravityTarget)).toBe(false);
  });

  test("direct apply refuses session-renderer-owned instruction entrypoints", async () => {
    process.env["CONFIGS_HOME"] = tmpDir;
    const db = getDatabase();
    const store = new LocalConfigStore(db);
    const ownedConfigs = [
      createConfig({
        name: "Claude Legacy Entrypoint",
        category: "rules",
        agent: "claude",
        content: "legacy claude",
        target_path: "~/.claude/CLAUDE.md",
      }, db),
      createConfig({
        name: "Antigravity Legacy Entrypoint",
        category: "rules",
        agent: "antigravity",
        content: "legacy antigravity",
        target_path: "~/.gemini/GEMINI.md",
      }, db),
    ];

    for (const config of ownedConfigs) {
      await expect(applyConfig(config, { store })).rejects.toThrow("instructions-session-renderer");
    }
    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(tmpDir, ".gemini", "GEMINI.md"))).toBe(false);
  });

  test("bulk apply skips retired Gemini rows", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const geminiTarget = join(tmpDir, ".gemini", "GEMINI.md");
    const antigravityTarget = join(tmpDir, ".gemini", "ANTIGRAVITY.md");
    const stale = createConfig({
      name: "Stale Gemini Global Rules",
      category: "rules",
      agent: "gemini" as ConfigAgent,
      content: "retired gemini content",
      target_path: "~/.gemini/GEMINI.md",
      format: "markdown",
    }, db);
    const active = createConfig({
      name: "Active Antigravity Rules",
      category: "rules",
      agent: "antigravity",
      content: "active antigravity content",
      target_path: "~/.gemini/ANTIGRAVITY.md",
      format: "markdown",
    }, db);

    const results = await applyConfigs([stale, active], { store: new LocalConfigStore(db) });

    expect(results.length).toBe(0);
    expect(existsSync(geminiTarget)).toBe(false);
    expect(existsSync(antigravityTarget)).toBe(false);
  });

  test("refuses to apply stale rows targeting generated fan-out outputs", async () => {
    const db = getDatabase();
    const codexTarget = join(tmpDir, ".codex", "AGENTS.md");
    const canonical = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: join(tmpDir, ".claude", "CLAUDE.md"),
      format: "markdown",
      outputs: [
        { agent: "codex", target_path: codexTarget, transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-codex-generated",
      category: "rules",
      agent: "codex",
      content: "# stale",
      target_path: codexTarget,
      format: "markdown",
    }, db);

    await applyConfig(canonical, { store: new LocalConfigStore(db) });
    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");

    expect(readFileSync(codexTarget, "utf-8")).toContain("Generated");
    expect(readFileSync(codexTarget, "utf-8")).not.toContain("# stale");
  });

  test("refuses generated output rows even when target path uses an equivalent absolute path", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const canonical = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
      outputs: [
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-aicopilot-generated-absolute",
      category: "rules",
      agent: "aicopilot",
      content: "# absolute stale",
      target_path: join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"),
      format: "markdown",
    }, db);

    await applyConfig(canonical, { store: new LocalConfigStore(db) });
    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");

    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).toContain("Generated");
    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).not.toContain("absolute stale");
  });

  test("refuses generated output rows after rendering machine-aware target paths", async () => {
    const db = getDatabase();
    const generatedTarget = join(tmpDir, "generated.md");
    createConfig({
      name: "Canonical Source",
      category: "rules",
      agent: "claude",
      content: "# Canonical\n",
      target_path: join(tmpDir, "canonical.md"),
      outputs: [
        { agent: "codex", target_path: generatedTarget, transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "Rendered Stale Writer",
      category: "rules",
      agent: "codex",
      content: "# stale\n",
      target_path: "{{HOME_DIR}}/generated.md",
    }, db);

    await expect(applyConfig(stale, {
      store: new LocalConfigStore(db),
      vars: { HOME_DIR: tmpDir },
    })).rejects.toThrow("generated output");
    expect(existsSync(generatedTarget)).toBe(false);
  });

  test("refuses generated output rows when target path reaches the same file through a symlink", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const linkHome = join(tmpDir, "link-home");
    symlinkSync(tmpDir, linkHome, "dir");
    const canonical = createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
      outputs: [
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-aicopilot-generated-symlink",
      category: "rules",
      agent: "aicopilot",
      content: "# symlink stale",
      target_path: join(linkHome, ".config", "aicopilot", "AICOPILOT.md"),
      format: "markdown",
    }, db);

    await applyConfig(canonical, { store: new LocalConfigStore(db) });
    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");

    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).toContain("Generated");
    expect(readFileSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"), "utf-8")).not.toContain("symlink stale");
  });

  test("refuses symlink stale rows before the generated output directory exists", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const linkHome = join(tmpDir, "link-home");
    symlinkSync(tmpDir, linkHome, "dir");
    createConfig({
      name: "Claude Prompt",
      category: "rules",
      agent: "claude",
      content: "# Claude\n\nGenerated",
      target_path: "~/.claude/CLAUDE.md",
      format: "markdown",
      outputs: [
        { agent: "aicopilot", target_path: "~/.config/aicopilot/AICOPILOT.md", transform: "codex-flat" },
      ],
    }, db);
    const stale = createConfig({
      name: "stale-aicopilot-generated-symlink-before-dir",
      category: "rules",
      agent: "aicopilot",
      content: "# symlink stale",
      target_path: join(linkHome, ".config", "aicopilot", "AICOPILOT.md"),
      format: "markdown",
    }, db);

    await expect(applyConfig(stale, { store: new LocalConfigStore(db) })).rejects.toThrow("generated output");
    expect(existsSync(join(tmpDir, ".config", "aicopilot", "AICOPILOT.md"))).toBe(false);
  });
});

// Regression: `instructions apply <id>` wrote template placeholders to disk
// verbatim because it never passed `vars`, so nothing rendered. On station01
// that put the literal string `{{HOME_DIR}}/.config/hasna/git-hooks/...` into
// core.hooksPath, git found no hooks, and the mandatory staged-credential
// secrets scan was inert. Todos 26caf1b9.
//
// The assertion is deliberately NOT "no {{...}} survives". The placeholder
// namespace is shared with src/lib/redact.ts, which stores secrets as
// {{NPM_TOKEN}}-style placeholders precisely so their values never reach the
// DB; those MUST survive a render. What must never survive is a token the
// machine-variable set defines. That set is read from the code rather than
// listed here, so a tenth machine variable is covered without touching this
// file.
describe("apply renders machine variables even when the caller supplies none", () => {
  const machineVarNames = () => Object.keys(machineContextToVariables(detectMachineContext()));

  const survivingMachineTokens = (rendered: string): string[] =>
    machineVarNames().filter((name) => rendered.includes(`{{${name}}}`));

  test("expands the gitconfig shape that disabled the git hook chain", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "gitconfig");
    const c = createConfig({
      name: "gitconfig",
      category: "tools",
      content: [
        "[core]",
        "\thooksPath = {{HOME_DIR}}/.config/hasna/git-hooks/no-cursor-coauthor",
        '[credential "https://github.com"]',
        "\thelper = !{{BUN_BIN_DIR}}/gh auth git-credential",
      ].join("\n"),
      target_path: target,
    }, db);

    // No `vars` — exactly how the `apply <id>` CLI command calls it.
    await applyConfig(c, { store: new LocalConfigStore(db) });

    const written = readFileSync(target, "utf-8");
    expect(survivingMachineTokens(written)).toEqual([]);
    const machine = detectMachineContext();
    expect(written).toContain(`${machine.home_dir}/.config/hasna/git-hooks/no-cursor-coauthor`);
    expect(written).toContain(`!${machine.bun_bin_dir}/gh auth git-credential`);
  });

  test("POSITIVE CONTROL: the same check fires when a machine token is left unexpanded", () => {
    // Proves the assertion above can fail. Without this, a render that silently
    // stopped happening would still show green.
    const notRendered = "hooksPath = {{HOME_DIR}}/.config/hasna/git-hooks/no-cursor-coauthor";
    expect(survivingMachineTokens(notRendered)).toEqual(["HOME_DIR"]);
  });

  test("leaves redaction placeholders intact and still expands machine ones in the same file", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "config.toml");
    // The file already holds the placeholder, so there is no live value in that
    // slot to lose and the write is safe. (When it holds a real value instead,
    // the write is refused — see the credential-destruction test below.)
    writeFileSync(target, 'root = "/stale"\nAuthorization = "{{AUTHORIZATION}}"\n');
    const c = createConfig({
      name: "codex-config-shape",
      category: "tools",
      content: 'root = "{{WORKSPACE_ROOT}}"\nAuthorization = "{{AUTHORIZATION}}"\n',
      target_path: target,
    }, db);

    const result = await applyConfig(c, { store: new LocalConfigStore(db) });

    const written = readFileSync(target, "utf-8");
    expect(survivingMachineTokens(written)).toEqual([]);
    // The secret placeholder is preserved verbatim: expanding it would write a
    // live credential to disk, which is the failure redact.ts exists to prevent.
    expect(written).toContain("{{AUTHORIZATION}}");
    // ...and the operator is told, rather than it passing silently.
    expect(result.unresolved_template_vars).toEqual(["AUTHORIZATION"]);
  });

  // Reviewer sabinus, P1 on PR #38. Rendering preserves what it cannot resolve,
  // which is right for prose and wrong for a credential: ~/.codex/config.toml
  // and ~/.claude.json hold a live secret on disk while their stored rows hold
  // {{AUTHORIZATION}} / {{PRIMARYAPIKEY}}. Writing the preserved placeholder
  // would destroy live auth material on every station a fleet apply touches.
  test("refuses to overwrite a live credential with a preserved secret placeholder", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "config.toml");
    // Synthetic stand-in for a real token; never a live value.
    writeFileSync(target, 'root = "/old"\nAuthorization = "synthetic-live-value-0000"\n');
    const c = createConfig({
      name: "codex-config-shape",
      category: "tools",
      content: 'root = "{{WORKSPACE_ROOT}}"\nAuthorization = "{{AUTHORIZATION}}"\n',
      target_path: target,
    }, db);

    const report = await applyConfigsWithReport([c], { store: new LocalConfigStore(db) });

    // The live value survives and the placeholder never reaches disk.
    const onDisk = readFileSync(target, "utf-8");
    expect(onDisk).toContain("synthetic-live-value-0000");
    expect(onDisk).not.toContain("{{AUTHORIZATION}}");
    // Refused VISIBLY, via the skip channel — not silently, and not by throwing.
    expect(report.results).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.skipped.map((s) => s.owner)).toEqual(["unresolved-secret-placeholder"]);
    expect(report.skipped[0]?.reason).toContain("{{AUTHORIZATION}}");
  });

  // Reviewer sabinus's follow-up question on the fix itself: is there a shape
  // where the placeholder is present AND a live value sits in another slot of
  // the same token? Presence alone would call that safe. Counts do not.
  test("refuses when one slot holds the placeholder and another holds a live value", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "two-slot.toml");
    writeFileSync(target, 'a = "{{AUTHORIZATION}}"\nb = "synthetic-live-value-0000"\n');
    const c = createConfig({
      name: "two-slot",
      category: "tools",
      // The write would place the placeholder in BOTH slots; disk has it in one.
      content: 'a = "{{AUTHORIZATION}}"\nb = "{{AUTHORIZATION}}"\n',
      target_path: target,
    }, db);

    const report = await applyConfigsWithReport([c], { store: new LocalConfigStore(db) });

    expect(report.skipped.map((s) => s.owner)).toEqual(["unresolved-secret-placeholder"]);
    expect(readFileSync(target, "utf-8")).toContain("synthetic-live-value-0000");
  });

  test("the refusal is classified by redact.ts, so PROSE placeholders still apply", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "rules.md");
    writeFileSync(target, "stale\n");
    const c = createConfig({
      name: "prose-tokens",
      category: "rules",
      // None of these are secret-class under isSecretVarName.
      content: "Syntax is {{VAR}}, window {{WINDOW_DAYS}}, guide {{GUIDE_TEMPLATE}}.\n",
      target_path: target,
    }, db);

    const report = await applyConfigsWithReport([c], { store: new LocalConfigStore(db) });

    // A blanket "unresolved token blocks the write" rule would have stopped this
    // one too, which would stop shipping rules files agents read.
    expect(report.skipped).toEqual([]);
    expect(readFileSync(target, "utf-8")).toContain("{{VAR}}");
  });

  test("an unresolvable placeholder does not stop the write", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "credential-exposure.md");
    const c = createConfig({
      name: "rules-doc",
      category: "rules",
      content: "Do not commit `_authToken={{NPM_TOKEN}}`.\n",
      target_path: target,
    }, db);

    await applyConfig(c, { store: new LocalConfigStore(db) });

    // This is the real ~/.claude/rules/credential-exposure.md shape: a rules
    // file that DOCUMENTS a credential rather than holding one. It must keep
    // applying — refusing it would stop shipping a rules file agents read, which
    // is why the credential guard keys on disk state and not on the token name.
    expect(readFileSync(target, "utf-8")).toContain("{{NPM_TOKEN}}");
  });

  test("a rules file that DOCUMENTS a token keeps updating once it is on disk", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "credential-exposure.md");
    // Already shipped once, and the stored rule has since been amended.
    writeFileSync(target, "Do not commit `_authToken={{NPM_TOKEN}}`.\n");
    const c = createConfig({
      name: "rules-doc-updated",
      category: "rules",
      content: "AMENDED. Do not commit `_authToken={{NPM_TOKEN}}`, ever.\n",
      target_path: target,
    }, db);

    const report = await applyConfigsWithReport([c], { store: new LocalConfigStore(db) });

    expect(report.skipped).toEqual([]);
    expect(readFileSync(target, "utf-8")).toContain("AMENDED");
  });

  test("an explicit vars map still wins over the machine default", async () => {
    const db = getDatabase();
    const target = join(tmpDir, "explicit.txt");
    const c = createConfig({
      name: "explicit-vars",
      category: "tools",
      content: "home={{HOME_DIR}}",
      target_path: target,
    }, db);

    await applyConfig(c, {
      store: new LocalConfigStore(db),
      vars: { ...machineContextToVariables(detectMachineContext()), HOME_DIR: tmpDir },
    });

    expect(readFileSync(target, "utf-8")).toBe(`home=${tmpDir}`);
  });

  // Reviewer sabinus: asking "did the caller supply a map" is the wrong
  // question. Both an empty map and a map of unrelated keys are "supplied", and
  // either one left {{HOME_DIR}} on disk. Machine defaults are merged
  // underneath instead, so no caller-supplied map can skip machine rendering.
  test.each([
    ["an empty map", {}],
    ["a map carrying only unrelated keys", { FOO: "bar" }],
  ])("machine variables still render when the caller supplies %s", async (_label, vars) => {
    const db = getDatabase();
    const target = join(tmpDir, `partial-vars-${Object.keys(vars).length}.txt`);
    const c = createConfig({
      name: `partial-vars-${Object.keys(vars).length}`,
      category: "tools",
      content: "home={{HOME_DIR}}",
      target_path: target,
    }, db);

    await applyConfig(c, { store: new LocalConfigStore(db), vars });

    expect(survivingMachineTokens(readFileSync(target, "utf-8"))).toEqual([]);
  });

  test("renders the target_path too, not only the content", async () => {
    const db = getDatabase();
    process.env["CONFIGS_HOME"] = tmpDir;
    const c = createConfig({
      name: "templated-target",
      category: "tools",
      content: "body",
      target_path: "{{HOME_DIR}}/nested/templated.txt",
    }, db);

    await applyConfig(c, { store: new LocalConfigStore(db) });

    // A literal "{{HOME_DIR}}" directory must never be created on disk. An
    // unrendered target path is not absolute and does not start with "~/", so
    // expandPath() resolves it against the CURRENT WORKING DIRECTORY — the
    // unfixed code created ./{{HOME_DIR}}/nested/templated.txt inside the repo
    // checkout it happened to be run from. Both locations are asserted because
    // the cwd one is where it actually landed.
    expect(existsSync(join(tmpDir, "{{HOME_DIR}}"))).toBe(false);
    expect(existsSync(join(process.cwd(), "{{HOME_DIR}}"))).toBe(false);
    expect(readFileSync(join(tmpDir, "nested", "templated.txt"), "utf-8")).toBe("body");
  });
});
