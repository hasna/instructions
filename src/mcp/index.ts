#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { isHttpMode, resolveHttpPort, startMcpHttpServer } from "./http.js";

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--claude")) {
    const proc = Bun.spawn(
      ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "configs", "--", "configs-mcp"],
      { stdout: "inherit", stderr: "inherit" }
    );
    await proc.exited;
    process.exit(0);
  }

  if (isHttpMode(argv)) {
    const port = resolveHttpPort(argv);
    const { port: boundPort } = await startMcpHttpServer(port);
    console.error(`configs-mcp HTTP listening on http://127.0.0.1:${boundPort}/mcp`);
    return;
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("MCP server error:", err);
    process.exit(1);
  });
}

export { buildServer } from "./server.js";
