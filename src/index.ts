#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { loadEnvFile } from "./envFile.js";
import { logger } from "./logger.js";
import { createWhoopServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  const config = loadConfig();
  const { server } = createWhoopServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info(`WHOOP MCP server ${SERVER_VERSION} ready`, {
    envFile,
    apiBaseUrl: config.apiBaseUrl,
    tokenFile: config.tokenFile,
    clientConfigured: Boolean(config.clientId && config.clientSecret),
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error("The WHOOP MCP server failed to start", {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exit(1);
});
