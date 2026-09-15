import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAX_PAGE_LIMIT } from "../whoop/client.js";
import { resolveRange } from "../whoop/dates.js";
import {
  digestBodyMeasurement,
  digestCycle,
  digestProfile,
  digestRecovery,
  digestSleep,
  digestWorkout,
} from "../whoop/format.js";
import type { Cycle, Recovery, Sleep, Workout } from "../whoop/types.js";
import { clampLimit, ok, rangeShape, safe, type ToolContext } from "./shared.js";

export function registerDataTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "whoop_get_profile",
    {
      title: "WHOOP profile",
      description: "Get the connected WHOOP member's basic profile (user id, name, email).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      safe(async () => {
        const profile = await context.client.getProfile();
        const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
        return ok(`WHOOP profile${name ? ` for ${name}` : ""}.`, digestProfile(profile));
      }),
  );

  server.registerTool(
    "whoop_get_body_measurement",
    {
      title: "WHOOP body measurements",
      description: "Get the member's height, weight and WHOOP-estimated max heart rate.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      safe(async () => {
        const body = await context.client.getBodyMeasurement();
        return ok("WHOOP body measurements.", digestBodyMeasurement(body));
      }),
  );

  server.registerTool(
    "whoop_list_cycles",
    {
      title: "List WHOOP physiological cycles",
      description:
        "List WHOOP cycles (a cycle is roughly one day of strain, from wake to wake) with day strain, " +
        "average and max heart rate and calories burned. Use it for strain history and to get cycle ids.",
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      safe(async () => {
        const range = resolveRange(args);
        const limit = clampLimit(args.limit);
        const page = await context.client.collectAll<Cycle>("/v2/cycle", {
          ...range,
          limit: Math.min(limit, MAX_PAGE_LIMIT),
          maxRecords: limit,
          nextToken: args.next_token,
        });
        const records = page.records.map(digestCycle);
        return ok(`${records.length} WHOOP cycle(s)${describeRange(range)}.`, {
          count: records.length,
          range,
          next_token: page.next_token,
          cycles: records,
        });
      }),
  );

  server.registerTool(
    "whoop_get_cycle",
    {
      title: "Get one WHOOP cycle",
      description: "Get a single WHOOP cycle by its numeric cycle id.",
      inputSchema: {
        cycle_id: z.number().int().describe("Numeric WHOOP cycle id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cycle_id }) =>
      safe(async () => {
        const cycle = await context.client.getCycle(cycle_id);
        return ok(`WHOOP cycle ${cycle_id}.`, digestCycle(cycle));
      }),
  );

  server.registerTool(
    "whoop_list_recoveries",
    {
      title: "List WHOOP recoveries",
      description:
        "List daily WHOOP recovery scores with HRV (rMSSD in ms), resting heart rate, SpO2 and skin " +
        "temperature. This is the main tool for questions about readiness or recovery trends.",
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      safe(async () => {
        const range = resolveRange(args);
        const limit = clampLimit(args.limit);
        const page = await context.client.collectAll<Recovery>("/v2/recovery", {
          ...range,
          limit: Math.min(limit, MAX_PAGE_LIMIT),
          maxRecords: limit,
          nextToken: args.next_token,
        });
        const records = page.records.map(digestRecovery);
        return ok(`${records.length} WHOOP recovery record(s)${describeRange(range)}.`, {
          count: records.length,
          range,
          next_token: page.next_token,
          recoveries: records,
        });
      }),
  );

  server.registerTool(
    "whoop_get_cycle_recovery",
    {
      title: "Get the recovery for a cycle",
      description: "Get the recovery score attached to a specific WHOOP cycle id.",
      inputSchema: {
        cycle_id: z.number().int().describe("Numeric WHOOP cycle id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cycle_id }) =>
      safe(async () => {
        const recovery = await context.client.getCycleRecovery(cycle_id);
        return ok(`Recovery for WHOOP cycle ${cycle_id}.`, digestRecovery(recovery));
      }),
  );

  server.registerTool(
    "whoop_list_sleep",
    {
      title: "List WHOOP sleep activities",
      description:
        "List sleeps and naps with time in bed, time asleep, sleep stages, sleep performance, efficiency, " +
        "consistency and respiratory rate.",
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      safe(async () => {
        const range = resolveRange(args);
        const limit = clampLimit(args.limit);
        const page = await context.client.collectAll<Sleep>("/v2/activity/sleep", {
          ...range,
          limit: Math.min(limit, MAX_PAGE_LIMIT),
          maxRecords: limit,
          nextToken: args.next_token,
        });
        const records = page.records.map(digestSleep);
        return ok(`${records.length} WHOOP sleep record(s)${describeRange(range)}.`, {
          count: records.length,
          range,
          next_token: page.next_token,
          sleeps: records,
        });
      }),
  );

  server.registerTool(
    "whoop_get_sleep",
    {
      title: "Get one WHOOP sleep",
      description: "Get a single sleep activity by its WHOOP sleep id (a UUID in API v2).",
      inputSchema: {
        sleep_id: z.string().min(1).describe("WHOOP sleep id (UUID)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sleep_id }) =>
      safe(async () => {
        const sleep = await context.client.getSleep(sleep_id);
        return ok(`WHOOP sleep ${sleep_id}.`, digestSleep(sleep));
      }),
  );

  server.registerTool(
    "whoop_get_cycle_sleep",
    {
      title: "Get the sleep for a cycle",
      description: "Get the sleep activity attached to a specific WHOOP cycle id.",
      inputSchema: {
        cycle_id: z.number().int().describe("Numeric WHOOP cycle id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cycle_id }) =>
      safe(async () => {
        const sleep = await context.client.getCycleSleep(cycle_id);
        return ok(`Sleep for WHOOP cycle ${cycle_id}.`, digestSleep(sleep));
      }),
  );

  server.registerTool(
    "whoop_list_workouts",
    {
      title: "List WHOOP workouts",
      description:
        "List workouts with sport, duration, workout strain, average and max heart rate, calories, distance " +
        "and heart-rate zone durations.",
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      safe(async () => {
        const range = resolveRange(args);
        const limit = clampLimit(args.limit);
        const page = await context.client.collectAll<Workout>("/v2/activity/workout", {
          ...range,
          limit: Math.min(limit, MAX_PAGE_LIMIT),
          maxRecords: limit,
          nextToken: args.next_token,
        });
        const records = page.records.map(digestWorkout);
        return ok(`${records.length} WHOOP workout(s)${describeRange(range)}.`, {
          count: records.length,
          range,
          next_token: page.next_token,
          workouts: records,
        });
      }),
  );

  server.registerTool(
    "whoop_get_workout",
    {
      title: "Get one WHOOP workout",
      description: "Get a single workout by its WHOOP workout id (a UUID in API v2).",
      inputSchema: {
        workout_id: z.string().min(1).describe("WHOOP workout id (UUID)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ workout_id }) =>
      safe(async () => {
        const workout = await context.client.getWorkout(workout_id);
        return ok(`WHOOP workout ${workout_id}.`, digestWorkout(workout));
      }),
  );
}

export function describeRange(range: { start?: string; end?: string }): string {
  if (range.start && range.end) return ` between ${range.start} and ${range.end}`;
  if (range.start) return ` since ${range.start}`;
  if (range.end) return ` up to ${range.end}`;
  return "";
}
