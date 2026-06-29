import pg from "pg";
import type { Pool, PoolConfig } from "pg";

const DISABLED_SSL_MODE = "disable";

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params: unknown[]): unknown[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => value === undefined ? null : value);
}

function normalizeHost(hostname: string): string {
  const stripped = hostname.replace(/^\[/, "").replace(/\]$/, "");
  try {
    return decodeURIComponent(stripped).toLowerCase();
  } catch {
    return stripped.toLowerCase();
  }
}

export function isLocalPostgresHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "" || host.startsWith("/");
}

function effectivePgHost(url: URL): string {
  const hosts = url.searchParams.getAll("host");
  const finalHost = hosts.length > 0 ? hosts[hosts.length - 1] : null;
  return finalHost?.trim() ? finalHost : url.hostname;
}

export function buildPgPoolConfig(connectionString: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Invalid PostgreSQL connection string");
  }

  const sslMode = url.searchParams.get("sslmode")?.trim().toLowerCase();
  const sslValue = url.searchParams.get("ssl")?.trim().toLowerCase();
  const isLocal = isLocalPostgresHost(effectivePgHost(url));
  const hasDisabledSsl = sslMode === DISABLED_SSL_MODE || sslValue === "false";

  if (!isLocal && hasDisabledSsl) {
    throw new Error("Refusing remote PostgreSQL connection with TLS disabled");
  }

  const shouldUseSsl = !isLocal || sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full" || sslValue === "true";
  url.searchParams.delete("sslmode");
  url.searchParams.delete("ssl");

  return {
    connectionString: url.toString(),
    ssl: shouldUseSsl ? { rejectUnauthorized: true } : undefined,
  };
}

export class PgAdapterAsync {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool(buildPgPoolConfig(connectionString));
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return { changes: result.rowCount ?? 0 };
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
