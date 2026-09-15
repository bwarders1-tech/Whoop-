#!/usr/bin/env node
/**
 * Small command line companion to the MCP server, mostly so the OAuth login can
 * be done once outside of Claude.
 */
import { spawn } from "node:child_process";

import { AuthManager } from "./auth/authManager.js";
import { loadConfig, requireOAuthCredentials } from "./config.js";
import { describeError } from "./tools/shared.js";
import { WhoopClient } from "./whoop/client.js";

const USAGE = `whoop-mcp — connect WHOOP to Claude

Usage:
  whoop-mcp login     Authorize a WHOOP account and store the tokens
  whoop-mcp status    Show the current connection status
  whoop-mcp logout    Delete the stored tokens (add --revoke to revoke the grant)
  whoop-mcp serve     Run the MCP server on stdio (what Claude launches)

Environment:
  WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET   Credentials from developer-dashboard.whoop.com
  WHOOP_REDIRECT_URI                     Registered redirect URL (default http://localhost:8788/callback)
  WHOOP_TOKEN_FILE                       Where tokens are stored (default ~/.whoop-mcp/tokens.json)
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "serve") {
    await import("./index.js");
    return 0;
  }

  const config = loadConfig();
  const auth = new AuthManager(config);

  switch (command) {
    case "login": {
      requireOAuthCredentials(config);
      const { authorizeUrl, redirectUri, expiresInSeconds } = await auth.beginLogin();
      process.stdout.write(`Open this URL to authorize WHOOP access:\n\n${authorizeUrl}\n\n`);
      process.stdout.write(`Waiting up to ${expiresInSeconds}s for the callback on ${redirectUri} …\n`);
      openInBrowser(authorizeUrl);
      await auth.waitForLogin();
      const status = await auth.status();
      process.stdout.write(`\nConnected. Access token expires at ${status.expiresAt}.\n`);
      process.stdout.write(`Tokens stored in ${status.tokenFile}\n`);
      return 0;
    }

    case "status": {
      const status = await auth.status();
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return status.connected ? 0 : 1;
    }

    case "logout": {
      if (argv.includes("--revoke")) {
        const client = new WhoopClient(config, auth);
        try {
          await client.revokeAccess();
          process.stdout.write("Revoked the WHOOP access grant.\n");
        } catch (error) {
          process.stderr.write(`Could not revoke the grant: ${describeError(error)}\n`);
        }
      }
      await auth.logout();
      process.stdout.write(`Removed ${config.tokenFile}\n`);
      return 0;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

function openInBrowser(url: string): void {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed above either way.
  }
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
