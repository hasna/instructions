import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "seed-workflow.ts"), "utf8");

function extractGeneratedConversationsSendCommands(): string[] {
  return [...source.matchAll(/^\s+(conversations send .+)$/gm)].map((match) => match[1] ?? "");
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error(`unterminated ${quote} quote in ${input}`);
  if (current.length > 0) words.push(current);
  return words;
}

function parseSupportedSendFixture(argv: string[]): void {
  const supportedValueOptions = new Set([
    "--to",
    "--from",
    "--session",
    "--priority",
    "--working-dir",
    "--repository",
    "--branch",
    "--metadata",
    "--channel",
  ]);
  const supportedBooleanOptions = new Set(["--blocking", "-j", "--json"]);

  const options = new Map<string, string | boolean>();
  let message: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith("-")) {
      if (supportedBooleanOptions.has(arg)) {
        options.set(arg, true);
        continue;
      }

      if (!supportedValueOptions.has(arg)) {
        throw new Error(`unknown option '${arg}'`);
      }

      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`option '${arg}' argument missing`);
      }
      options.set(arg, value);
      i += 1;
      continue;
    }

    if (message !== null) {
      throw new Error(`unexpected argument '${arg}'`);
    }
    message = arg;
  }

  if (!message) {
    throw new Error("missing required argument 'message'");
  }
  if (!options.has("--to") && !options.has("--channel")) {
    throw new Error("missing required recipient");
  }
}

function parseWithSupportedFixture(command: string): void {
  const argv = splitShellWords(command).map((word) =>
    word.replaceAll("{{PROJECT_SPACE}}", "project-channel").replaceAll("{{AGENT_NAME}}", "vitruvius"),
  );
  expect(argv.slice(0, 2)).toEqual(["conversations", "send"]);
  parseSupportedSendFixture(argv.slice(2));
}

describe("agent workflow conversations send contract", () => {
  test("generated commands use the positional message contract accepted by the supported parser fixture", () => {
    const commands = extractGeneratedConversationsSendCommands();

    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain('conversations send "');
      expect(command).toContain("--channel {{PROJECT_SPACE}}");
      expect(command).toContain("--from {{AGENT_NAME}}");
      parseWithSupportedFixture(command);
    }
  });

  test("generated commands do not emit stale --content or --space send flags", () => {
    const commands = extractGeneratedConversationsSendCommands();

    expect(commands.join("\n")).not.toContain("--content");
    expect(commands.join("\n")).not.toContain("--space");
  });

  test("the supported parser fixture rejects the stale --content and --space form", () => {
    expect(() => parseWithSupportedFixture('conversations send --space project-channel --content "shipped X"')).toThrow();
  });
});
