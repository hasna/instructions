import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanPackageManagerSecrets } from "./package-manager-guard";

function withTempRepo(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "configs-package-guard-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scanPackageManagerSecrets", () => {
  test("allows env-backed npmrc auth and exact Hasna release-age excludes", () => {
    withTempRepo((dir) => {
      writeFileSync(join(dir, ".npmrc"), [
        "@hasna:registry=https://registry.npmjs.org/",
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "bunfig.toml"), [
        "minimumReleaseAge = 604800",
        "minimumReleaseAgeExcludes = [",
        '  "@hasna/configs",',
        '  "@hasna/todos"',
        "]",
      ].join("\n"));

      const result = scanPackageManagerSecrets({ roots: [dir] });
      expect(result.clean).toBe(true);
      expect(result.findings).toHaveLength(0);
    });
  });

  test("flags literal npmrc auth and lockfile token patterns without returning values", () => {
    withTempRepo((dir) => {
      const token = "npm_" + "a".repeat(40);
      writeFileSync(join(dir, ".npmrc"), `//registry.npmjs.org/:_authToken=${token}\n`);
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ token }, null, 2));

      const result = scanPackageManagerSecrets({ roots: [dir] });
      const json = JSON.stringify(result);
      expect(result.clean).toBe(false);
      expect(result.findings.map((finding) => finding.rule)).toContain("npmrc-literal-auth");
      expect(result.findings.map((finding) => finding.rule)).toContain("literal-npm-token");
      expect(json).not.toContain(token);
    });
  });

  test("flags npmrc examples and credentialed registry URLs", () => {
    withTempRepo((dir) => {
      const credentialedRegistry = "https://user:" + "literal-value" + "@registry.npmjs.org/";
      writeFileSync(join(dir, ".npmrc.example"), [
        `@hasna:registry=${credentialedRegistry}`,
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
        "",
      ].join("\n"));

      const result = scanPackageManagerSecrets({ roots: [dir] });
      expect(result.clean).toBe(false);
      expect(result.findings.map((finding) => finding.rule)).toContain("package-manager-url-credentials");
    });
  });

  test("handles direct package-manager file paths", () => {
    withTempRepo((dir) => {
      const npmrc = join(dir, ".npmrc");
      const authKey = "_auth" + "Token";
      writeFileSync(npmrc, `//registry.npmjs.org/:${authKey}=literal-value\n`);

      const result = scanPackageManagerSecrets({ roots: [npmrc] });
      const json = JSON.stringify(result);
      expect(result.clean).toBe(false);
      expect(result.scannedFiles).toBe(1);
      expect(result.findings.map((finding) => finding.rule)).toContain("npmrc-literal-auth");
      expect(json).not.toContain("literal-value");
    });
  });

  test("flags missing or disabled Bun release-age quarantine and broad excludes", () => {
    withTempRepo((dir) => {
      writeFileSync(join(dir, ".bunfig.toml"), [
        "minimumReleaseAge = 0",
        "minimumReleaseAgeExcludes = [",
        '  "@hasna/*",',
        '  "lodash"',
        '  "@hasna/configs*",',
        '  "@hasna/configs/extra"',
        "]",
      ].join("\n"));

      const result = scanPackageManagerSecrets({ roots: [dir] });
      expect(result.findings.map((finding) => finding.rule)).toContain("bun-release-age-disabled");
      expect(result.findings.filter((finding) => finding.rule === "bun-release-age-broad-exclude")).toHaveLength(4);
    });
  });

  test("flags Bun configs that omit minimumReleaseAge", () => {
    withTempRepo((dir) => {
      writeFileSync(join(dir, ".bunfig.toml"), 'minimumReleaseAgeExcludes = ["@hasna/configs"]\n');

      const result = scanPackageManagerSecrets({ roots: [dir] });
      expect(result.findings.map((finding) => finding.rule)).toContain("bun-release-age-missing");
    });
  });
});
