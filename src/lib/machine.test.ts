import { describe, test, expect } from "bun:test";
import { detectMachineContext, renderMachineAwareContent, resolveProfileVariables, templateizeMachineContent } from "./machine";

describe("machine helpers", () => {
  test("detectMachineContext derives linux defaults", () => {
    const machine = detectMachineContext({
      hostname: "spark01",
      os: "Linux",
      arch: "arm64",
      home_dir: "/home/hasna",
    });
    expect(machine.os_family).toBe("linux");
    expect(machine.workspace_root).toBe("/home/hasna/workspace");
    expect(machine.bun_bin_dir).toBe("/home/hasna/.bun/bin");
    expect(machine.bun_path).toBe("/home/hasna/.bun/bin/bun");
    expect(machine.path_prefix).toBe("/home/hasna/.bun/bin");
  });

  test("resolveProfileVariables renders nested variables", () => {
    const machine = detectMachineContext({
      hostname: "apple01",
      os: "Darwin",
      arch: "arm64",
      home_dir: "/Users/hasna",
      bun_path: "/opt/homebrew/bin/bun",
    });
    const vars = resolveProfileVariables({
      variables: {
        WORKSPACE_ROOT: "{{HOME_DIR}}/Workspace",
        BUN_BIN_DIR: "{{HOME_DIR}}/.bun/bin",
        BUN_PATH: "/opt/homebrew/bin/bun",
        PATH_PREFIX: "/opt/homebrew/bin:{{BUN_BIN_DIR}}",
      },
    }, machine);

    expect(vars["WORKSPACE_ROOT"]).toBe("/Users/hasna/Workspace");
    expect(vars["BUN_BIN_DIR"]).toBe("/Users/hasna/.bun/bin");
    expect(vars["PATH_PREFIX"]).toBe("/opt/homebrew/bin:/Users/hasna/.bun/bin");
  });

  test("templateizeMachineContent replaces absolute machine paths with placeholders", () => {
    const machine = detectMachineContext({
      hostname: "spark01",
      os: "Linux",
      arch: "arm64",
      home_dir: "/home/hasna",
    });
    const input = `command = "${machine.bun_bin_dir}/configs-mcp"\nworkspace = "${machine.workspace_root}/repo"`;
    const result = templateizeMachineContent(input, machine);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("{{BUN_BIN_DIR}}/configs-mcp");
    expect(result.content).toContain("{{WORKSPACE_ROOT}}/repo");
  });

  test("renderMachineAwareContent renders template values", () => {
    const rendered = renderMachineAwareContent("root={{WORKSPACE_ROOT}}", {
      WORKSPACE_ROOT: "/Users/hasna/Workspace",
    });
    expect(rendered).toBe("root=/Users/hasna/Workspace");
  });
});
