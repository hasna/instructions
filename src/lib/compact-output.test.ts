import { describe, expect, test } from "bun:test";
import { pagedPayload, paginate, summarizeApplyResult, summarizeConfig } from "./compact-output";
import type { ApplyResult, Config } from "../types";

const config: Config = {
  id: "cfg_1",
  name: "Large Config",
  slug: "large-config",
  kind: "file",
  category: "rules",
  agent: "claude",
  target_path: "~/.config/example/very/long/path/settings.json",
  outputs: [{ agent: "codewith", target_path: "~/.codewith/CODEWITH.md", transform: "codex-flat" }],
  format: "markdown",
  content: "large private content",
  description: "A long description",
  tags: ["one", "two"],
  is_template: false,
  version: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  synced_at: null,
};

describe("compact output helpers", () => {
  test("paginate caps default output and exposes a next cursor", () => {
    const page = paginate(Array.from({ length: 25 }, (_, i) => i));

    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(25);
    expect(page.next_cursor).toBe(20);
    expect(page.has_more).toBe(true);
  });

  test("pagedPayload includes compact pagination metadata", () => {
    const payload = pagedPayload(["a", "b", "c"], { limit: 2, cursor: 1, hint: "more" });

    expect(payload.items).toEqual(["b", "c"]);
    expect(payload.total).toBe(3);
    expect(payload.next_cursor).toBeNull();
    expect(payload.hint).toBe("more");
  });

  test("summarizeConfig omits content and verbose-only fields by default", () => {
    const summary = summarizeConfig(config);
    const serialized = JSON.stringify(summary);

    expect(summary.output_count).toBe(1);
    expect(serialized).not.toContain("large private content");
    expect("outputs" in summary).toBe(false);
    expect("tags" in summary).toBe(false);
  });

  test("summarizeApplyResult omits previous and new content", () => {
    const result: ApplyResult = {
      config_id: "cfg_1",
      path: "/tmp/settings.json",
      previous_content: "old private content",
      new_content: "new private content",
      dry_run: true,
      changed: true,
    };

    const summary = summarizeApplyResult(result);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({ config_id: "cfg_1", changed: true, output_count: 0 });
    expect(serialized).not.toContain("old private content");
    expect(serialized).not.toContain("new private content");
  });
});
