import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { EnvLike } from "../../src/config.js";
import { createWhoopServer } from "../../src/server.js";
import type { ToolContext } from "../../src/tools/shared.js";
import { testConfig } from "./env.js";
import { MockWhoop } from "./mockWhoop.js";

export interface Harness {
  mock: MockWhoop;
  client: Client;
  context: ToolContext;
}

/** Boots the real MCP server against the mock WHOOP API, over an in-memory transport. */
export async function startHarness(t: TestContext, overrides: EnvLike = {}): Promise<Harness> {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());

  const config = await testConfig(t, mock, { WHOOP_ACCESS_TOKEN: mock.accessToken, ...overrides });
  const { server, context } = createWhoopServer(config);
  const client = new Client({ name: "whoop-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    // A login started by a test would otherwise keep its listener (and the
    // test process) alive.
    await context.auth.cancelPendingLogin();
    await client.close();
    await server.close();
  });

  return { mock, client, context };
}

export interface ToolOutcome {
  text: string;
  data: any;
  isError: boolean;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const block = result.content?.[0];
  assert.equal(block?.type, "text", `tool ${name} did not return text content`);
  const text = block?.text ?? "";
  return { text, data: parseJsonTail(text), isError: result.isError === true };
}

/**
 * Tool output is a human summary followed by a blank line and a pretty-printed
 * JSON blob (which never contains a blank line), so the last blank line is the
 * boundary.
 */
function parseJsonTail(text: string): any {
  const start = text.lastIndexOf("\n\n");
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start + 2));
  } catch {
    return undefined;
  }
}
