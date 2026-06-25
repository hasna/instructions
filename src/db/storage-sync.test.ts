import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  resolveTables,
} from "./storage-sync";

const envKeys = [
  ...STORAGE_DATABASE_ENV,
  ...STORAGE_MODE_ENV,
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("configs storage sync config", () => {
  test("canonical storage database env wins over fallback", () => {
    process.env.HASNA_CONFIGS_DATABASE_URL = "postgres://new.example/configs";
    process.env.CONFIGS_DATABASE_URL = "postgres://fallback.example/configs";

    expect(getStorageDatabaseUrl()).toBe("postgres://new.example/configs");
    expect(getStorageDatabaseEnvName()).toBe("HASNA_CONFIGS_DATABASE_URL");
    expect(getStorageMode()).toBe("hybrid");
  });

  test("fallback storage database env is used when canonical env is absent", () => {
    process.env.CONFIGS_DATABASE_URL = "postgres://fallback.example/configs";

    expect(getStorageDatabaseUrl()).toBe("postgres://fallback.example/configs");
    expect(getStorageDatabaseEnvName()).toBe("CONFIGS_DATABASE_URL");
    expect(getStorageMode()).toBe("hybrid");
  });

  test("canonical storage mode wins", () => {
    process.env.HASNA_CONFIGS_STORAGE_MODE = "remote";

    expect(getStorageMode()).toBe("remote");
  });

  test("reports storage status for CLI and MCP surfaces", () => {
    process.env.HASNA_CONFIGS_DATABASE_URL = "postgres://new.example/configs";

    expect(getStorageStatus()).toMatchObject({
      configured: true,
      mode: "hybrid",
      service: "configs",
    });
  });

  test("resolves storage tables", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(resolveTables(["feedback"])).toEqual(["feedback"]);
    expect(() => resolveTables(["missing"])).toThrow("Unknown configs sync table");
  });
});
