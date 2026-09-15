import type { Cycle, Recovery, Sleep, Workout } from "../../src/whoop/types.js";

export const FIXTURE_DAYS = 10;
/** Newest fixture day; everything else counts backwards from here. */
export const FIXTURE_LAST_DAY = "2026-09-15";

function dayString(index: number): string {
  const base = Date.parse(`${FIXTURE_LAST_DAY}T00:00:00.000Z`);
  return new Date(base - index * 86_400_000).toISOString().slice(0, 10);
}

function uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** Index 0 is the most recent day. */
export function buildCycles(): Cycle[] {
  return Array.from({ length: FIXTURE_DAYS }, (_unused, index) => {
    const day = dayString(index);
    return {
      id: 1000 + (FIXTURE_DAYS - index),
      user_id: 42,
      created_at: `${day}T04:05:00.000Z`,
      updated_at: `${day}T23:59:00.000Z`,
      start: `${day}T04:00:00.000Z`,
      end: index === 0 ? null : `${day}T23:59:59.000Z`,
      timezone_offset: "-07:00",
      score_state: "SCORED",
      score: {
        strain: 8 + index * 0.5,
        kilojoule: 8000 + index * 100,
        average_heart_rate: 60 + index,
        max_heart_rate: 150 + index,
      },
    } satisfies Cycle;
  });
}

export function buildRecoveries(): Recovery[] {
  return buildCycles().map((cycle, index) => ({
    cycle_id: cycle.id,
    sleep_id: uuid("11111111", index),
    user_id: 42,
    created_at: cycle.created_at,
    updated_at: cycle.updated_at,
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 40 + index * 5,
      resting_heart_rate: 50 + index,
      hrv_rmssd_milli: 55.5 + index,
      spo2_percentage: 96.5,
      skin_temp_celsius: 33.2,
    },
  }));
}

export function buildSleeps(): Sleep[] {
  return Array.from({ length: FIXTURE_DAYS }, (_unused, index) => {
    const day = dayString(index);
    const previousDay = dayString(index + 1);
    return {
      id: uuid("11111111", index),
      v1_id: 500 + index,
      user_id: 42,
      created_at: `${day}T07:00:00.000Z`,
      updated_at: `${day}T07:05:00.000Z`,
      start: `${previousDay}T23:00:00.000Z`,
      end: `${day}T06:30:00.000Z`,
      timezone_offset: "-07:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 27_000_000, // 7h 30m
          total_awake_time_milli: 1_800_000, // 30m
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 13_500_000,
          total_slow_wave_sleep_time_milli: 5_400_000,
          total_rem_sleep_time_milli: 6_300_000,
          sleep_cycle_count: 5,
          disturbance_count: 3,
        },
        sleep_needed: {
          baseline_milli: 28_800_000,
          need_from_sleep_debt_milli: 600_000,
          need_from_recent_strain_milli: 300_000,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 14.8 + index * 0.1,
        sleep_performance_percentage: 80 + index,
        sleep_consistency_percentage: 70,
        sleep_efficiency_percentage: 92.5,
      },
    } satisfies Sleep;
  });
}

export function buildWorkouts(): Workout[] {
  const sports = ["running", "weightlifting", "cycling"];
  return Array.from({ length: FIXTURE_DAYS }, (_unused, index) => {
    const day = dayString(index);
    return {
      id: uuid("22222222", index),
      v1_id: 900 + index,
      user_id: 42,
      created_at: `${day}T18:05:00.000Z`,
      updated_at: `${day}T18:10:00.000Z`,
      start: `${day}T17:00:00.000Z`,
      end: `${day}T18:00:00.000Z`,
      timezone_offset: "-07:00",
      sport_name: sports[index % sports.length],
      score_state: "SCORED",
      score: {
        strain: 9 + index * 0.25,
        average_heart_rate: 140 + index,
        max_heart_rate: 175,
        kilojoule: 2500 + index * 50,
        percent_recorded: 100,
        distance_meter: 8000 + index * 100,
        altitude_gain_meter: 120,
        altitude_change_meter: 10,
        zone_durations: {
          zone_zero_milli: 600_000,
          zone_one_milli: 600_000,
          zone_two_milli: 900_000,
          zone_three_milli: 900_000,
          zone_four_milli: 540_000,
          zone_five_milli: 60_000,
        },
      },
    } satisfies Workout;
  });
}

export const PROFILE = {
  user_id: 42,
  email: "member@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
};

export const BODY_MEASUREMENT = {
  height_meter: 1.7526,
  weight_kilogram: 68.0389,
  max_heart_rate: 191,
};
