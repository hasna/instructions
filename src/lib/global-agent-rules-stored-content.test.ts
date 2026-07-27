// Behavioural control: uses ONLY the pre-existing public API surface, so a failure
// here can only mean stored rules content was discarded at render time.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConfig } from "../db/configs";
import { getDatabase, resetDatabase } from "../db/database";
import { planSessionRender, sourceFromConfig } from "./session-render";
import { GLOBAL_AGENT_RULES_STANDARD_SLUG } from "./global-agent-rules-standard";

let db: Database;

beforeEach(() => {
  resetDatabase();
  process.env["HASNA_INSTRUCTIONS_DB_PATH"] = ":memory:";
  db = getDatabase();
});

const MARKER = "MARKER-STORED-RULES-MUST-REACH-DISK";
const STORED_CONTENT = [
  "# Hasna Agent Operating Rules — v1.1.12 (2026-07-27)",
  "<!-- hasna:agent-operating-rules v=1.1.12 -->",
  MARKER,
  "24. Rule twenty-four exists only in the stored payload.",
].join("\n") + "\n";

describe("stored agent operating rules reach the rendered artifact", () => {
  test("sourceFromConfig preserves stored content", () => {
    const stored = createConfig({
      name: "Global Agent Rules Standard",
      category: "rules",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: STORED_CONTENT,
    }, db);
    expect(stored.slug).toBe(GLOBAL_AGENT_RULES_STANDARD_SLUG);
    expect(stored.content).toContain(MARKER);

    const source = sourceFromConfig(stored);
    expect(source.content).toContain(MARKER);
    expect(source.content).toContain("v1.1.12");
    expect(source.content).not.toContain("v=1.1.6");
  });

  test("planSessionRender writes stored content", () => {
    const stored = createConfig({
      name: "Global Agent Rules Standard",
      category: "rules",
      agent: "global",
      format: "markdown",
      kind: "reference",
      content: STORED_CONTENT,
    }, db);

    const plan = planSessionRender({
      tool: "codex",
      profile: "account999",
      targetHome: "/tmp/does-not-need-to-exist-for-planning",
      sources: [sourceFromConfig(stored)],
    });

    const rendered = plan.files.map((f) => f.content).join("\n");
    expect(rendered).toContain(MARKER);
    expect(rendered).toContain("v1.1.12");
  });
});
