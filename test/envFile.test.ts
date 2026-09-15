import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { envFileCandidates, loadEnvFile, parseEnvFile } from "../src/envFile.js";
import { tempDir } from "./helpers/env.js";

process.env.WHOOP_LOG_LEVEL = "silent";

test("parseEnvFile reads plain, quoted and exported assignments", () => {
  const parsed = parseEnvFile(
    [
      "# a comment",
      "",
      "WHOOP_CLIENT_ID=1c0ffee0-0000-4000-8000-abcdefabcdef",
      'WHOOP_CLIENT_SECRET="quoted-secret"',
      "export WHOOP_REDIRECT_URI='http://localhost:8788/callback'",
      "WHOOP_LOG_LEVEL=debug   # inline comment",
      "  WHOOP_MAX_RETRIES = 5  ",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    WHOOP_CLIENT_ID: "1c0ffee0-0000-4000-8000-abcdefabcdef",
    WHOOP_CLIENT_SECRET: "quoted-secret",
    WHOOP_REDIRECT_URI: "http://localhost:8788/callback",
    WHOOP_LOG_LEVEL: "debug",
    WHOOP_MAX_RETRIES: "5",
  });
});

test("parseEnvFile keeps a # that is part of an unquoted value", () => {
  assert.deepEqual(parseEnvFile("WHOOP_CLIENT_SECRET=abc#def"), { WHOOP_CLIENT_SECRET: "abc#def" });
});

test("parseEnvFile unescapes double-quoted values only", () => {
  assert.deepEqual(parseEnvFile('A="line\\nbreak"\nB=\'line\\nbreak\''), { A: "line\nbreak", B: "line\\nbreak" });
});

test("parseEnvFile skips junk lines and invalid keys", () => {
  assert.deepEqual(parseEnvFile("no-equals-sign\n=novalue\n1BAD=x\nGOOD=y"), { GOOD: "y" });
});

test("loadEnvFile fills in only the values that are not already set", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, ".env");
  await fs.writeFile(file, "WHOOP_CLIENT_ID=from-file\nWHOOP_CLIENT_SECRET=from-file-secret\n");

  const target: NodeJS.ProcessEnv = { WHOOP_ENV_FILE: file, WHOOP_CLIENT_ID: "from-environment" };
  const used = loadEnvFile(target);

  assert.equal(used, file);
  assert.equal(target.WHOOP_CLIENT_ID, "from-environment");
  assert.equal(target.WHOOP_CLIENT_SECRET, "from-file-secret");
});

test("loadEnvFile treats an empty existing value as unset", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, ".env");
  await fs.writeFile(file, "WHOOP_CLIENT_ID=from-file\n");

  const target: NodeJS.ProcessEnv = { WHOOP_ENV_FILE: file, WHOOP_CLIENT_ID: "" };
  loadEnvFile(target);
  assert.equal(target.WHOOP_CLIENT_ID, "from-file");
});

test("loadEnvFile is a no-op when no file exists", async (t) => {
  const dir = await tempDir(t);
  const target: NodeJS.ProcessEnv = { WHOOP_ENV_FILE: path.join(dir, "absent.env") };
  assert.equal(loadEnvFile(target), undefined);
});

test("envFileCandidates prefers WHOOP_ENV_FILE, then the working directory", () => {
  assert.deepEqual(envFileCandidates({ WHOOP_ENV_FILE: "/tmp/custom.env" }), ["/tmp/custom.env"]);
  const defaults = envFileCandidates({});
  assert.equal(defaults[0], path.resolve(process.cwd(), ".env"));
  assert.match(String(defaults[1]), /\.whoop-mcp[/\\]\.env$/);
});
