import { randomBytes } from "node:crypto";

import type { WhoopConfig } from "../config.js";
import { OAuthError, truncate } from "../errors.js";
import type { StoredTokens } from "./tokenStore.js";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export function createState(): string {
  // WHOOP requires the state parameter to be at least 8 characters.
  return randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(config: WhoopConfig, state: string): string {
  if (!config.clientId) {
    throw new OAuthError({ status: 0, body: "", message: "WHOOP_CLIENT_ID is not configured." });
  }
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config: WhoopConfig,
  params: { code: string; clientId: string; clientSecret: string },
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: config.redirectUri,
  });
  return postToken(config, body);
}

export async function refreshAccessToken(
  config: WhoopConfig,
  params: { refreshToken: string; clientId: string; clientSecret: string },
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    // WHOOP only returns a new refresh token when `offline` is requested again.
    scope: "offline",
  });
  const tokens = await postToken(config, body);
  return {
    ...tokens,
    // Some refresh responses omit the refresh token; keep using the current one.
    refresh_token: tokens.refresh_token ?? params.refreshToken,
  };
}

async function postToken(config: WhoopConfig, body: URLSearchParams): Promise<StoredTokens> {
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw new OAuthError({
      status: 0,
      body: String(error),
      message: `Could not reach the WHOOP token endpoint (${config.tokenUrl}): ${String(error)}`,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new OAuthError({
      status: response.status,
      body: text,
      message: describeTokenFailure(response.status, text),
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OAuthError({
      status: response.status,
      body: text,
      message: `WHOOP returned a non-JSON token response: ${truncate(text)}`,
    });
  }

  return toStoredTokens(payload);
}

export function toStoredTokens(payload: unknown, now = Date.now()): StoredTokens {
  if (typeof payload !== "object" || payload === null) {
    throw new OAuthError({ status: 200, body: String(payload), message: "WHOOP token response was not an object." });
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError({
      status: 200,
      body: JSON.stringify(record),
      message: "WHOOP token response did not include an access_token.",
    });
  }
  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
    ? record.expires_in
    : 3600;

  return {
    access_token: accessToken,
    refresh_token: typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : undefined,
    expires_at: now + Math.max(expiresIn, 0) * 1000,
    token_type: typeof record.token_type === "string" && record.token_type ? record.token_type : "bearer",
    scope: typeof record.scope === "string" && record.scope ? record.scope : undefined,
    obtained_at: now,
  };
}

function describeTokenFailure(status: number, body: string): string {
  const detail = truncate(body);
  if (status === 400 && /invalid_grant/i.test(body)) {
    return (
      "WHOOP rejected the grant (invalid_grant). The authorization code or refresh token has expired or " +
      `was already used — reconnect with the "whoop_login" tool. ${detail}`
    );
  }
  if (status === 401 || (status === 400 && /invalid_client/i.test(body))) {
    return `WHOOP rejected the client credentials (HTTP ${status}). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET. ${detail}`;
  }
  return `WHOOP token request failed with HTTP ${status}. ${detail}`;
}
