import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAX_PAGE_LIMIT } from "../whoop/client.js";
import { dayRange, formatDuration, resolveRange } from "../whoop/dates.js";
import { average, digestCycle, digestRecovery, digestSleep, digestWorkout, round, sum } from "../whoop/format.js";
import type { Cycle, Recovery, Sleep, Workout } from "../whoop/types.js";
import { clampLimit, ok, optional, safe, type ToolContext } from "./shared.js";

export function registerInsightTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "whoop_daily_summary",
    {
      title: "WHOOP daily summary",
      description:
        "One call for a whole day: the cycle (day strain), the recovery score, the night's sleep and any " +
        'workouts. Use this for questions like "how did I sleep last night" or "how am I doing today".',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('Day to summarize as "YYYY-MM-DD" (UTC). Defaults to today.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ date }) =>
      safe(async () => {
        const range = dayRange(date);
        const cyclePage = await context.client.collectAll<Cycle>("/v2/cycle", {
          start: range.start,
          end: range.end,
          limit: MAX_PAGE_LIMIT,
          maxRecords: 10,
        });

        const cycle = cyclePage.records
          .slice()
          .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
          .at(0);

        const [recovery, sleep, workoutPage] = await Promise.all([
          cycle ? optional(context.client.getCycleRecovery(cycle.id)) : Promise.resolve(undefined),
          cycle ? optional(context.client.getCycleSleep(cycle.id)) : Promise.resolve(undefined),
          context.client.collectAll<Workout>("/v2/activity/workout", {
            start: range.start,
            end: range.end,
            limit: MAX_PAGE_LIMIT,
            maxRecords: 25,
          }),
        ]);

        const cycleDigest = cycle ? digestCycle(cycle) : undefined;
        const recoveryDigest = recovery ? digestRecovery(recovery) : undefined;
        const sleepDigest = sleep ? digestSleep(sleep) : undefined;
        const workouts = workoutPage.records.map(digestWorkout);

        const parts: string[] = [];
        if (recoveryDigest?.recovery_score !== undefined) parts.push(`recovery ${recoveryDigest.recovery_score}%`);
        if (cycleDigest?.strain !== undefined) parts.push(`day strain ${cycleDigest.strain}`);
        if (sleepDigest?.time_asleep) {
          parts.push(
            `slept ${sleepDigest.time_asleep}${
              sleepDigest.sleep_performance_percentage !== undefined
                ? ` (${sleepDigest.sleep_performance_percentage}% of need)`
                : ""
            }`,
          );
        }
        parts.push(`${workouts.length} workout(s)`);

        const summary = cycle
          ? `WHOOP summary for ${range.day}: ${parts.join(", ")}.`
          : `WHOOP has no cycle recorded for ${range.day} yet.`;

        return ok(summary, {
          date: range.day,
          cycle: cycleDigest,
          recovery: recoveryDigest,
          sleep: sleepDigest,
          workouts,
        });
      }),
  );

  server.registerTool(
    "whoop_summarize_range",
    {
      title: "Summarize a WHOOP date range",
      description:
        "Aggregate recovery, strain, sleep and workouts over a period and return averages, totals and the " +
        'best/worst days. Use this for trend questions such as "how was my last month".',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Number of days to look back from now (default 7). Ignored when start and end are given."),
        start: z.string().optional().describe('Start of the range, "YYYY-MM-DD" or ISO-8601.'),
        end: z.string().optional().describe('End of the range, "YYYY-MM-DD" (whole day) or ISO-8601.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum records to pull per data type (default 50)."),
        include_records: z
          .boolean()
          .optional()
          .describe("Include the individual records alongside the aggregates (default false)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      safe(async () => {
        const range = resolveRange({
          start: args.start,
          end: args.end,
          days: args.start && args.end ? undefined : (args.days ?? 7),
        });
        const maxRecords = clampLimit(args.limit ?? 50);
        const params = { start: range.start, end: range.end, limit: MAX_PAGE_LIMIT, maxRecords };

        const [recoveries, cycles, sleeps, workouts] = await Promise.all([
          context.client.collectAll<Recovery>("/v2/recovery", params),
          context.client.collectAll<Cycle>("/v2/cycle", params),
          context.client.collectAll<Sleep>("/v2/activity/sleep", params),
          context.client.collectAll<Workout>("/v2/activity/workout", params),
        ]);

        const recoveryDigests = recoveries.records.map(digestRecovery);
        const cycleDigests = cycles.records.map(digestCycle);
        const sleepDigests = sleeps.records.map(digestSleep);
        const workoutDigests = workouts.records.map(digestWorkout);

        const scoredRecoveries = recoveryDigests.filter((item) => item.recovery_score !== undefined);
        const nightSleeps = sleepDigests.filter((item) => item.nap !== true);

        const best = scoredRecoveries.reduce<(typeof scoredRecoveries)[number] | undefined>(
          (top, item) => (top === undefined || (item.recovery_score ?? 0) > (top.recovery_score ?? 0) ? item : top),
          undefined,
        );
        const worst = scoredRecoveries.reduce<(typeof scoredRecoveries)[number] | undefined>(
          (low, item) => (low === undefined || (item.recovery_score ?? 0) < (low.recovery_score ?? 0) ? item : low),
          undefined,
        );

        const totalSleepMinutes = sum(nightSleeps.map((item) => item.time_asleep_minutes), 0);
        const averageSleepMinutes = average(nightSleeps.map((item) => item.time_asleep_minutes), 1);
        const totalWorkoutMinutes = sum(workoutDigests.map((item) => item.duration_minutes), 0);

        const aggregates = {
          range,
          counts: {
            recoveries: recoveryDigests.length,
            cycles: cycleDigests.length,
            sleeps: sleepDigests.length,
            naps: sleepDigests.length - nightSleeps.length,
            workouts: workoutDigests.length,
          },
          recovery: {
            average_recovery_score: average(scoredRecoveries.map((item) => item.recovery_score), 0),
            average_hrv_rmssd_milli: average(recoveryDigests.map((item) => item.hrv_rmssd_milli)),
            average_resting_heart_rate: average(recoveryDigests.map((item) => item.resting_heart_rate), 0),
            best_day: best ? { cycle_id: best.cycle_id, recovery_score: best.recovery_score } : undefined,
            worst_day: worst ? { cycle_id: worst.cycle_id, recovery_score: worst.recovery_score } : undefined,
          },
          strain: {
            average_day_strain: average(cycleDigests.map((item) => item.strain), 2),
            max_day_strain: maxOf(cycleDigests.map((item) => item.strain)),
            total_calories_kcal: sum(cycleDigests.map((item) => item.calories_kcal), 0),
          },
          sleep: {
            average_time_asleep: averageSleepMinutes === undefined ? undefined : formatDuration(averageSleepMinutes * 60_000),
            average_time_asleep_minutes: average(nightSleeps.map((item) => item.time_asleep_minutes), 0),
            average_sleep_performance_percentage: average(nightSleeps.map((item) => item.sleep_performance_percentage), 0),
            average_sleep_efficiency_percentage: average(nightSleeps.map((item) => item.sleep_efficiency_percentage), 1),
            average_respiratory_rate: average(nightSleeps.map((item) => item.respiratory_rate)),
            total_time_asleep: totalSleepMinutes === undefined ? undefined : formatDuration(totalSleepMinutes * 60_000),
          },
          workouts: {
            count: workoutDigests.length,
            total_duration: totalWorkoutMinutes === undefined ? undefined : formatDuration(totalWorkoutMinutes * 60_000),
            total_calories_kcal: sum(workoutDigests.map((item) => item.calories_kcal), 0),
            average_strain: average(workoutDigests.map((item) => item.strain), 2),
            by_sport: countBySport(workoutDigests),
          },
        };

        const summary =
          `WHOOP summary${range.start && range.end ? ` for ${range.start.slice(0, 10)} → ${range.end.slice(0, 10)}` : ""}: ` +
          `avg recovery ${aggregates.recovery.average_recovery_score ?? "n/a"}%, ` +
          `avg day strain ${aggregates.strain.average_day_strain ?? "n/a"}, ` +
          `avg sleep ${aggregates.sleep.average_time_asleep ?? "n/a"}, ` +
          `${workoutDigests.length} workout(s).`;

        return ok(summary, {
          ...aggregates,
          records: args.include_records
            ? {
                recoveries: recoveryDigests,
                cycles: cycleDigests,
                sleeps: sleepDigests,
                workouts: workoutDigests,
              }
            : undefined,
        });
      }),
  );
}

function maxOf(values: Array<number | undefined>): number | undefined {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return undefined;
  return round(Math.max(...usable), 2);
}

function countBySport(workouts: Array<{ sport: string | undefined }>): Record<string, number> | undefined {
  if (workouts.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const workout of workouts) {
    const key = workout.sport ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
