import assert from "node:assert/strict";
import test from "node:test";

import { freePort } from "./helpers/env.js";
import { callTool, startHarness } from "./helpers/mcp.js";

process.env.WHOOP_LOG_LEVEL = "silent";

const EXPECTED_TOOLS = [
  "whoop_auth_status",
  "whoop_login",
  "whoop_logout",
  "whoop_get_profile",
  "whoop_get_body_measurement",
  "whoop_list_cycles",
  "whoop_get_cycle",
  "whoop_list_recoveries",
  "whoop_get_cycle_recovery",
  "whoop_list_sleep",
  "whoop_get_sleep",
  "whoop_get_cycle_sleep",
  "whoop_list_workouts",
  "whoop_get_workout",
  "whoop_daily_summary",
  "whoop_summarize_range",
];

test("the server advertises every WHOOP tool with a description and a schema", async (t) => {
  const { client } = await startHarness(t);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("the server exposes the morning briefing prompt", async (t) => {
  const { client } = await startHarness(t);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((prompt) => prompt.name), ["whoop_morning_briefing"]);

  const prompt = await client.getPrompt({ name: "whoop_morning_briefing" });
  const content = prompt.messages[0]?.content as { type: string; text?: string };
  assert.match(String(content.text), /whoop_daily_summary/);
});

test("whoop_auth_status reports the environment-provided connection", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_auth_status");

  assert.equal(result.isError, false);
  assert.equal(result.data.connected, true);
  assert.equal(result.data.tokenSource, "environment");
  assert.match(result.text, /Connected to WHOOP/);
});

test("whoop_auth_status explains an unconfigured extension", async (t) => {
  const { client } = await startHarness(t, {
    WHOOP_ACCESS_TOKEN: "",
    WHOOP_CLIENT_ID: "",
    WHOOP_CLIENT_SECRET: "",
  });
  const result = await callTool(client, "whoop_auth_status");

  assert.equal(result.data.connected, false);
  assert.match(result.text, /WHOOP_CLIENT_ID/);
});

test("data tools fail with a login hint when nothing is connected", async (t) => {
  const { client } = await startHarness(t, { WHOOP_ACCESS_TOKEN: "" });
  const result = await callTool(client, "whoop_get_profile");

  assert.equal(result.isError, true);
  assert.match(result.text, /whoop_login/);
});

test("whoop_login returns an authorization URL without blocking", async (t) => {
  const port = await freePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { client } = await startHarness(t, { WHOOP_REDIRECT_URI: redirectUri });
  const result = await callTool(client, "whoop_login", { open_browser: false });

  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /Open this URL/);
  const url = new URL(result.data.authorize_url);
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.ok((url.searchParams.get("state") ?? "").length >= 8);

  // The listener is live and answers the callback.
  const state = url.searchParams.get("state");
  const callback = await fetch(`${redirectUri}?code=test-auth-code&state=${state}`);
  assert.equal(callback.status, 200);

  const status = await callTool(client, "whoop_auth_status");
  assert.equal(status.data.connected, true);
  assert.equal(status.data.login.phase, "completed");

  await callTool(client, "whoop_logout");
});

test("whoop_get_profile returns the connected member", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_get_profile");

  assert.equal(result.isError, false);
  assert.equal(result.data.user_id, 42);
  assert.match(result.text, /Ada Lovelace/);
});

test("whoop_get_body_measurement adds imperial units", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_get_body_measurement");

  assert.equal(result.data.max_heart_rate, 191);
  assert.equal(result.data.weight_pounds, 150);
});

test("whoop_list_cycles honours the days lookback and the limit", async (t) => {
  const { mock, client } = await startHarness(t);
  const result = await callTool(client, "whoop_list_cycles", { days: 30, limit: 4 });

  assert.equal(result.data.count, 4);
  assert.equal(result.data.cycles.length, 4);
  assert.equal(result.data.cycles[0].cycle_id, 1010);
  assert.ok(result.data.range.start < result.data.range.end);
  assert.ok(mock.requestsFor("/v2/cycle").length >= 1);
});

test("whoop_list_cycles defaults to ten records", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_list_cycles", {});
  assert.equal(result.data.count, 10);
});

test("whoop_get_cycle returns a single cycle", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_get_cycle", { cycle_id: 1008 });

  assert.equal(result.data.cycle_id, 1008);
  assert.equal(result.data.strain, 9);
});

test("whoop_get_cycle reports an unknown id as a tool error", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_get_cycle", { cycle_id: 999999 });

  assert.equal(result.isError, true);
  assert.match(result.text, /no record with that identifier/);
});

test("whoop_list_recoveries returns HRV and resting heart rate", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_list_recoveries", { days: 7, limit: 3 });

  assert.equal(result.data.count, 3);
  assert.equal(result.data.recoveries[0].recovery_score, 40);
  assert.equal(result.data.recoveries[0].hrv_rmssd_milli, 55.5);
});

test("whoop_get_cycle_recovery and whoop_get_cycle_sleep follow the cycle", async (t) => {
  const { client } = await startHarness(t);
  const recovery = await callTool(client, "whoop_get_cycle_recovery", { cycle_id: 1010 });
  const sleep = await callTool(client, "whoop_get_cycle_sleep", { cycle_id: 1010 });

  assert.equal(recovery.data.cycle_id, 1010);
  assert.equal(sleep.data.sleep_id, recovery.data.sleep_id);
  assert.equal(sleep.data.time_asleep, "7h 0m");
});

test("whoop_list_sleep and whoop_get_sleep agree", async (t) => {
  const { client } = await startHarness(t);
  const list = await callTool(client, "whoop_list_sleep", { days: 3, limit: 2 });
  assert.equal(list.data.count, 2);

  const single = await callTool(client, "whoop_get_sleep", { sleep_id: list.data.sleeps[0].sleep_id });
  assert.equal(single.data.sleep_id, list.data.sleeps[0].sleep_id);
  assert.equal(single.data.sleep_efficiency_percentage, 92.5);
});

test("whoop_list_workouts and whoop_get_workout agree", async (t) => {
  const { client } = await startHarness(t);
  const list = await callTool(client, "whoop_list_workouts", { days: 5, limit: 2 });
  assert.equal(list.data.count, 2);
  assert.equal(list.data.workouts[0].sport, "running");

  const single = await callTool(client, "whoop_get_workout", { workout_id: list.data.workouts[1].workout_id });
  assert.equal(single.data.workout_id, list.data.workouts[1].workout_id);
  assert.equal(single.data.duration, "1h 0m");
});

test("whoop_daily_summary combines cycle, recovery, sleep and workouts", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_daily_summary", { date: "2026-09-15" });

  assert.equal(result.isError, false);
  assert.equal(result.data.date, "2026-09-15");
  assert.equal(result.data.cycle.cycle_id, 1010);
  assert.equal(result.data.recovery.recovery_score, 40);
  assert.equal(result.data.sleep.time_asleep, "7h 0m");
  assert.equal(result.data.workouts.length, 1);
  assert.match(result.text, /recovery 40%/);
  assert.match(result.text, /day strain 8/);
});

test("whoop_daily_summary says so when WHOOP has no data for the day", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_daily_summary", { date: "2020-01-01" });

  assert.equal(result.isError, false);
  assert.match(result.text, /no cycle recorded for 2020-01-01/);
  assert.equal(result.data.cycle, undefined);
  assert.deepEqual(result.data.workouts, []);
});

test("whoop_daily_summary tolerates a cycle whose recovery is not scored yet", async (t) => {
  const { mock, client } = await startHarness(t);
  mock.enqueue("GET /developer/v2/cycle/1010/recovery", { status: 404, body: { error: "not_found" } });

  const result = await callTool(client, "whoop_daily_summary", { date: "2026-09-15" });
  assert.equal(result.isError, false);
  assert.equal(result.data.recovery, undefined);
  assert.equal(result.data.cycle.cycle_id, 1010);
});

test("whoop_summarize_range aggregates the window", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_summarize_range", { start: "2026-09-01", end: "2026-09-15" });

  assert.equal(result.isError, false);
  assert.deepEqual(result.data.counts, { recoveries: 10, cycles: 10, sleeps: 10, naps: 0, workouts: 10 });
  assert.equal(result.data.recovery.average_recovery_score, 63);
  assert.equal(result.data.recovery.best_day.recovery_score, 85);
  assert.equal(result.data.recovery.worst_day.recovery_score, 40);
  assert.equal(result.data.strain.average_day_strain, 10.25);
  assert.equal(result.data.strain.max_day_strain, 12.5);
  assert.equal(result.data.sleep.average_time_asleep, "7h 0m");
  assert.equal(result.data.sleep.total_time_asleep, "70h 0m");
  assert.equal(result.data.workouts.count, 10);
  assert.deepEqual(result.data.workouts.by_sport, { running: 4, weightlifting: 3, cycling: 3 });
  assert.equal(result.data.records, undefined);
  assert.match(result.text, /avg recovery 63%/);
});

test("whoop_summarize_range can include the underlying records", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_summarize_range", { days: 30, include_records: true, limit: 5 });

  assert.equal(result.data.records.recoveries.length, 5);
  assert.equal(result.data.records.workouts.length, 5);
});

test("whoop_summarize_range defaults to the last seven days", async (t) => {
  const { mock, client } = await startHarness(t);
  await callTool(client, "whoop_summarize_range", {});

  const request = mock.requestsFor("/v2/recovery").at(0);
  const start = Date.parse(String(request?.query.start));
  const end = Date.parse(String(request?.query.end));
  assert.ok(Math.abs(end - start - 7 * 86_400_000) < 1000);
});

test("an unparseable date becomes a readable tool error, not a crash", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_list_sleep", { start: "last tuesday" });

  assert.equal(result.isError, true);
  assert.match(result.text, /YYYY-MM-DD/);
});

test("an inverted range is rejected", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_list_cycles", { start: "2026-09-10", end: "2026-09-01" });

  assert.equal(result.isError, true);
  assert.match(result.text, /after the end date/);
});

test("schema violations are rejected by the protocol layer", async (t) => {
  const { client } = await startHarness(t);
  const result = (await client.callTool({ name: "whoop_list_cycles", arguments: { days: 0 } })) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };

  assert.equal(result.isError, true);
  assert.match(String(result.content?.[0]?.text), /days/);
});

test("whoop_logout clears the connection", async (t) => {
  const { client } = await startHarness(t);
  const result = await callTool(client, "whoop_logout", {});

  assert.equal(result.isError, false);
  assert.match(result.text, /Removed the stored tokens/);
});

test("whoop_logout can also revoke the grant with WHOOP", async (t) => {
  const { mock, client } = await startHarness(t);
  const result = await callTool(client, "whoop_logout", { revoke: true });

  assert.equal(result.isError, false);
  assert.match(result.text, /Revoked the WHOOP access grant/);
  assert.equal(mock.requestsFor("/v2/user/access").at(0)?.method, "DELETE");
});
