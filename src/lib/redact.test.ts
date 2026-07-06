import { describe, test, expect } from "bun:test";
import { redactContent, scanSecrets, hasSecrets } from "./redact";

describe("redactContent — shell", () => {
  test("redacts export KEY=value with secret key name", () => {
    const r = redactContent('export ANTHROPIC_API_KEY="sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX"', "shell");
    expect(r.content).toBe('export ANTHROPIC_API_KEY="{{ANTHROPIC_API_KEY}}"');
    expect(r.redacted).toHaveLength(1);
    expect(r.isTemplate).toBe(true);
  });

  test("redacts export NPM_TOKEN=npm_xxx", () => {
    const r = redactContent("export NPM_TOKEN=npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "shell");
    expect(r.content).toBe("export NPM_TOKEN={{NPM_TOKEN}}");
    expect(r.redacted[0]!.varName).toBe("NPM_TOKEN");
  });

  test("does not redact non-secret keys", () => {
    const r = redactContent('export NODE_ENV="production"', "shell");
    expect(r.content).toBe('export NODE_ENV="production"');
    expect(r.redacted).toHaveLength(0);
    expect(r.isTemplate).toBe(false);
  });

  test("does not redact short values", () => {
    const r = redactContent('export DEBUG="true"', "shell");
    expect(r.redacted).toHaveLength(0);
  });

  test("does not re-redact already redacted placeholders", () => {
    const r = redactContent('export API_KEY="{{API_KEY}}"', "shell");
    expect(r.redacted).toHaveLength(0);
  });

  test("redacts multiple secrets in one file", () => {
    const content = [
      "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      'export HOME="/Users/andrei"',
      "export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    ].join("\n");
    const r = redactContent(content, "shell");
    expect(r.redacted).toHaveLength(2);
    expect(r.content).toContain("{{OPENAI_API_KEY}}");
    expect(r.content).toContain("{{GITHUB_TOKEN}}");
    expect(r.content).toContain('"/Users/andrei"');
  });
});

describe("redactContent — json", () => {
  test("redacts token fields", () => {
    const r = redactContent('  "token": "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"', "json");
    expect(r.content).toContain("{{TOKEN}}");
    expect(r.redacted).toHaveLength(1);
  });

  test("redacts api_key fields", () => {
    const r = redactContent('  "api_key": "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX"', "json");
    expect(r.content).toContain("{{API_KEY}}");
    expect(r.redacted).toHaveLength(1);
  });

  test("does not redact non-secret json fields", () => {
    const r = redactContent('  "name": "andrei"', "json");
    expect(r.redacted).toHaveLength(0);
  });

  test("catches npm tokens in json values", () => {
    const r = redactContent('  "authToken": "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"', "json");
    expect(r.redacted.length).toBeGreaterThan(0);
  });
});

describe("redactContent — toml", () => {
  test("redacts token = value", () => {
    const r = redactContent('token = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"', "toml");
    expect(r.content).toContain("{{TOKEN}}");
    expect(r.redacted).toHaveLength(1);
  });

  test("does not redact non-secret toml keys", () => {
    const r = redactContent('name = "my-project"', "toml");
    expect(r.redacted).toHaveLength(0);
  });
});

describe("redactContent — ini/.npmrc", () => {
  test("redacts npmrc auth value to npm env reference", () => {
    const r = redactContent("//registry.npmjs.org/:_authToken=npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "ini");
    expect(r.content).toBe("//registry.npmjs.org/:_authToken=${NPM_TOKEN}");
    expect(r.redacted[0]!.varName).toBe("NPM_TOKEN");
  });

  test("does not flag npm env references as secrets", () => {
    const r = redactContent("//registry.npmjs.org/:_authToken=${NPM_TOKEN}", "ini");
    expect(r.redacted).toHaveLength(0);
  });
});

describe("redactContent — generic/markdown", () => {
  test("catches known token patterns in markdown", () => {
    const r = redactContent("Use token: npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "markdown");
    expect(r.redacted).toHaveLength(1);
  });

  test("does not flag normal text", () => {
    const r = redactContent("# Hello World\n\nThis is a readme.", "markdown");
    expect(r.redacted).toHaveLength(0);
  });
});

describe("scanSecrets", () => {
  test("returns secrets without modifying content", () => {
    const content = 'export API_KEY="sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX"';
    const secrets = scanSecrets(content, "shell");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.varName).toBe("API_KEY");
  });
});

describe("hasSecrets", () => {
  test("returns true when secrets present", () => {
    expect(hasSecrets("export NPM_TOKEN=npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "shell")).toBe(true);
  });

  test("returns false for clean content", () => {
    expect(hasSecrets("export NODE_ENV=production", "shell")).toBe(false);
  });
});

describe("redactContent — edge cases", () => {
  test("handles empty content", () => {
    const r = redactContent("", "shell");
    expect(r.redacted).toHaveLength(0);
    expect(r.content).toBe("");
  });

  test("handles content with only comments", () => {
    const r = redactContent("# This is a comment\n# Another comment", "shell");
    expect(r.redacted).toHaveLength(0);
  });

  test("redacts AWS access keys in any format", () => {
    const r = redactContent("key = AKIAIOSFODNN7EXAMPLE", "toml");
    expect(r.redacted.length).toBeGreaterThan(0);
  });

  test("redacts GitHub tokens with various prefixes", () => {
    const ghp = redactContent("export TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn", "shell");
    expect(ghp.redacted).toHaveLength(1);
    const ghs = redactContent("export TOKEN=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn", "shell");
    expect(ghs.redacted).toHaveLength(1);
  });

  test("does not redact PATH-like values", () => {
    const r = redactContent('export PATH="/usr/local/bin:/usr/bin:/bin"', "shell");
    expect(r.redacted).toHaveLength(0);
  });

  test("handles multiline JSON with mixed secret and non-secret fields", () => {
    const json = `{
  "name": "my-project",
  "api_key": "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "version": "1.0.0",
  "password": "supersecretpasswordthatislongenough"
}`;
    const r = redactContent(json, "json");
    expect(r.redacted).toHaveLength(2); // api_key + password
    expect(r.content).toContain('"name": "my-project"'); // preserved
    expect(r.content).not.toContain("sk-ant"); // redacted
  });
});
