import assert from "node:assert/strict";
import test from "node:test";

import { WhoopError } from "../src/errors.js";
import { dayRange, formatDuration, parseInstant, resolveRange } from "../src/whoop/dates.js";

test("a bare date becomes the start of that UTC day", () => {
  assert.equal(parseInstant("2026-09-15", "start", false), "2026-09-15T00:00:00.000Z");
});

test("a bare end date covers the whole day", () => {
  assert.equal(parseInstant("2026-09-15", "end", true), "2026-09-15T23:59:59.999Z");
});

test("full ISO timestamps are normalized, not shifted", () => {
  assert.equal(parseInstant("2026-09-15T12:30:00Z", "start", false), "2026-09-15T12:30:00.000Z");
  assert.equal(parseInstant("2026-09-15T12:30:00+02:00", "start", false), "2026-09-15T10:30:00.000Z");
});

test("unparseable dates raise a helpful error", () => {
  assert.throws(() => parseInstant("last tuesday", "start", false), (error: unknown) => {
    assert.ok(error instanceof WhoopError);
    assert.match(error.message, /YYYY-MM-DD/);
    return true;
  });
  assert.throws(() => parseInstant("2026-13-45", "start", false), WhoopError);
});

test("resolveRange derives the start from days", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const range = resolveRange({ days: 7 }, now);
  assert.equal(range.start, "2026-09-08T12:00:00.000Z");
  assert.equal(range.end, "2026-09-15T12:00:00.000Z");
});

test("resolveRange counts days back from an explicit end", () => {
  const range = resolveRange({ days: 2, end: "2026-09-10" }, new Date("2026-09-15T12:00:00.000Z"));
  assert.equal(range.end, "2026-09-10T23:59:59.999Z");
  assert.equal(range.start, "2026-09-08T23:59:59.999Z");
});

test("resolveRange keeps explicit bounds untouched", () => {
  const range = resolveRange({ start: "2026-09-01", end: "2026-09-02" });
  assert.deepEqual(range, { start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T23:59:59.999Z" });
});

test("resolveRange rejects an inverted range and non-positive days", () => {
  assert.throws(() => resolveRange({ start: "2026-09-10", end: "2026-09-01" }), WhoopError);
  assert.throws(() => resolveRange({ days: 0 }), WhoopError);
  assert.throws(() => resolveRange({ days: -3 }), WhoopError);
});

test("resolveRange with no input leaves the window to WHOOP", () => {
  assert.deepEqual(resolveRange({}), { start: undefined, end: undefined });
});

test("dayRange defaults to today and spans a full UTC day", () => {
  const range = dayRange("2026-09-15", new Date("2026-09-15T08:00:00.000Z"));
  assert.deepEqual(range, {
    day: "2026-09-15",
    start: "2026-09-15T00:00:00.000Z",
    end: "2026-09-15T23:59:59.999Z",
  });
  assert.equal(dayRange(undefined, new Date("2026-01-02T23:30:00.000Z")).day, "2026-01-02");
});

test("formatDuration renders hours and minutes", () => {
  assert.equal(formatDuration(27_000_000), "7h 30m");
  assert.equal(formatDuration(1_800_000), "30m");
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(undefined), undefined);
  assert.equal(formatDuration(Number.NaN), undefined);
});
