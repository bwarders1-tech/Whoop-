import assert from "node:assert/strict";
import test from "node:test";

import { AuthManager } from "../src/auth/authManager.js";
import { runDoctor } from "../src/doctor.js";
import { freePort, testConfig } from "./helpers/env.js";
import { MockWhoop } from "./helpers/mockWhoop.js";

process.env.WHOOP_LOG_LEVEL = "silent";

test("doctor passes once everything is configured and connected", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const port = await freePort();
  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const auth = new AuthManager(config);
  await auth.setTokens({
    access_token: mock.accessToken,
    refresh_token: mock.refreshToken,
    expires_at: Date.now() + 3_600_000,
    token_type: "bearer",
    obtained_at: Date.now(),
  });

  const report = await runDoctor(config, auth, { envFile: "/tmp/.env" });
  const text = report.lines.join("\n");

  assert.equal(report.ok, true, text);
  assert.match(text, /API reachable:  yes \(HTTP 401 from 127\.0\.0\.1/);
  assert.match(text, /Live API call:  ok — connected as Ada Lovelace/);
  assert.match(text, /Everything checks out/);
});

test("doctor lists every missing piece and masks the secrets it shows", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock, { WHOOP_CLIENT_ID: "", WHOOP_CLIENT_SECRET: "" });

  const report = await runDoctor(config, new AuthManager(config));
  const text = report.lines.join("\n");

  assert.equal(report.ok, false);
  assert.match(text, /WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET/);
  assert.match(text, /whoop-mcp login/);
  assert.doesNotMatch(text, /test-client-secret/);
});

test("doctor reports a redirect port that is already taken", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const port = await freePort();
  const blocker = (await import("node:http")).createServer(() => undefined);
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const config = await testConfig(t, mock, { WHOOP_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const report = await runDoctor(config, new AuthManager(config));

  assert.equal(report.ok, false);
  assert.match(report.lines.join("\n"), /is not available \(EADDRINUSE\)/);
});

test("doctor flags an unexpected status as an intercepting proxy", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock);
  mock.enqueue("GET /developer/v2/user/profile/basic", { status: 403, body: { error: "blocked by policy" } });

  const report = await runDoctor(config, new AuthManager(config));
  const text = report.lines.join("\n");

  assert.equal(report.ok, false);
  assert.match(text, /unexpected — HTTP 403/);
  assert.match(text, /proxy or firewall is most likely intercepting/);
});

test("doctor reports an unreachable API without throwing", async (t) => {
  const mock = await MockWhoop.start();
  const config = await testConfig(t, mock);
  await mock.close();

  const report = await runDoctor(config, new AuthManager(config));
  assert.equal(report.ok, false);
  assert.match(report.lines.join("\n"), /API reachable:  no —/);
});

test("doctor shows the masked credentials it is using", async (t) => {
  const mock = await MockWhoop.start();
  t.after(() => mock.close());
  const config = await testConfig(t, mock, {
    WHOOP_CLIENT_ID: "1c0ffee0-0000-4000-8000-abcdefabcdef",
    WHOOP_CLIENT_SECRET: "0".repeat(64),
  });

  const text = (await runDoctor(config, new AuthManager(config))).lines.join("\n");
  assert.match(text, /Client ID:      1c0f…cdef \(36 chars\)/);
  assert.match(text, /Client secret:  0000…0000 \(64 chars\)/);
});
