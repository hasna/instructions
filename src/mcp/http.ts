import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./server.js";

export const MCP_HTTP_PORT = 8807;
export const MCP_NAME = "configs";

export function isHttpMode(argv: string[]): boolean {
  return argv.includes("--http") || process.env.MCP_HTTP === "1";
}

export function resolveHttpPort(argv: string[]): number {
  const eqArg = argv.find((a) => a.startsWith("--port="));
  if (eqArg) {
    const parsed = Number.parseInt(eqArg.slice("--port=".length), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const idx = argv.indexOf("--port");
  if (idx >= 0) {
    const parsed = Number.parseInt(argv[idx + 1] ?? "", 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const envPort = process.env.MCP_HTTP_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return MCP_HTTP_PORT;
}

export function healthPayload(): { status: string; name: string } {
  return { status: "ok", name: MCP_NAME };
}

async function handleMcpRequest(req: Request): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function handleMcpHttpRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json(healthPayload());
  }
  if (url.pathname === "/mcp") {
    return handleMcpRequest(req);
  }
  return null;
}

export async function startMcpHttpServer(
  port: number
): Promise<{ port: number; stop: () => void }> {
  const httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const handled = await handleMcpHttpRequest(req);
      if (handled) return handled;
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  return { port: httpServer.port!, stop: () => httpServer.stop() };
}

export function mountMcpHttpRoutes(app: {
  get: (path: string, handler: (c: { json: (body: unknown) => Response; req: { raw: Request } }) => Response | Promise<Response>) => void;
  all: (path: string, handler: (c: { req: { raw: Request } }) => Response | Promise<Response>) => void;
}): void {
  app.get("/health", (c) => c.json(healthPayload()));
  app.all("/mcp", async (c) => {
    const response = await handleMcpHttpRequest(c.req.raw);
    return response ?? Response.json({ error: "Not found" }, { status: 404 });
  });
}
