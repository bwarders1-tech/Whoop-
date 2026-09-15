import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuthManager } from "./auth/authManager.js";
import { loadConfig, type WhoopConfig } from "./config.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerDataTools } from "./tools/data.js";
import { registerInsightTools } from "./tools/insights.js";
import type { ToolContext } from "./tools/shared.js";
import { WhoopClient } from "./whoop/client.js";

export const SERVER_NAME = "whoop";
export const SERVER_VERSION = "1.0.0";

export interface WhoopServer {
  server: McpServer;
  context: ToolContext;
}

export function createWhoopServer(config: WhoopConfig = loadConfig()): WhoopServer {
  const auth = new AuthManager(config);
  const client = new WhoopClient(config, auth);
  const context: ToolContext = { config, auth, client };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for the connected WHOOP account: recovery, sleep, strain/cycles, workouts and body data. " +
        "Prefer whoop_daily_summary for a single day and whoop_summarize_range for trends; the list tools " +
        "accept either an explicit start/end or a `days` lookback. WHOOP timestamps are UTC. " +
        "If a tool reports that the account is not connected, call whoop_auth_status and then whoop_login.",
    },
  );

  registerAuthTools(server, context);
  registerDataTools(server, context);
  registerInsightTools(server, context);
  registerPrompts(server);

  return { server, context };
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "whoop_morning_briefing",
    {
      title: "WHOOP morning briefing",
      description: "Summarize today's WHOOP recovery, sleep and suggested training load.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Use the WHOOP tools to build my morning briefing: call whoop_daily_summary for today, then " +
              "whoop_summarize_range for the last 7 days. Report recovery, HRV and resting heart rate versus " +
              "the weekly average, how I slept against my sleep need, and recommend a training intensity for " +
              "today. Keep it under 150 words and flag anything unusual.",
          },
        },
      ],
    }),
  );
}
