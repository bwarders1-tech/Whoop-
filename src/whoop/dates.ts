import { WhoopError } from "../errors.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface RangeInput {
  start?: string;
  end?: string;
  days?: number;
}

export interface ResolvedRange {
  start?: string;
  end?: string;
}

/**
 * Turns the loose date arguments a model passes into the ISO-8601 instants the
 * WHOOP API expects. A bare `YYYY-MM-DD` end date covers the whole day.
 */
export function resolveRange(input: RangeInput, now: Date = new Date()): ResolvedRange {
  const start = input.start ? parseInstant(input.start, "start", false) : undefined;
  const end = input.end ? parseInstant(input.end, "end", true) : undefined;

  if (start && end && Date.parse(start) > Date.parse(end)) {
    throw new WhoopError(`The start date (${input.start}) is after the end date (${input.end}).`);
  }

  if (input.days !== undefined) {
    if (!Number.isFinite(input.days) || input.days <= 0) {
      throw new WhoopError(`"days" must be a positive number, got ${input.days}.`);
    }
    const anchorEnd = end ? new Date(Date.parse(end)) : now;
    const derivedStart = new Date(anchorEnd.getTime() - Math.round(input.days) * 86_400_000);
    return {
      start: start ?? derivedStart.toISOString(),
      end: end ?? anchorEnd.toISOString(),
    };
  }

  return { start, end };
}

export function parseInstant(value: string, label: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) {
    const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
    const parsed = Date.parse(`${trimmed}${suffix}`);
    if (Number.isNaN(parsed)) {
      throw new WhoopError(`The ${label} date "${value}" is not a valid calendar date.`);
    }
    return new Date(parsed).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new WhoopError(
      `The ${label} date "${value}" could not be parsed. Use YYYY-MM-DD or a full ISO-8601 timestamp such as ` +
        `2026-09-15T00:00:00Z.`,
    );
  }
  return new Date(parsed).toISOString();
}

/** The UTC day that covers `value`, as `{ start, end }` ISO instants. */
export function dayRange(value: string | undefined, now: Date = new Date()): { start: string; end: string; day: string } {
  const anchor = value ? new Date(Date.parse(parseInstant(value, "date", false))) : now;
  const day = anchor.toISOString().slice(0, 10);
  return {
    day,
    start: `${day}T00:00:00.000Z`,
    end: `${day}T23:59:59.999Z`,
  };
}

export function formatDuration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined;
  const totalMinutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
