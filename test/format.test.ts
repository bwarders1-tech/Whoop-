import assert from "node:assert/strict";
import test from "node:test";

import {
  average,
  digestBodyMeasurement,
  digestCycle,
  digestRecovery,
  digestSleep,
  digestWorkout,
  kilojoulesToKcal,
  round,
  sum,
} from "../src/whoop/format.js";
import { buildCycles, buildRecoveries, buildSleeps, buildWorkouts } from "./helpers/fixtures.js";

test("digestCycle derives the day and converts kilojoules to calories", () => {
  const cycle = buildCycles()[0]!;
  const digest = digestCycle(cycle);

  assert.equal(digest.cycle_id, cycle.id);
  assert.equal(digest.day, "2026-09-15");
  assert.equal(digest.strain, 8);
  assert.equal(digest.calories_kcal, 1912);
  assert.equal(digest.max_heart_rate, 150);
});

test("digestCycle tolerates an unscored cycle", () => {
  const digest = digestCycle({ id: 7, start: "2026-09-15T04:00:00.000Z", score_state: "PENDING_SCORE", score: null });
  assert.equal(digest.strain, undefined);
  assert.equal(digest.calories_kcal, undefined);
  assert.equal(digest.score_state, "PENDING_SCORE");
  assert.equal(digest.end, null);
});

test("digestRecovery rounds the scores it reports", () => {
  const digest = digestRecovery(buildRecoveries()[1]!);
  assert.equal(digest.recovery_score, 45);
  assert.equal(digest.hrv_rmssd_milli, 56.5);
  assert.equal(digest.resting_heart_rate, 51);
  assert.equal(digest.user_calibrating, false);
});

test("digestRecovery survives a missing score object", () => {
  const digest = digestRecovery({ cycle_id: 1, score_state: "UNSCORABLE" });
  assert.equal(digest.recovery_score, undefined);
  assert.equal(digest.sleep_id, undefined);
});

test("digestSleep computes time asleep as in-bed minus awake", () => {
  const digest = digestSleep(buildSleeps()[0]!);
  assert.equal(digest.time_in_bed, "7h 30m");
  assert.equal(digest.time_asleep, "7h 0m");
  assert.equal(digest.time_asleep_minutes, 420);
  assert.equal(digest.rem_sleep, "1h 45m");
  assert.equal(digest.deep_sleep, "1h 30m");
  assert.equal(digest.awake, "30m");
  assert.equal(digest.sleep_performance_percentage, 80);
  assert.equal(digest.sleep_needed, "8h 15m");
  assert.equal(digest.day, "2026-09-15");
});

test("digestSleep falls back to the clock time in bed when stages are missing", () => {
  const digest = digestSleep({
    id: "sleep-1",
    start: "2026-09-14T23:00:00.000Z",
    end: "2026-09-15T06:00:00.000Z",
    score_state: "PENDING_SCORE",
  });
  assert.equal(digest.time_in_bed, "7h 0m");
  assert.equal(digest.time_asleep, undefined);
  assert.equal(digest.sleep_needed, undefined);
});

test("digestWorkout reports duration, zones and distance", () => {
  const digest = digestWorkout(buildWorkouts()[0]!);
  assert.equal(digest.sport, "running");
  assert.equal(digest.duration, "1h 0m");
  assert.equal(digest.duration_minutes, 60);
  assert.equal(digest.strain, 9);
  assert.equal(digest.calories_kcal, 598);
  assert.equal(digest.distance_meter, 8000);
  assert.equal(digest.zone_durations?.zone_5, "1m");
});

test("digestWorkout falls back to the numeric sport id of API v1 payloads", () => {
  const digest = digestWorkout({
    id: "w1",
    start: "2026-09-15T17:00:00.000Z",
    end: "2026-09-15T17:30:00.000Z",
    sport_id: 45,
  });
  assert.equal(digest.sport, "sport_id 45");
  assert.equal(digest.duration, "30m");
  assert.equal(digest.zone_durations, undefined);
});

test("digestBodyMeasurement adds imperial units", () => {
  const digest = digestBodyMeasurement({ height_meter: 1.7526, weight_kilogram: 68.0389, max_heart_rate: 191 });
  assert.equal(digest.height_feet_inches, "5' 9\"");
  assert.equal(digest.weight_pounds, 150);
  assert.equal(digest.weight_kilogram, 68);
});

test("numeric helpers ignore missing values", () => {
  assert.equal(average([1, undefined, 3]), 2);
  assert.equal(average([]), undefined);
  assert.equal(average([undefined]), undefined);
  assert.equal(sum([1.5, undefined, 2.5], 1), 4);
  assert.equal(sum([]), undefined);
  assert.equal(round(undefined), undefined);
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(kilojoulesToKcal(undefined), undefined);
  assert.equal(kilojoulesToKcal(4184), 1000);
});
