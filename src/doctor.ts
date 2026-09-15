import net from "node:net";

import type { AuthManager } from "./auth/authManager.js";
import type { WhoopConfig } from "./config.js";
import { describeError } from "./tools/shared.js";
import { WhoopClient } from "./whoop/client.js";

export interface DoctorReport {
  ok: boolean;
  lines: string[];
}

/**
 * Checks every link in the chain — settings, redirect port, connectivity,
 * stored tokens, a real API call — and says exactly what to fix.
 */
export async function runDoctor(
  config: WhoopConfig,
  auth: AuthManager,
  options: { envFile?: string } = {},
): Promise<DoctorReport> {
  const lines: string[] = [];
  const problems: string[] = [];

  lines.push(`Settings file:  ${options.envFile ?? "(none — using the process environment)"}`);
  lines.push(`API base URL:   ${config.apiBaseUrl}`);
  lines.push(`Token file:     ${config.tokenFile}`);
  lines.push(`Redirect URL:   ${config.redirectUri}`);
  lines.push(`Scopes:         ${config.scopes.join(" ")}`);

  if (config.clientId && config.clientSecret) {
    lines.push(`Client ID:      ${mask(config.clientId)}`);
    lines.push(`Client secret:  ${mask(config.clientSecret)}`);
  } else {
    problems.push(
      "Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET (from developer-dashboard.whoop.com) in a .env file or the MCP server env.",
    );
  }

  const portStatus = await checkRedirectPort(config.redirectUri);
  lines.push(`Redirect port:  ${portStatus.message}`);
  if (!portStatus.free) {
    problems.push(
      `Free the redirect port or point WHOOP_REDIRECT_URI at another one (and register that URL on the WHOOP app).`,
    );
  }

  const reachable = await checkReachable(config);
  lines.push(`API reachable:  ${reachable.message}`);
  if (!reachable.ok) {
    problems.push(
      reachable.status === undefined
        ? "Check the network connection: the WHOOP API could not be reached."
        : `An unauthenticated request should be answered with HTTP 401, but ${new URL(config.apiBaseUrl).host} ` +
          `returned HTTP ${reachable.status}. A proxy or firewall is most likely intercepting the connection.`,
    );
  }

  const status = await auth.status();
  lines.push(`Connected:      ${status.connected ? `yes (tokens from ${status.tokenSource})` : "no"}`);
  if (status.connected) {
    lines.push(`Token expires:  ${status.expiresAt} (${status.expiresInSeconds}s)`);
    lines.push(`Can refresh:    ${status.canRefresh ? "yes" : "no — log in again when the token expires"}`);
    if (status.scopes) lines.push(`Granted scopes: ${status.scopes.join(" ")}`);
  } else {
    problems.push('Run "whoop-mcp login" (or the whoop_login tool) to connect a WHOOP account.');
  }

  if (status.connected && reachable.ok) {
    const client = new WhoopClient(config, auth);
    try {
      const profile = await client.getProfile();
      const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      lines.push(`Live API call:  ok — connected as ${name || `user ${profile.user_id}`}`);
    } catch (error) {
      lines.push(`Live API call:  failed — ${describeError(error)}`);
      problems.push("The stored credentials were rejected by WHOOP; log in again.");
    }
  }

  if (problems.length > 0) {
    lines.push("", "To fix:");
    problems.forEach((problem, index) => lines.push(`  ${index + 1}. ${problem}`));
  } else {
    lines.push("", "Everything checks out.");
  }

  return { ok: problems.length === 0, lines };
}

function mask(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

async function checkRedirectPort(redirectUri: string): Promise<{ free: boolean; message: string }> {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { free: false, message: `${redirectUri} is not a valid URL` };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        free: false,
        message: `${host}:${port} is not available (${error.code ?? error.message})`,
      });
    });
    server.listen(port, host, () => {
      server.close(() => resolve({ free: true, message: `${host}:${port} is free` }));
    });
  });
}

async function checkReachable(config: WhoopConfig): Promise<{ ok: boolean; status?: number; message: string }> {
  const url = `${config.apiBaseUrl}/v2/user/profile/basic`;
  const host = new URL(url).host;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 15_000)) });
    // Without credentials WHOOP answers 401; anything else means something in
    // the middle answered for it (a captive proxy, a firewall, a stale URL).
    if (response.status === 401) {
      return { ok: true, status: 401, message: `yes (HTTP 401 from ${host}, as expected without a token)` };
    }
    return {
      ok: false,
      status: response.status,
      message: `unexpected — HTTP ${response.status} from ${host} where HTTP 401 was expected`,
    };
  } catch (error) {
    return { ok: false, message: `no — ${String(error)}` };
  }
}
