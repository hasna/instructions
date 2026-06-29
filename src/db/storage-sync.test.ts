import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pg from "pg";
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
import { buildPgPoolConfig, isLocalPostgresHost } from "./remote-storage";

const envKeys = [
  ...STORAGE_DATABASE_ENV,
  ...STORAGE_MODE_ENV,
] as const;

const savedEnv = new Map<string, string | undefined>();

function inspectClientParameters(connectionString: string): { host?: string; ssl?: unknown } {
  const client = new pg.Client(buildPgPoolConfig(connectionString));
  const params = (client as unknown as { connectionParameters: { host?: string; ssl?: unknown } }).connectionParameters;
  return {
    host: params.host,
    ssl: params.ssl,
  };
}

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

  test("verifies TLS for remote PostgreSQL by default", () => {
    expect(inspectClientParameters("postgres://user:pass@db.example.com/configs")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/configs")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/configs",
      ssl: { rejectUnauthorized: true },
    });
  });

  test("verifies TLS for the exact remote SSL request forms", () => {
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/configs?sslmode=require")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/configs",
      ssl: { rejectUnauthorized: true },
    });
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/configs?ssl=true")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/configs",
      ssl: { rejectUnauthorized: true },
    });
    expect(inspectClientParameters("postgres://user:pass@db.example.com/configs?sslmode=require")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(inspectClientParameters("postgres://user:pass@db.example.com/configs?ssl=true")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
  });

  test("allows local PostgreSQL without TLS", () => {
    expect(isLocalPostgresHost("localhost")).toBe(true);
    expect(isLocalPostgresHost("%2Fvar%2Frun%2Fpostgresql")).toBe(true);
    expect(buildPgPoolConfig("postgres://user:pass@localhost/configs")).toMatchObject({
      connectionString: "postgres://user:pass@localhost/configs",
      ssl: undefined,
    });
  });

  test("allows local PostgreSQL to request verified TLS", () => {
    expect(inspectClientParameters("postgres://user:pass@localhost/configs?sslmode=require")).toMatchObject({
      host: "localhost",
      ssl: { rejectUnauthorized: true },
    });
  });

  test("rejects remote PostgreSQL when TLS is explicitly disabled", () => {
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?ssl=false")).toThrow("TLS disabled");
  });

  test("enforces TLS for remote query host overrides", () => {
    expect(inspectClientParameters("postgres://user:pass@localhost/configs?host=db.example.com")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(inspectClientParameters("postgres://user:pass@localhost/configs?host=localhost&host=db.example.com")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/configs?host=db.example.com&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/configs?host=db.example.com&ssl=false")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?host=&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?hostaddr=&ssl=false")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?hostaddr=127.0.0.1&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?hostaddr=127.0.0.1&ssl=false")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?hostaddr=::1&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/configs?host=localhost&host=db.example.com&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@db.example.com/configs?host=&host=db.example.com&sslmode=disable")).toThrow("TLS disabled");
    expect(() => buildPgPoolConfig("postgres://user:pass@localhost/configs?host=127.0.0.1&host=db.example.com&ssl=false")).toThrow("TLS disabled");
  });

  test("treats remote no-verify mode as verified TLS", () => {
    expect(inspectClientParameters("postgres://user:pass@db.example.com/configs?sslmode=no-verify")).toMatchObject({
      host: "db.example.com",
      ssl: { rejectUnauthorized: true },
    });
  });

  test("preserves non-mode SSL parameters while enforcing verification", () => {
    expect(buildPgPoolConfig("postgres://user:pass@db.example.com/configs?sslrootcert=/tmp/ca.pem")).toMatchObject({
      connectionString: "postgres://user:pass@db.example.com/configs?sslrootcert=%2Ftmp%2Fca.pem",
      ssl: { rejectUnauthorized: true },
    });
  });
});
