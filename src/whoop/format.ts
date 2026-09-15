import { formatDuration } from "./dates.js";
import type { BodyMeasurement, Cycle, Recovery, Sleep, UserProfile, Workout } from "./types.js";

const KJ_TO_KCAL = 0.239006;

export function kilojoulesToKcal(kilojoule: number | undefined): number | undefined {
  if (kilojoule === undefined || !Number.isFinite(kilojoule)) return undefined;
  return round(kilojoule * KJ_TO_KCAL, 0);
}

export function round(value: number | undefined, digits = 1): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function durationMs(start: string | undefined, end: string | undefined | null): number | undefined {
  if (!start || !end) return undefined;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return Math.max(to - from, 0);
}

export interface CycleDigest {
  cycle_id: number;
  day: string | undefined;
  start: string;
  end: string | null | undefined;
  score_state: string | undefined;
  strain: number | undefined;
  average_heart_rate: number | undefined;
  max_heart_rate: number | undefined;
  calories_kcal: number | undefined;
}

export function digestCycle(cycle: Cycle): CycleDigest {
  return {
    cycle_id: cycle.id,
    day: cycle.start?.slice(0, 10),
    start: cycle.start,
    end: cycle.end ?? null,
    score_state: cycle.score_state,
    strain: round(cycle.score?.strain, 2),
    average_heart_rate: cycle.score?.average_heart_rate,
    max_heart_rate: cycle.score?.max_heart_rate,
    calories_kcal: kilojoulesToKcal(cycle.score?.kilojoule),
  };
}

export interface RecoveryDigest {
  cycle_id: number;
  sleep_id: string | undefined;
  score_state: string | undefined;
  recovery_score: number | undefined;
  resting_heart_rate: number | undefined;
  hrv_rmssd_milli: number | undefined;
  spo2_percentage: number | undefined;
  skin_temp_celsius: number | undefined;
  user_calibrating: boolean | undefined;
  updated_at: string | undefined;
}

export function digestRecovery(recovery: Recovery): RecoveryDigest {
  return {
    cycle_id: recovery.cycle_id,
    sleep_id: recovery.sleep_id,
    score_state: recovery.score_state,
    recovery_score: round(recovery.score?.recovery_score, 0),
    resting_heart_rate: recovery.score?.resting_heart_rate,
    hrv_rmssd_milli: round(recovery.score?.hrv_rmssd_milli, 1),
    spo2_percentage: round(recovery.score?.spo2_percentage, 1),
    skin_temp_celsius: round(recovery.score?.skin_temp_celsius, 1),
    user_calibrating: recovery.score?.user_calibrating,
    updated_at: recovery.updated_at,
  };
}

export interface SleepDigest {
  sleep_id: string;
  day: string | undefined;
  start: string;
  end: string;
  nap: boolean | undefined;
  score_state: string | undefined;
  time_in_bed: string | undefined;
  time_asleep: string | undefined;
  time_asleep_minutes: number | undefined;
  sleep_performance_percentage: number | undefined;
  sleep_efficiency_percentage: number | undefined;
  sleep_consistency_percentage: number | undefined;
  respiratory_rate: number | undefined;
  rem_sleep: string | undefined;
  deep_sleep: string | undefined;
  light_sleep: string | undefined;
  awake: string | undefined;
  sleep_cycles: number | undefined;
  disturbances: number | undefined;
  sleep_needed: string | undefined;
}

export function digestSleep(sleep: Sleep): SleepDigest {
  const stages = sleep.score?.stage_summary;
  const inBed = stages?.total_in_bed_time_milli;
  const awake = stages?.total_awake_time_milli;
  const asleep = inBed !== undefined && awake !== undefined ? Math.max(inBed - awake, 0) : undefined;
  const needed = sleep.score?.sleep_needed;
  const neededTotal =
    needed === undefined
      ? undefined
      : (needed.baseline_milli ?? 0) +
        (needed.need_from_sleep_debt_milli ?? 0) +
        (needed.need_from_recent_strain_milli ?? 0) +
        (needed.need_from_recent_nap_milli ?? 0);

  return {
    sleep_id: sleep.id,
    day: sleep.end?.slice(0, 10) ?? sleep.start?.slice(0, 10),
    start: sleep.start,
    end: sleep.end,
    nap: sleep.nap,
    score_state: sleep.score_state,
    time_in_bed: formatDuration(inBed ?? durationMs(sleep.start, sleep.end)),
    time_asleep: formatDuration(asleep),
    time_asleep_minutes: asleep === undefined ? undefined : Math.round(asleep / 60_000),
    sleep_performance_percentage: round(sleep.score?.sleep_performance_percentage, 0),
    sleep_efficiency_percentage: round(sleep.score?.sleep_efficiency_percentage, 1),
    sleep_consistency_percentage: round(sleep.score?.sleep_consistency_percentage, 0),
    respiratory_rate: round(sleep.score?.respiratory_rate, 1),
    rem_sleep: formatDuration(stages?.total_rem_sleep_time_milli),
    deep_sleep: formatDuration(stages?.total_slow_wave_sleep_time_milli),
    light_sleep: formatDuration(stages?.total_light_sleep_time_milli),
    awake: formatDuration(awake),
    sleep_cycles: stages?.sleep_cycle_count,
    disturbances: stages?.disturbance_count,
    sleep_needed: neededTotal === undefined || neededTotal === 0 ? undefined : formatDuration(neededTotal),
  };
}

export interface WorkoutDigest {
  workout_id: string;
  sport: string | undefined;
  day: string | undefined;
  start: string;
  end: string;
  duration: string | undefined;
  duration_minutes: number | undefined;
  score_state: string | undefined;
  strain: number | undefined;
  average_heart_rate: number | undefined;
  max_heart_rate: number | undefined;
  calories_kcal: number | undefined;
  distance_meter: number | undefined;
  altitude_gain_meter: number | undefined;
  percent_recorded: number | undefined;
  zone_durations: Record<string, string | undefined> | undefined;
}

export function digestWorkout(workout: Workout): WorkoutDigest {
  const duration = durationMs(workout.start, workout.end);
  const zones = workout.score?.zone_durations;
  return {
    workout_id: workout.id,
    sport: workout.sport_name ?? (workout.sport_id !== undefined ? `sport_id ${workout.sport_id}` : undefined),
    day: workout.start?.slice(0, 10),
    start: workout.start,
    end: workout.end,
    duration: formatDuration(duration),
    duration_minutes: duration === undefined ? undefined : Math.round(duration / 60_000),
    score_state: workout.score_state,
    strain: round(workout.score?.strain, 2),
    average_heart_rate: workout.score?.average_heart_rate,
    max_heart_rate: workout.score?.max_heart_rate,
    calories_kcal: kilojoulesToKcal(workout.score?.kilojoule),
    distance_meter: round(workout.score?.distance_meter, 0),
    altitude_gain_meter: round(workout.score?.altitude_gain_meter, 0),
    percent_recorded: round(workout.score?.percent_recorded, 1),
    zone_durations: zones
      ? {
          zone_0: formatDuration(zones.zone_zero_milli),
          zone_1: formatDuration(zones.zone_one_milli),
          zone_2: formatDuration(zones.zone_two_milli),
          zone_3: formatDuration(zones.zone_three_milli),
          zone_4: formatDuration(zones.zone_four_milli),
          zone_5: formatDuration(zones.zone_five_milli),
        }
      : undefined,
  };
}

export function digestProfile(profile: UserProfile): Record<string, unknown> {
  return {
    user_id: profile.user_id,
    first_name: profile.first_name,
    last_name: profile.last_name,
    email: profile.email,
  };
}

export function digestBodyMeasurement(body: BodyMeasurement): Record<string, unknown> {
  const heightMeter = body.height_meter;
  const weightKg = body.weight_kilogram;
  return {
    height_meter: round(heightMeter, 2),
    height_feet_inches: heightMeter === undefined ? undefined : metersToFeetInches(heightMeter),
    weight_kilogram: round(weightKg, 1),
    weight_pounds: weightKg === undefined ? undefined : round(weightKg * 2.20462, 1),
    max_heart_rate: body.max_heart_rate,
  };
}

function metersToFeetInches(meters: number): string {
  const totalInches = Math.round(meters * 39.3701);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}' ${inches}"`;
}

export function average(values: Array<number | undefined>, digits = 1): number | undefined {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return undefined;
  return round(usable.reduce((sum, value) => sum + value, 0) / usable.length, digits);
}

export function sum(values: Array<number | undefined>, digits = 1): number | undefined {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return undefined;
  return round(usable.reduce((total, value) => total + value, 0), digits);
}
