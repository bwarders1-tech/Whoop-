import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AddressInfo } from "node:net";

import { requireOAuthCredentials, type WhoopConfig } from "../config.js";
import { NotAuthenticatedError, WhoopError } from "../errors.js";
import { logger } from "../logger.js";
import { buildAuthorizeUrl, createState, exchangeAuthorizationCode, refreshAccessToken } from "./oauth.js";
import { TokenStore, type StoredTokens } from "./tokenStore.js";

/** Refresh this long before the access token actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export type LoginPhase = "idle" | "awaiting_callback" | "completed" | "failed";

export interface LoginState {
  phase: LoginPhase;
  message?: string;
  authorizeUrl?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface AuthStatus {
  connected: boolean;
  tokenSource: "token-file" | "environment" | "none";
  tokenFile: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  accessTokenExpired?: boolean;
  canRefresh: boolean;
  scopes?: string[];
  clientConfigured: boolean;
  redirectUri: string;
  login: LoginState;
}

export interface BeginLoginResult {
  authorizeUrl: string;
  redirectUri: string;
  expiresInSeconds: number;
}

export class AuthManager {
  private readonly store: TokenStore;
  private tokens: StoredTokens | null = null;
  private loaded = false;
  private tokenSource: "token-file" | "environment" | "none" = "none";
  private refreshInFlight: Promise<StoredTokens> | null = null;
  private loginState: LoginState = { phase: "idle" };
  private pendingLogin: PendingLogin | null = null;
  /** The most recent flow, kept so waitForLogin() still reports an outcome after it settles. */
  private lastLogin: PendingLogin | null = null;

  constructor(private readonly config: WhoopConfig, store?: TokenStore) {
    this.store = store ?? new TokenStore(config.tokenFile);
  }

  /** Returns a usable bearer token, refreshing it first when needed. */
  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const tokens = await this.ensureLoaded();

    if (!tokens) {
      throw new NotAuthenticatedError();
    }

    const mustRefresh = options.forceRefresh === true || isExpired(tokens);
    if (!mustRefresh) {
      return tokens.access_token;
    }

    if (!tokens.refresh_token) {
      if (options.forceRefresh === true) {
        throw new NotAuthenticatedError("The WHOOP access token was rejected and no refresh token is stored.");
      }
      throw new NotAuthenticatedError("The stored WHOOP access token has expired and no refresh token is available.");
    }

    const refreshed = await this.refresh(tokens.refresh_token);
    return refreshed.access_token;
  }

  async status(): Promise<AuthStatus> {
    const tokens = await this.ensureLoaded();
    const base: AuthStatus = {
      connected: Boolean(tokens),
      tokenSource: tokens ? this.tokenSource : "none",
      tokenFile: this.store.path,
      canRefresh: Boolean(tokens?.refresh_token) && Boolean(this.config.clientId && this.config.clientSecret),
      clientConfigured: Boolean(this.config.clientId && this.config.clientSecret),
      redirectUri: this.config.redirectUri,
      login: { ...this.loginState },
    };
    if (!tokens) return base;

    return {
      ...base,
      expiresAt: new Date(tokens.expires_at).toISOString(),
      expiresInSeconds: Math.round((tokens.expires_at - Date.now()) / 1000),
      accessTokenExpired: isExpired(tokens),
      scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : undefined,
    };
  }

  getLoginState(): LoginState {
    return { ...this.loginState };
  }

  /**
   * Starts the browser based authorization-code flow. Returns as soon as the
   * loopback listener is up so the caller can hand the URL to the user; the
   * callback is processed in the background.
   */
  async beginLogin(): Promise<BeginLoginResult> {
    const { clientId, clientSecret } = requireOAuthCredentials(this.config);
    await this.cancelPendingLogin("Superseded by a new login attempt.");

    const redirect = new URL(this.config.redirectUri);
    const state = createState();
    const authorizeUrl = buildAuthorizeUrl(this.config, state);

    let settle: (result: { ok: true } | { ok: false; error: Error }) => void = () => undefined;
    const completion = new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
      settle = resolve;
    });

    const server = http.createServer((req, res) => {
      void this.handleCallback(req, res, { state, clientId, clientSecret, redirect, finish });
    });

    const pending: PendingLogin = { server, completion, settle: (result) => settle(result), timer: null, settled: false };

    const finish = (result: { ok: true } | { ok: false; error: Error }) => {
      if (pending.settled) return;
      pending.settled = true;
      if (pending.timer) clearTimeout(pending.timer);
      if (this.pendingLogin === pending) this.pendingLogin = null;
      server.close();
      server.closeAllConnections?.();
      this.loginState = result.ok
        ? { phase: "completed", message: "Connected to WHOOP.", startedAt: this.loginState.startedAt, finishedAt: Date.now() }
        : {
            phase: "failed",
            message: result.error.message,
            authorizeUrl,
            startedAt: this.loginState.startedAt,
            finishedAt: Date.now(),
          };
      settle(result);
    };

    await listen(server, redirect).catch((error: unknown) => {
      const message = describeListenError(error, redirect);
      this.loginState = { phase: "failed", message, finishedAt: Date.now() };
      throw new WhoopError(message, { cause: error });
    });

    pending.timer = setTimeout(() => {
      finish({
        ok: false,
        error: new WhoopError(
          `Timed out after ${Math.round(this.config.loginTimeoutMs / 1000)}s waiting for the WHOOP authorization callback.`,
        ),
      });
    }, this.config.loginTimeoutMs);
    pending.timer.unref?.();

    this.pendingLogin = pending;
    this.lastLogin = pending;
    this.loginState = {
      phase: "awaiting_callback",
      message: "Open the authorization URL in a browser and approve access.",
      authorizeUrl,
      startedAt: Date.now(),
    };

    // Nothing else awaits this promise in the background case; swallow rejections.
    void completion.then(() => undefined);

    return {
      authorizeUrl,
      redirectUri: this.config.redirectUri,
      expiresInSeconds: Math.round(this.config.loginTimeoutMs / 1000),
    };
  }

  /**
   * Resolves once the current (or most recent) login finishes, and rejects with
   * the reason when that login failed. Resolves immediately if there never was one.
   */
  async waitForLogin(): Promise<LoginState> {
    const flow = this.pendingLogin ?? this.lastLogin;
    if (!flow) return this.getLoginState();
    const result = await flow.completion;
    if (!result.ok) throw result.error;
    return this.getLoginState();
  }

  async cancelPendingLogin(reason = "Login cancelled."): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingLogin = null;
    pending.server.closeAllConnections?.();
    await new Promise<void>((resolve) => pending.server.close(() => resolve()));
    this.loginState = { phase: "failed", message: reason, finishedAt: Date.now() };
    // Release anyone blocked in waitForLogin().
    pending.settle({ ok: false, error: new WhoopError(reason) });
  }

  /** Forgets the stored tokens. */
  async logout(): Promise<void> {
    await this.cancelPendingLogin("Logged out.");
    this.lastLogin = null;
    await this.store.clear();
    this.tokens = null;
    this.loaded = true;
    this.tokenSource = "none";
    this.loginState = { phase: "idle" };
  }

  /** Test seam: replaces the in-memory tokens and persists them. */
  async setTokens(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
    this.loaded = true;
    this.tokenSource = "token-file";
    await this.store.save(tokens);
  }

  private async ensureLoaded(): Promise<StoredTokens | null> {
    if (this.loaded) return this.tokens;

    const stored = await this.store.load();
    if (stored) {
      this.tokens = stored;
      this.tokenSource = "token-file";
      this.loaded = true;
      return this.tokens;
    }

    if (this.config.staticAccessToken || this.config.staticRefreshToken) {
      this.tokens = {
        access_token: this.config.staticAccessToken ?? "",
        refresh_token: this.config.staticRefreshToken,
        // The environment does not tell us when the token expires; assume the
        // WHOOP default of one hour and let a 401 trigger an early refresh.
        expires_at: this.config.staticAccessToken ? Date.now() + 3_600_000 : 0,
        token_type: "bearer",
        obtained_at: Date.now(),
      };
      this.tokenSource = "environment";
      this.loaded = true;
      return this.tokens;
    }

    this.tokens = null;
    this.tokenSource = "none";
    this.loaded = true;
    return null;
  }

  /** Refreshes at most once at a time, no matter how many callers pile up. */
  private async refresh(refreshToken: string): Promise<StoredTokens> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const { clientId, clientSecret } = requireOAuthCredentials(this.config);
    this.refreshInFlight = (async () => {
      logger.debug("Refreshing the WHOOP access token");
      const tokens = await refreshAccessToken(this.config, { refreshToken, clientId, clientSecret });
      this.tokens = tokens;
      this.tokenSource = "token-file";
      this.loaded = true;
      await this.store.save(tokens);
      logger.info("Refreshed the WHOOP access token", { expiresAt: new Date(tokens.expires_at).toISOString() });
      return tokens;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async handleCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: {
      state: string;
      clientId: string;
      clientSecret: string;
      redirect: URL;
      finish: (result: { ok: true } | { ok: false; error: Error }) => void;
    },
  ): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method !== "GET") {
      respond(res, 405, "Method not allowed", "This endpoint only accepts GET requests.");
      return;
    }
    if (requestUrl.pathname !== context.redirect.pathname) {
      respond(res, 404, "Not found", "Nothing here. Waiting for the WHOOP authorization callback.");
      return;
    }

    const returnedState = requestUrl.searchParams.get("state") ?? "";
    if (!safeEqual(returnedState, context.state)) {
      // Could be a stale tab from an earlier attempt: reject it but keep waiting.
      respond(res, 400, "Unexpected request", "The state parameter did not match this login attempt.");
      logger.warn("Ignored a WHOOP callback with a mismatched state parameter");
      return;
    }

    const errorParam = requestUrl.searchParams.get("error");
    if (errorParam) {
      const description = requestUrl.searchParams.get("error_description") ?? "";
      const message = `WHOOP denied the authorization request: ${errorParam}${description ? ` — ${description}` : ""}`;
      respond(res, 400, "Authorization failed", message);
      context.finish({ ok: false, error: new WhoopError(message) });
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      const message = "The WHOOP callback did not include an authorization code.";
      respond(res, 400, "Authorization failed", message);
      context.finish({ ok: false, error: new WhoopError(message) });
      return;
    }

    try {
      const tokens = await exchangeAuthorizationCode(this.config, {
        code,
        clientId: context.clientId,
        clientSecret: context.clientSecret,
      });
      await this.store.save(tokens);
      this.tokens = tokens;
      this.tokenSource = "token-file";
      this.loaded = true;
      respond(res, 200, "WHOOP connected", "You can close this tab and go back to Claude.");
      logger.info("Connected to WHOOP", { expiresAt: new Date(tokens.expires_at).toISOString() });
      context.finish({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(res, 500, "Authorization failed", message);
      context.finish({ ok: false, error: error instanceof Error ? error : new WhoopError(message) });
    }
  }
}

interface PendingLogin {
  server: http.Server;
  completion: Promise<{ ok: true } | { ok: false; error: Error }>;
  settle: (result: { ok: true } | { ok: false; error: Error }) => void;
  timer: NodeJS.Timeout | null;
  settled: boolean;
}

function isExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expires_at - EXPIRY_SKEW_MS;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function listen(server: http.Server, redirect: URL): Promise<void> {
  const port = redirect.port ? Number(redirect.port) : redirect.protocol === "https:" ? 443 : 80;
  const host = hostForListening(redirect.hostname);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address() as AddressInfo | null;
  logger.debug("Listening for the WHOOP OAuth callback", { host, port: address?.port ?? port });
}

function hostForListening(hostname: string): string {
  // Strip the brackets Node's URL keeps around IPv6 literals.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" ? "127.0.0.1" : bare;
}

function describeListenError(error: unknown, redirect: URL): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    return (
      `Port ${redirect.port || "80"} is already in use, so the WHOOP login callback cannot be received. ` +
      `Close whatever is using it, or set WHOOP_REDIRECT_URI to a free port and register that URL in the ` +
      `WHOOP developer dashboard.`
    );
  }
  if (code === "EACCES") {
    return (
      `Permission denied binding port ${redirect.port || "80"}. Choose a port above 1024 via WHOOP_REDIRECT_URI ` +
      `and register it in the WHOOP developer dashboard.`
    );
  }
  return `Could not start the local callback listener on ${redirect.origin}: ${String(error)}`;
}

function respond(res: http.ServerResponse, status: number, title: string, message: string): void {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d0d0d; color: #f5f5f5;
             display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.5rem; margin-bottom: 0.75rem; }
      p { color: #b5b5b5; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>
`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
