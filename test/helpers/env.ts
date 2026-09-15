import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { loadConfig, type EnvLike, type WhoopConfig } from "../../src/config.js";
import type { MockWhoop } from "./mockWhoop.js";

/** Creates a temp directory that is removed when the test finishes. */
export async function tempDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whoop-mcp-test-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

export async function testConfig(
  t: TestContext,
  mock: MockWhoop,
  overrides: EnvLike = {},
): Promise<WhoopConfig> {
  const dir = await tempDir(t);
  const env: EnvLike = {
    WHOOP_CLIENT_ID: "test-client-id",
    WHOOP_CLIENT_SECRET: "test-client-secret",
    WHOOP_API_BASE_URL: mock.apiBaseUrl,
    WHOOP_TOKEN_URL: mock.tokenUrl,
    WHOOP_AUTHORIZE_URL: mock.authorizeUrl,
    WHOOP_TOKEN_FILE: path.join(dir, "tokens.json"),
    WHOOP_MAX_RETRIES: "2",
    WHOOP_REQUEST_TIMEOUT_MS: "5000",
    WHOOP_LOG_LEVEL: "silent",
    ...overrides,
  };
  return loadConfig(env);
}

/** Picks a free TCP port for loopback redirect URIs. */
export async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
