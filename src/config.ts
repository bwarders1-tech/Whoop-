import os from "node:os";
import path from "node:path";

import { ConfigurationError } from "./errors.js";
import { logger } from "./logger.js";

export const DEFAULT_API_BASE_URL = "https://api.prod.whoop.com/developer";
export const DEFAULT_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const DEFAULT_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const DEFAULT_REDIRECT_URI = "http://localhost:8788/callback";

/**
 * `offline` is what makes WHOOP hand out a refresh token; without it the
 * connection dies an hour after login.
 */
export const DEFAULT_SCOPES = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
];

export interface WhoopConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  apiBaseUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenFile: string;
  requestTimeoutMs: number;
  maxRetries: number;
  loginTimeoutMs: number;
  /** Tokens injected through the environment, for headless setups. */
  staticAccessToken?: string;
  staticRefreshToken?: string;
}

export type EnvLike = Record<string, string | undefined>;

export function loadConfig(env: EnvLike = process.env): WhoopConfig {
  const tokenFile = env.WHOOP_TOKEN_FILE?.trim()
    ? expandHome(env.WHOOP_TOKEN_FILE.trim())
    : path.join(os.homedir(), ".whoop-mcp", "tokens.json");

  return {
    clientId: cleanString(env.WHOOP_CLIENT_ID),
    clientSecret: cleanString(env.WHOOP_CLIENT_SECRET),
    redirectUri: parseUrl("WHOOP_REDIRECT_URI", env.WHOOP_REDIRECT_URI, DEFAULT_REDIRECT_URI),
    apiBaseUrl: stripTrailingSlash(parseUrl("WHOOP_API_BASE_URL", env.WHOOP_API_BASE_URL, DEFAULT_API_BASE_URL)),
    authorizeUrl: parseUrl("WHOOP_AUTHORIZE_URL", env.WHOOP_AUTHORIZE_URL, DEFAULT_AUTHORIZE_URL),
    tokenUrl: parseUrl("WHOOP_TOKEN_URL", env.WHOOP_TOKEN_URL, DEFAULT_TOKEN_URL),
    scopes: parseScopes(env.WHOOP_SCOPES),
    tokenFile,
    requestTimeoutMs: parseNumber(env.WHOOP_REQUEST_TIMEOUT_MS, 30_000, 1_000, 600_000, "WHOOP_REQUEST_TIMEOUT_MS"),
    maxRetries: parseNumber(env.WHOOP_MAX_RETRIES, 3, 0, 10, "WHOOP_MAX_RETRIES"),
    loginTimeoutMs: parseNumber(env.WHOOP_LOGIN_TIMEOUT_MS, 300_000, 10_000, 3_600_000, "WHOOP_LOGIN_TIMEOUT_MS"),
    staticAccessToken: cleanString(env.WHOOP_ACCESS_TOKEN),
    staticRefreshToken: cleanString(env.WHOOP_REFRESH_TOKEN),
  };
}

/** Throws unless the config has everything the OAuth flows need. */
export function requireOAuthCredentials(config: WhoopConfig): { clientId: string; clientSecret: string } {
  if (!config.clientId || !config.clientSecret) {
    throw new ConfigurationError(
      "WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET must be set. Create an app at " +
        "https://developer-dashboard.whoop.com, then add the credentials to the extension settings " +
        `(or the MCP server env) together with the redirect URL "${config.redirectUri}".`,
    );
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parseUrl(name: string, value: string | undefined, fallback: string): string {
  const raw = cleanString(value);
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(`${name} is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return raw;
}

function parseScopes(value: string | undefined): string[] {
  const raw = cleanString(value);
  if (!raw) return [...DEFAULT_SCOPES];
  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) return [...DEFAULT_SCOPES];
  if (!scopes.includes("offline")) {
    // Without `offline` there is no refresh token and the session expires in an hour.
    scopes.unshift("offline");
  }
  return [...new Set(scopes)];
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const raw = cleanString(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(`${name} is not a number ("${raw}"), using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(Math.max(Math.round(parsed), min), max);
  if (clamped !== Math.round(parsed)) {
    logger.warn(`${name}=${raw} is out of range [${min}, ${max}], using ${clamped}`);
  }
  return clamped;
}
