import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowsDir = join(import.meta.dir, "..", ".github", "workflows");
const workflow = readFileSync(join(workflowsDir, "release.yml"), "utf-8");
const dryRunPath = join(workflowsDir, "release-dry-run.yml");
const dryRunWorkflow = existsSync(dryRunPath) ? readFileSync(dryRunPath, "utf-8") : "";

describe("npm release workflow authorization", () => {
  test("the privileged workflow runs only from the default-branch dispatch surface", () => {
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain("types: [npm-release]");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n\s+push:/);
  });

  test("validates the requested tag before checkout and package execution", () => {
    const validation = workflow.indexOf("- name: Validate release request");
    const checkout = workflow.indexOf("- uses: actions/checkout@");
    const install = workflow.indexOf("- name: Install locked dependencies");
    const ancestry = workflow.indexOf("git merge-base --is-ancestor");

    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(checkout);
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("refs/remotes/origin/main");
    expect(ancestry).toBeLessThan(install);
  });

  test("manual dry runs are isolated from trusted-publishing authority", () => {
    expect(dryRunWorkflow).toContain("workflow_dispatch:");
    expect(dryRunWorkflow).not.toContain("environment: npm-release");
    expect(dryRunWorkflow).not.toContain("id-token: write");
    expect(dryRunWorkflow).not.toContain("npm publish");
  });

  test("the manual dry run reaches every declared build gate", () => {
    expect(dryRunWorkflow).toContain("run: bun run typecheck");
    expect(dryRunWorkflow).toContain("run: bun run test");
    expect(dryRunWorkflow).toContain("run: bun run build");
  });
});
