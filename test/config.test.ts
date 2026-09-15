import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REDIRECT_URI,
  DEFAULT_SCOPES,
  loadConfig,
  requireOAuthCredentials,
} from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";

test("loadConfig falls back to the documented WHOOP defaults", () => {
  const config = loadConfig({ WHOOP_LOG_LEVEL: "silent" });
  assert.equal(config.apiBaseUrl, DEFAULT_API_BASE_URL);
  assert.equal(config.redirectUri, DEFAULT_REDIRECT_URI);
  assert.deepEqual(config.scopes, DEFAULT_SCOPES);
  assert.equal(config.tokenFile, path.join(os.homedir(), ".whoop-mcp", "tokens.json"));
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.maxRetries, 3);
});

test("loadConfig trims blank credentials to undefined", () => {
  const config = loadConfig({ WHOOP_CLIENT_ID: "   ", WHOOP_CLIENT_SECRET: "secret", WHOOP_LOG_LEVEL: "silent" });
  assert.equal(config.clientId, undefined);
  assert.equal(config.clientSecret, "secret");
});

test("loadConfig strips a trailing slash from the API base URL", () => {
  const config = loadConfig({ WHOOP_API_BASE_URL: "https://example.test/developer/", WHOOP_LOG_LEVEL: "silent" });
  assert.equal(config.apiBaseUrl, "https://example.test/developer");
});

test("loadConfig always keeps the offline scope so refresh tokens are issued", () => {
  const config = loadConfig({ WHOOP_SCOPES: "read:sleep,read:recovery", WHOOP_LOG_LEVEL: "silent" });
  assert.deepEqual(config.scopes, ["offline", "read:sleep", "read:recovery"]);
});

test("loadConfig de-duplicates scopes", () => {
  const config = loadConfig({ WHOOP_SCOPES: "offline read:sleep read:sleep", WHOOP_LOG_LEVEL: "silent" });
  assert.deepEqual(config.scopes, ["offline", "read:sleep"]);
});

test("loadConfig rejects a malformed URL", () => {
  assert.throws(() => loadConfig({ WHOOP_API_BASE_URL: "not-a-url", WHOOP_LOG_LEVEL: "silent" }), ConfigurationError);
  assert.throws(() => loadConfig({ WHOOP_TOKEN_URL: "ftp://example.test", WHOOP_LOG_LEVEL: "silent" }), ConfigurationError);
});

test("loadConfig clamps out-of-range numbers instead of failing", () => {
  const config = loadConfig({
    WHOOP_REQUEST_TIMEOUT_MS: "999999999",
    WHOOP_MAX_RETRIES: "-4",
    WHOOP_LOG_LEVEL: "silent",
  });
  assert.equal(config.requestTimeoutMs, 600_000);
  assert.equal(config.maxRetries, 0);
});

test("loadConfig expands ~ in the token file path", () => {
  const config = loadConfig({ WHOOP_TOKEN_FILE: "~/whoop/tokens.json", WHOOP_LOG_LEVEL: "silent" });
  assert.equal(config.tokenFile, path.join(os.homedir(), "whoop", "tokens.json"));
});

test("requireOAuthCredentials explains what is missing", () => {
  const config = loadConfig({ WHOOP_LOG_LEVEL: "silent" });
  assert.throws(() => requireOAuthCredentials(config), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, /WHOOP_CLIENT_ID/);
    return true;
  });
});
