import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { tempDir } from "./helpers/env.js";
import { MockWhoop } from "./helpers/mockWhoop.js";

process.env.WHOOP_LOG_LEVEL = "silent";

const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(DIST_ROOT, "src", "index.js");
const CLI_ENTRY = path.join(DIST_ROOT, "src", "cli.js");

function serverEnv(mock: MockWhoop, tokenFile: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    WHOOP_CLIENT_ID: "test-client-id",
    WHOOP_CLIENT_SECRET: "test-client-secret",
    WHOOP_API_BASE_URL: mock.apiBaseUrl,
    WHOOP_TOKEN_URL: mock.tokenUrl,
    WHOOP_AUTHORIZE_URL: mock.authorizeUrl,
    WHOOP_TOKEN_FILE: tokenFile,
    WHOOP_ACCESS_TOKEN: mock.accessToken,
    WHOOP_LOG_LEVEL: "error",
  };
}

test("the published server binary speaks MCP over stdio", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const dir = await tempDir(t);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: serverEnv(mock, path.join(dir, "tokens.json")),
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const { tools } = await client.listTools();
  assert.ok(tools.length >= 16, `expected the full tool set, saw ${tools.length}`);

  const result = (await client.callTool({ name: "whoop_daily_summary", arguments: { date: "2026-09-15" } })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  assert.notEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /WHOOP summary for 2026-09-15/);

  const capabilities = client.getServerCapabilities();
  assert.ok(capabilities?.tools);
  assert.ok(capabilities?.prompts);
  assert.match(client.getInstructions() ?? "", /whoop_daily_summary/);
});

test("the server keeps stdout free of log noise", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const dir = await tempDir(t);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...serverEnv(mock, path.join(dir, "tokens.json")), WHOOP_LOG_LEVEL: "debug" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1.0.0" } },
    })}\n`,
  );

  await waitFor(() => stdout.includes("\n"), 5000);

  for (const line of stdout.split("\n").filter(Boolean)) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0");
  }
  assert.match(stderr, /WHOOP MCP server .* ready/);
});

test("the CLI reports a disconnected account with a non-zero exit code", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const dir = await tempDir(t);
  const env = { ...serverEnv(mock, path.join(dir, "tokens.json")), WHOOP_ACCESS_TOKEN: "" };

  const result = await run(CLI_ENTRY, ["status"], env);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"connected": false/);

  const help = await run(CLI_ENTRY, ["help"], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /whoop-mcp login/);

  const unknown = await run(CLI_ENTRY, ["nonsense"], env);
  assert.equal(unknown.code, 2);
});

test("the CLI completes a full OAuth login against the callback listener", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const dir = await tempDir(t);
  const tokenFile = path.join(dir, "tokens.json");
  const port = await (await import("./helpers/env.js")).freePort();

  const env = {
    ...serverEnv(mock, tokenFile),
    WHOOP_ACCESS_TOKEN: "",
    WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
  };

  const child = spawn(process.execPath, [CLI_ENTRY, "login"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));

  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  await waitFor(() => /https?:\/\/\S+state=\w+/.test(stdout), 10_000);

  const authorizeUrl = new URL(/(https?:\/\/\S+)/.exec(stdout)?.[1] ?? "");
  const state = authorizeUrl.searchParams.get("state");
  const callback = await fetch(`http://127.0.0.1:${port}/callback?code=${mock.authorizationCode}&state=${state}`);
  assert.equal(callback.status, 200);

  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  assert.match(stdout, /Connected\. Access token expires at/);

  const status = await run(CLI_ENTRY, ["status"], env);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /"connected": true/);

  const logout = await run(CLI_ENTRY, ["logout"], env);
  assert.equal(logout.code, 0);
  assert.equal((await run(CLI_ENTRY, ["status"], env)).code, 1);
});

async function run(
  entry: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the expected output");
}
