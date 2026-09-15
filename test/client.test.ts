import assert from "node:assert/strict";
import test from "node:test";

import { AuthManager } from "../src/auth/authManager.js";
import { WhoopApiError, WhoopError } from "../src/errors.js";
import { WhoopClient, retryAfterDelay } from "../src/whoop/client.js";
import type { Cycle } from "../src/whoop/types.js";
import { testConfig } from "./helpers/env.js";
import { MockWhoop } from "./helpers/mockWhoop.js";

process.env.WHOOP_LOG_LEVEL = "silent";

async function connectedClient(
  t: import("node:test").TestContext,
  overrides: Record<string, string | undefined> = {},
): Promise<{ mock: MockWhoop; client: WhoopClient; auth: AuthManager }> {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock, overrides);
  const auth = new AuthManager(config);
  await auth.setTokens({
    access_token: mock.accessToken,
    refresh_token: mock.refreshToken,
    expires_at: Date.now() + 3_600_000,
    token_type: "bearer",
    obtained_at: Date.now(),
  });
  return { mock, client: new WhoopClient(config, auth), auth };
}

test("requests carry the bearer token and return parsed JSON", async (t) => {
  const { mock, client } = await connectedClient(t);
  const profile = await client.getProfile();

  assert.equal(profile.user_id, 42);
  assert.equal(profile.first_name, "Ada");
  assert.equal(mock.requestsFor("/v2/user/profile/basic").at(0)?.authorization, `Bearer ${mock.accessToken}`);
});

test("collection queries forward limit, start, end and the page cursor", async (t) => {
  const { mock, client } = await connectedClient(t);
  await client.getCycles({ limit: 5, start: "2026-09-10T00:00:00.000Z", end: "2026-09-15T00:00:00.000Z", nextToken: "3" });

  const request = mock.requestsFor("/v2/cycle").at(0);
  assert.deepEqual(request?.query, {
    limit: "5",
    start: "2026-09-10T00:00:00.000Z",
    end: "2026-09-15T00:00:00.000Z",
    nextToken: "3",
  });
});

test("empty and undefined query values are omitted", async (t) => {
  const { mock, client } = await connectedClient(t);
  await client.getCycles({ limit: 5, start: undefined, end: "" });
  assert.deepEqual(mock.requestsFor("/v2/cycle").at(0)?.query, { limit: "5" });
});

test("collectAll follows next_token until maxRecords is reached", async (t) => {
  const { mock, client } = await connectedClient(t);
  const page = await client.collectAll<Cycle>("/v2/cycle", { limit: 3, maxRecords: 8 });

  assert.equal(page.records.length, 8);
  assert.equal(new Set(page.records.map((cycle) => cycle.id)).size, 8);
  assert.ok(mock.requestsFor("/v2/cycle").length >= 3);
  assert.equal(page.next_token, "8");
});

test("collectAll stops when WHOOP runs out of pages", async (t) => {
  const { client } = await connectedClient(t);
  const page = await client.collectAll<Cycle>("/v2/cycle", { limit: 25, maxRecords: 100 });

  assert.equal(page.records.length, 10);
  assert.equal(page.next_token, undefined);
});

test("collectAll never asks WHOOP for more than 25 records per page", async (t) => {
  const { mock, client } = await connectedClient(t);
  await client.collectAll<Cycle>("/v2/cycle", { limit: 500, maxRecords: 10 });

  for (const request of mock.requestsFor("/v2/cycle")) {
    assert.ok(Number(request.query.limit) <= 25, `limit was ${request.query.limit}`);
  }
});

test("a 401 triggers a token refresh and the request is retried once", async (t) => {
  const { mock, client, auth } = await connectedClient(t);
  await auth.setTokens({
    access_token: "stale-access",
    refresh_token: mock.refreshToken,
    expires_at: Date.now() + 3_600_000,
    token_type: "bearer",
    obtained_at: Date.now(),
  });

  const profile = await client.getProfile();
  assert.equal(profile.user_id, 42);
  assert.equal(mock.requestsFor("/oauth/oauth2/token").length, 1);
  assert.equal(mock.requestsFor("/v2/user/profile/basic").length, 2);
});

test("a persistent 401 is reported instead of looping", async (t) => {
  const { mock, client } = await connectedClient(t);
  mock.enqueue("GET /developer/v2/user/profile/basic", { status: 401, body: { error: "unauthorized" } });
  mock.enqueue("GET /developer/v2/user/profile/basic", { status: 401, body: { error: "unauthorized" } });

  await assert.rejects(client.getProfile(), (error: unknown) => {
    assert.ok(error instanceof WhoopApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /whoop_login/);
    return true;
  });
});

test("a 429 is retried using the Retry-After header", async (t) => {
  const { mock, client } = await connectedClient(t);
  mock.enqueue("GET /developer/v2/user/profile/basic", {
    status: 429,
    body: { error: "rate_limited" },
    headers: { "retry-after": "0" },
  });

  const profile = await client.getProfile();
  assert.equal(profile.user_id, 42);
  assert.equal(mock.requestsFor("/v2/user/profile/basic").length, 2);
});

test("server errors are retried and then surfaced", async (t) => {
  const { mock, client } = await connectedClient(t, { WHOOP_MAX_RETRIES: "1" });
  mock.enqueue("GET /developer/v2/user/profile/basic", { status: 503, body: { error: "unavailable" } });
  mock.enqueue("GET /developer/v2/user/profile/basic", { status: 503, body: { error: "unavailable" } });

  await assert.rejects(client.getProfile(), (error: unknown) => {
    assert.ok(error instanceof WhoopApiError);
    assert.equal(error.status, 503);
    assert.match(error.message, /unavailable/i);
    return true;
  });
  assert.equal(mock.requestsFor("/v2/user/profile/basic").length, 2);
});

test("a 404 explains that WHOOP has no such record", async (t) => {
  const { client } = await connectedClient(t);
  await assert.rejects(client.getWorkout("11111111-0000-4000-8000-999999999999"), (error: unknown) => {
    assert.ok(error instanceof WhoopApiError);
    assert.equal(error.status, 404);
    assert.match(error.message, /no record with that identifier/);
    return true;
  });
});

test("a 403 points at the missing OAuth scope", async (t) => {
  const { mock, client } = await connectedClient(t);
  mock.enqueue("GET /developer/v2/activity/sleep", { status: 403, body: { error: "forbidden" } });

  await assert.rejects(client.getSleepCollection({ limit: 5 }), (error: unknown) => {
    assert.ok(error instanceof WhoopApiError);
    assert.match(error.message, /scope/);
    return true;
  });
});

test("an unreachable API is reported as a connectivity problem", async (t) => {
  const { mock, client } = await connectedClient(t, { WHOOP_MAX_RETRIES: "0" });
  await mock.close();

  await assert.rejects(client.getProfile(), (error: unknown) => {
    assert.ok(error instanceof WhoopError);
    assert.match(error.message, /Could not reach the WHOOP API/);
    return true;
  });
});

test("a non-JSON success body is reported clearly", async (t) => {
  const { mock, client } = await connectedClient(t);
  mock.enqueue("GET /developer/v2/user/profile/basic", { status: 200, raw: "<html>nope</html>" });

  await assert.rejects(client.getProfile(), (error: unknown) => {
    assert.ok(error instanceof WhoopError);
    assert.match(error.message, /non-JSON response/);
    return true;
  });
});

test("revokeAccess accepts an empty 204 body", async (t) => {
  const { mock, client } = await connectedClient(t);
  await client.revokeAccess();
  assert.equal(mock.requestsFor("/v2/user/access").at(0)?.method, "DELETE");
});

test("ids are URL-encoded so odd identifiers cannot break the path", async (t) => {
  const { mock, client } = await connectedClient(t);
  await assert.rejects(client.getSleep("a b/c"));
  assert.ok(mock.requests.some((request) => request.path === "/developer/v2/activity/sleep/a%20b%2Fc"));
});

test("cycle sub-resources hit the documented paths", async (t) => {
  const { mock, client } = await connectedClient(t);
  await client.getCycleRecovery(1010);
  await client.getCycleSleep(1010);

  const paths = mock.requests.map((request) => request.path);
  assert.ok(paths.includes("/developer/v2/cycle/1010/recovery"));
  assert.ok(paths.includes("/developer/v2/cycle/1010/sleep"));
});

test("retryAfterDelay understands seconds, dates and junk", () => {
  assert.equal(retryAfterDelay("2"), 2000);
  assert.equal(retryAfterDelay("0"), 0);
  assert.equal(retryAfterDelay(null), undefined);
  assert.equal(retryAfterDelay("soon"), undefined);
  assert.equal(retryAfterDelay("9999"), 20_000);
  const future = new Date(Date.now() + 5_000).toUTCString();
  const delay = retryAfterDelay(future) ?? 0;
  assert.ok(delay > 3_000 && delay <= 6_000, `delay was ${delay}`);
});
