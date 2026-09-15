import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { TokenStore, type StoredTokens } from "../src/auth/tokenStore.js";
import { tempDir } from "./helpers/env.js";

process.env.WHOOP_LOG_LEVEL = "silent";

function sampleTokens(): StoredTokens {
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: Date.now() + 3_600_000,
    token_type: "bearer",
    scope: "offline read:sleep",
    obtained_at: Date.now(),
  };
}

test("save writes a 0600 file inside a created directory and load round-trips it", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "nested", "tokens.json");
  const store = new TokenStore(file);
  const tokens = sampleTokens();

  await store.save(tokens);
  const loaded = await store.load();

  assert.deepEqual(loaded, tokens);
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("load returns null when there is no token file", async (t) => {
  const dir = await tempDir(t);
  const store = new TokenStore(path.join(dir, "missing.json"));
  assert.equal(await store.load(), null);
});

test("load ignores a corrupt or incomplete token file instead of throwing", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "tokens.json");
  const store = new TokenStore(file);

  await fs.writeFile(file, "{not json");
  assert.equal(await store.load(), null);

  await fs.writeFile(file, JSON.stringify({ refresh_token: "only-refresh" }));
  assert.equal(await store.load(), null);

  await fs.writeFile(file, JSON.stringify({ access_token: "a", expires_at: "soon" }));
  assert.equal(await store.load(), null);
});

test("load fills in defaults for optional fields", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "tokens.json");
  await fs.writeFile(file, JSON.stringify({ access_token: "a", expires_at: 1234 }));

  const loaded = await new TokenStore(file).load();
  assert.equal(loaded?.token_type, "bearer");
  assert.equal(loaded?.refresh_token, undefined);
  assert.equal(typeof loaded?.obtained_at, "number");
});

test("save overwrites an existing file and leaves no temp files behind", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "tokens.json");
  const store = new TokenStore(file);

  await store.save(sampleTokens());
  await store.save({ ...sampleTokens(), access_token: "access-2" });

  assert.equal((await store.load())?.access_token, "access-2");
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ["tokens.json"]);
});

test("clear removes the file and is safe to call twice", async (t) => {
  const dir = await tempDir(t);
  const store = new TokenStore(path.join(dir, "tokens.json"));
  await store.save(sampleTokens());
  await store.clear();
  await store.clear();
  assert.equal(await store.load(), null);
});
