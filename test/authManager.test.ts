import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { AuthManager } from "../src/auth/authManager.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { ConfigurationError, NotAuthenticatedError } from "../src/errors.js";
import { freePort, testConfig } from "./helpers/env.js";
import { MockWhoop } from "./helpers/mockWhoop.js";

process.env.WHOOP_LOG_LEVEL = "silent";

async function withMock(t: import("node:test").TestContext): Promise<MockWhoop> {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  return mock;
}

test("getAccessToken without stored tokens asks the user to log in", async (t) => {
  const mock = await withMock(t);
  const auth = new AuthManager(await testConfig(t, mock));

  await assert.rejects(auth.getAccessToken(), (error: unknown) => {
    assert.ok(error instanceof NotAuthenticatedError);
    assert.match(error.message, /whoop_login/);
    return true;
  });
});

test("a valid stored token is returned without touching the network", async (t) => {
  const mock = await withMock(t);
  const config = await testConfig(t, mock);
  const auth = new AuthManager(config);
  await auth.setTokens({
    access_token: "stored-access",
    refresh_token: "stored-refresh",
    expires_at: Date.now() + 600_000,
    token_type: "bearer",
    obtained_at: Date.now(),
  });

  assert.equal(await auth.getAccessToken(), "stored-access");
  assert.equal(mock.requestsFor("/oauth/oauth2/token").length, 0);
});

test("an expired token is refreshed and the new pair is persisted", async (t) => {
  const mock = await withMock(t);
  const config = await testConfig(t, mock);
  const auth = new AuthManager(config);
  await auth.setTokens({
    access_token: "old-access",
    refresh_token: mock.refreshToken,
    expires_at: Date.now() - 1_000,
    token_type: "bearer",
    obtained_at: Date.now() - 3_600_000,
  });

  const token = await auth.getAccessToken();
  assert.equal(token, mock.accessToken);
  assert.equal(mock.requestsFor("/oauth/oauth2/token").length, 1);

  const persisted = await new TokenStore(config.tokenFile).load();
  assert.equal(persisted?.access_token, mock.accessToken);
  assert.equal(persisted?.refresh_token, mock.refreshToken);
});

test("a token expiring within the skew window is refreshed early", async (t) => {
  const mock = await withMock(t);
  const auth = new AuthManager(await testConfig(t, mock));
  await auth.setTokens({
    access_token: "about-to-expire",
    refresh_token: mock.refreshToken,
    expires_at: Date.now() + 30_000,
    token_type: "bearer",
    obtained_at: Date.now(),
  });

  assert.equal(await auth.getAccessToken(), mock.accessToken);
});

test("concurrent callers trigger exactly one refresh", async (t) => {
  const mock = await withMock(t);
  const auth = new AuthManager(await testConfig(t, mock));
  await auth.setTokens({
    access_token: "old-access",
    refresh_token: mock.refreshToken,
    expires_at: Date.now() - 1_000,
    token_type: "bearer",
    obtained_at: Date.now() - 3_600_000,
  });

  const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken()));
  assert.deepEqual(new Set(tokens), new Set([mock.accessToken]));
  assert.equal(mock.requestsFor("/oauth/oauth2/token").length, 1);
});

test("an expired token with no refresh token reports that a new login is needed", async (t) => {
  const mock = await withMock(t);
  const auth = new AuthManager(await testConfig(t, mock));
  await auth.setTokens({
    access_token: "old-access",
    expires_at: Date.now() - 1,
    token_type: "bearer",
    obtained_at: Date.now() - 3_600_000,
  });

  await assert.rejects(auth.getAccessToken(), NotAuthenticatedError);
});

test("tokens supplied through the environment are used when no token file exists", async (t) => {
  const mock = await withMock(t);
  const config = await testConfig(t, mock, { WHOOP_ACCESS_TOKEN: "env-access", WHOOP_REFRESH_TOKEN: "env-refresh" });
  const auth = new AuthManager(config);

  assert.equal(await auth.getAccessToken(), "env-access");
  const status = await auth.status();
  assert.equal(status.tokenSource, "environment");
  assert.equal(status.connected, true);
});

test("status reports a disconnected, unconfigured extension", async (t) => {
  const mock = await withMock(t);
  const config = await testConfig(t, mock, { WHOOP_CLIENT_ID: "", WHOOP_CLIENT_SECRET: "" });
  const status = await new AuthManager(config).status();

  assert.equal(status.connected, false);
  assert.equal(status.clientConfigured, false);
  assert.equal(status.tokenSource, "none");
  assert.equal(status.login.phase, "idle");
});

test("beginLogin requires client credentials", async (t) => {
  const mock = await withMock(t);
  const config = await testConfig(t, mock, { WHOOP_CLIENT_ID: "", WHOOP_CLIENT_SECRET: "" });
  await assert.rejects(new AuthManager(config).beginLogin(), ConfigurationError);
});

test("the full login flow stores tokens from the loopback callback", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);

  const { authorizeUrl } = await auth.beginLogin();
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state);
  assert.equal((await auth.status()).login.phase, "awaiting_callback");

  const callback = await fetch(
    `http://127.0.0.1:${port}/callback?code=${mock.authorizationCode}&state=${state}`,
  );
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /WHOOP connected/);

  await auth.waitForLogin();
  const status = await auth.status();
  assert.equal(status.connected, true);
  assert.equal(status.login.phase, "completed");
  assert.equal(await auth.getAccessToken(), mock.accessToken);
});

test("a callback with the wrong state is rejected and the flow keeps waiting", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  const { authorizeUrl } = await auth.beginLogin();
  t.after(() => auth.cancelPendingLogin());

  const rejected = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=not-the-state`);
  assert.equal(rejected.status, 400);
  assert.equal((await auth.status()).login.phase, "awaiting_callback");
  assert.equal((await auth.status()).connected, false);

  // The real callback still works afterwards.
  const state = new URL(authorizeUrl).searchParams.get("state");
  const accepted = await fetch(`http://127.0.0.1:${port}/callback?code=${mock.authorizationCode}&state=${state}`);
  assert.equal(accepted.status, 200);
  await auth.waitForLogin();
  assert.equal((await auth.status()).connected, true);
});

test("a denied authorization is reported as a failed login", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  const { authorizeUrl } = await auth.beginLogin();
  const state = new URL(authorizeUrl).searchParams.get("state");

  const response = await fetch(
    `http://127.0.0.1:${port}/callback?error=access_denied&error_description=User%20said%20no&state=${state}`,
  );
  assert.equal(response.status, 400);

  await assert.rejects(auth.waitForLogin(), /access_denied/);
  const status = await auth.status();
  assert.equal(status.login.phase, "failed");
  assert.match(status.login.message ?? "", /User said no/);
  assert.equal(status.connected, false);
});

test("a callback without a code fails the login", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  const { authorizeUrl } = await auth.beginLogin();
  const state = new URL(authorizeUrl).searchParams.get("state");

  const response = await fetch(`http://127.0.0.1:${port}/callback?state=${state}`);
  assert.equal(response.status, 400);
  await assert.rejects(auth.waitForLogin(), /did not include an authorization code/);
});

test("a failed code exchange leaves the extension disconnected", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  const { authorizeUrl } = await auth.beginLogin();
  const state = new URL(authorizeUrl).searchParams.get("state");

  const response = await fetch(`http://127.0.0.1:${port}/callback?code=wrong-code&state=${state}`);
  assert.equal(response.status, 500);
  await assert.rejects(auth.waitForLogin(), /invalid_grant/);
  assert.equal((await auth.status()).connected, false);
});

test("other paths on the callback listener do not end the flow", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  await auth.beginLogin();
  t.after(() => auth.cancelPendingLogin());

  assert.equal((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback`, { method: "POST" })).status, 405);
  assert.equal((await auth.status()).login.phase, "awaiting_callback");
});

test("a busy redirect port produces an actionable error", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const blocker = http.createServer(() => undefined);
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);

  await assert.rejects(auth.beginLogin(), /already in use/);
  assert.equal((await auth.status()).login.phase, "failed");
});

test("starting a second login replaces the first listener", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);

  const first = await auth.beginLogin();
  const second = await auth.beginLogin();
  t.after(() => auth.cancelPendingLogin());

  const firstState = new URL(first.authorizeUrl).searchParams.get("state");
  const secondState = new URL(second.authorizeUrl).searchParams.get("state");
  assert.notEqual(firstState, secondState);

  const stale = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=${firstState}`);
  assert.equal(stale.status, 400);

  const fresh = await fetch(`http://127.0.0.1:${port}/callback?code=${mock.authorizationCode}&state=${secondState}`);
  assert.equal(fresh.status, 200);
  await auth.waitForLogin();
  assert.equal((await auth.status()).connected, true);
});

test("logout forgets the tokens and releases the pending listener", async (t) => {
  const mock = await withMock(t);
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  await auth.setTokens({
    access_token: "a",
    refresh_token: "r",
    expires_at: Date.now() + 600_000,
    token_type: "bearer",
    obtained_at: Date.now(),
  });
  await auth.beginLogin();

  await auth.logout();

  const status = await auth.status();
  assert.equal(status.connected, false);
  assert.equal(status.login.phase, "idle");
  assert.equal(await new TokenStore(config.tokenFile).load(), null);
  // The port is free again, so a new login can bind it.
  await auth.beginLogin();
  await auth.cancelPendingLogin();
});

test("waitForLogin resolves immediately when no login is pending", async (t) => {
  const mock = await withMock(t);
  const auth = new AuthManager(await testConfig(t, mock));
  assert.equal((await auth.waitForLogin()).phase, "idle");
});
