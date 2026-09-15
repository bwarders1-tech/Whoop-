import { spawn } from "node:child_process";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { logger } from "../logger.js";
import { ok, safe, type ToolContext } from "./shared.js";

export function registerAuthTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "whoop_auth_status",
    {
      title: "WHOOP connection status",
      description:
        "Check whether this extension is connected to a WHOOP account, when the access token expires, and " +
        "whether a login started with whoop_login has finished. Call this first if any other WHOOP tool " +
        "reports an authentication problem.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      safe(async () => {
        const status = await context.auth.status();
        const summary = status.connected
          ? `Connected to WHOOP (token from ${status.tokenSource}). Access token ${
              status.accessTokenExpired ? "has expired and will be refreshed on the next call" : `expires at ${status.expiresAt}`
            }.`
          : status.clientConfigured
            ? 'Not connected to WHOOP yet. Run the "whoop_login" tool to connect.'
            : "Not connected, and WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET are not configured. Add your WHOOP app " +
              "credentials to the extension settings first.";
        return ok(summary, status);
      }),
  );

  server.registerTool(
    "whoop_login",
    {
      title: "Connect a WHOOP account",
      description:
        "Start the WHOOP OAuth login. Returns an authorization URL that the user must open in a browser and " +
        "approve; the extension receives the callback on its local redirect URL and stores the tokens. " +
        "Show the URL to the user verbatim, then call whoop_auth_status to confirm the connection.",
      inputSchema: {
        open_browser: z
          .boolean()
          .optional()
          .describe("Try to open the authorization URL in the local default browser (default true)."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Block up to this many seconds waiting for the user to approve access (default 0)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ open_browser, wait_seconds }) =>
      safe(async () => {
        const result = await context.auth.beginLogin();

        if (open_browser !== false) {
          openInBrowser(result.authorizeUrl);
        }

        const waitSeconds = wait_seconds ?? 0;
        if (waitSeconds > 0) {
          const finished = await waitForLogin(context, waitSeconds * 1000);
          if (finished) {
            const status = await context.auth.status();
            return ok("Connected to WHOOP.", status);
          }
        }

        return ok(
          `Open this URL in a browser and approve access:\n${result.authorizeUrl}\n\n` +
            `The extension is listening on ${result.redirectUri} and will stop waiting in ` +
            `${result.expiresInSeconds}s. Call "whoop_auth_status" afterwards to confirm.`,
          { authorize_url: result.authorizeUrl, redirect_uri: result.redirectUri },
        );
      }),
  );

  server.registerTool(
    "whoop_logout",
    {
      title: "Disconnect the WHOOP account",
      description:
        "Delete the stored WHOOP tokens from this machine. Optionally also revoke the OAuth grant with WHOOP " +
        "so the credentials cannot be used again.",
      inputSchema: {
        revoke: z
          .boolean()
          .optional()
          .describe("Also ask WHOOP to revoke the access grant for this app (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ revoke }) =>
      safe(async () => {
        const notes: string[] = [];
        if (revoke === true) {
          try {
            await context.client.revokeAccess();
            notes.push("Revoked the WHOOP access grant.");
          } catch (error) {
            notes.push(`Could not revoke the grant with WHOOP (${error instanceof Error ? error.message : String(error)}).`);
          }
        }
        await context.auth.logout();
        notes.push(`Removed the stored tokens from ${context.config.tokenFile}.`);
        return ok(notes.join(" "));
      }),
  );
}

async function waitForLogin(context: ToolContext, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const result = await Promise.race([
      context.auth.waitForLogin().then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function openInBrowser(url: string): void {
  try {
    const command =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => logger.debug("Could not open a browser automatically", { error: String(error) }));
    child.unref();
  } catch (error) {
    logger.debug("Could not open a browser automatically", { error: String(error) });
  }
}
