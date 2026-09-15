import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthorizeUrl, createState, exchangeAuthorizationCode, refreshAccessToken, toStoredTokens } from "../src/auth/oauth.js";
import { OAuthError } from "../src/errors.js";
import { testConfig } from "./helpers/env.js";
import { MockWhoop } from "./helpers/mockWhoop.js";

process.env.WHOOP_LOG_LEVEL = "silent";

test("buildAuthorizeUrl includes every parameter WHOOP requires", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);

  const url = new URL(buildAuthorizeUrl(config, "state-value-1234"));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("state"), "state-value-1234");
  assert.equal(url.searchParams.get("scope"), config.scopes.join(" "));
});

test("createState is long enough for WHOOP and not repeated", () => {
  const first = createState();
  const second = createState();
  assert.ok(first.length >= 8);
  assert.notEqual(first, second);
});

test("exchangeAuthorizationCode stores the tokens with an absolute expiry", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);

  const before = Date.now();
  const tokens = await exchangeAuthorizationCode(config, {
    code: mock.authorizationCode,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  });

  assert.equal(tokens.access_token, mock.accessToken);
  assert.equal(tokens.refresh_token, mock.refreshToken);
  assert.ok(tokens.expires_at >= before + 3_600_000);
  const request = mock.requestsFor("/oauth/oauth2/token").at(-1);
  const body = new URLSearchParams(request?.body ?? "");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("redirect_uri"), config.redirectUri);
});

test("a rejected authorization code surfaces the invalid_grant hint", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);

  await assert.rejects(
    exchangeAuthorizationCode(config, { code: "wrong", clientId: "id", clientSecret: "secret" }),
    (error: unknown) => {
      assert.ok(error instanceof OAuthError);
      assert.equal(error.status, 400);
      assert.match(error.message, /invalid_grant/);
      assert.match(error.message, /whoop_login/);
      return true;
    },
  );
});

test("bad client credentials are reported as such", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);
  mock.enqueue("POST /oauth/oauth2/token", { status: 401, body: { error: "invalid_client" } });

  await assert.rejects(
    exchangeAuthorizationCode(config, { code: mock.authorizationCode, clientId: "id", clientSecret: "secret" }),
    (error: unknown) => {
      assert.ok(error instanceof OAuthError);
      assert.match(error.message, /WHOOP_CLIENT_ID/);
      return true;
    },
  );
});

test("refreshAccessToken asks for the offline scope so a new refresh token comes back", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);

  const tokens = await refreshAccessToken(config, {
    refreshToken: mock.refreshToken,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  });

  assert.equal(tokens.access_token, mock.accessToken);
  const body = new URLSearchParams(mock.requestsFor("/oauth/oauth2/token").at(-1)?.body ?? "");
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("scope"), "offline");
});

test("refreshAccessToken keeps the old refresh token when WHOOP omits a new one", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);
  mock.enqueue("POST /oauth/oauth2/token", {
    status: 200,
    body: { access_token: "fresh-access", expires_in: 3600, token_type: "bearer" },
  });

  const tokens = await refreshAccessToken(config, {
    refreshToken: "refresh-token-1",
    clientId: "id",
    clientSecret: "secret",
  });

  assert.equal(tokens.access_token, "fresh-access");
  assert.equal(tokens.refresh_token, "refresh-token-1");
});

test("a non-JSON token response is reported clearly", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);
  mock.enqueue("POST /oauth/oauth2/token", { status: 200, raw: "<html>maintenance</html>" });

  await assert.rejects(
    refreshAccessToken(config, { refreshToken: "refresh-token-1", clientId: "id", clientSecret: "secret" }),
    (error: unknown) => {
      assert.ok(error instanceof OAuthError);
      assert.match(error.message, /non-JSON token response/);
      return true;
    },
  );
});

test("an unreachable token endpoint produces a network error, not a crash", async (t) => {
  const mock = await MockWhoop.start();
  const config = await testConfig(t, mock);
  await mock.close();

  await assert.rejects(
    refreshAccessToken(config, { refreshToken: "refresh-token-1", clientId: "id", clientSecret: "secret" }),
    (error: unknown) => {
      assert.ok(error instanceof OAuthError);
      assert.match(error.message, /Could not reach the WHOOP token endpoint/);
      return true;
    },
  );
});

test("toStoredTokens defaults a missing expires_in to one hour", () => {
  const now = Date.parse("2026-09-15T00:00:00.000Z");
  const tokens = toStoredTokens({ access_token: "a" }, now);
  assert.equal(tokens.expires_at, now + 3_600_000);
  assert.equal(tokens.token_type, "bearer");
});

test("toStoredTokens rejects a payload without an access token", () => {
  assert.throws(() => toStoredTokens({ refresh_token: "r" }), OAuthError);
  assert.throws(() => toStoredTokens("nope"), OAuthError);
});
