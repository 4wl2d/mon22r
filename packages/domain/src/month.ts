import { LedgerError } from "./errors.js";

export const DEFAULT_TIME_ZONE = "Europe/Belgrade";

export type CalendarMonth = {
  readonly year: number;
  readonly month: number;
};

export type MonthRange = {
  /** Inclusive local midnight at the start of the month, as a UTC instant. */
  readonly startInclusive: Date;
  /** Exclusive local midnight at the start of the next month, as a UTC instant. */
  readonly endExclusive: Date;
};

export type ZonedDateTimeInput = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
  readonly millisecond?: number;
  readonly timeZone: string;
};

export function assertTimeZone(timeZone: string): string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.trim() !== timeZone) {
    throw new LedgerError("invalid_time_zone", "Time zone is required");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new LedgerError("invalid_time_zone", `Unknown time zone "${timeZone}"`);
  }
  return timeZone;
}

export function assertCalendarMonth(month: CalendarMonth): CalendarMonth {
  if (!Number.isInteger(month.year) || month.year < 1 || month.year > 9999) {
    throw new LedgerError("invalid_month", "Year is out of range");
  }
  if (!Number.isInteger(month.month) || month.month < 1 || month.month > 12) {
    throw new LedgerError("invalid_month", "Month must be from 1 to 12");
  }
  return { year: month.year, month: month.month };
}

/** Convert a wall-clock time in an IANA zone to a UTC instant. */
export function zonedDateTimeToUtc(input: ZonedDateTimeInput): Date {
  const timeZone = assertTimeZone(input.timeZone);
  const hour = input.hour ?? 0;
  const minute = input.minute ?? 0;
  const second = input.second ?? 0;
  const millisecond = input.millisecond ?? 0;
  if (
    !Number.isInteger(input.year) ||
    !Number.isInteger(input.month) ||
    !Number.isInteger(input.day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    !Number.isInteger(millisecond)
  ) {
    throw new LedgerError("invalid_month", "Calendar fields must be integers");
  }
  const desired = Date.UTC(input.year, input.month - 1, input.day, hour, minute, second, millisecond);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(guess), timeZone);
    const next = desired - offset;
    if (next === guess) return new Date(next);
    guess = next;
  }
  return new Date(guess);
}

/** Calendar month containing an instant, using the given IANA time zone. */
export function monthContaining(instant: Date, timeZone: string): CalendarMonth {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new LedgerError("invalid_month", "Instant is invalid");
  }
  const parts = zonedParts(instant, assertTimeZone(timeZone));
  return { year: parts.year, month: parts.month };
}

export function monthRange(month: CalendarMonth, timeZone: string): MonthRange {
  const current = assertCalendarMonth(month);
  const zone = assertTimeZone(timeZone);
  const startInclusive = zonedDateTimeToUtc({
    year: current.year,
    month: current.month,
    day: 1,
    timeZone: zone,
  });
  const next = current.month === 12 ? { year: current.year + 1, month: 1 } : { year: current.year, month: current.month + 1 };
  const endExclusive = zonedDateTimeToUtc({
    year: next.year,
    month: next.month,
    day: 1,
    timeZone: zone,
  });
  return { startInclusive, endExclusive };
}

export function clampDayOfMonth(year: number, month: number, day: number): number {
  assertCalendarMonth({ year, month });
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new LedgerError("invalid_month", "Day of month must be from 1 to 31");
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, last);
}

/**
 * Normalize a timestamp to a UTC ISO instant.
 * A date-only value such as `2026-11-01` is UTC midnight, not local midnight.
 * Use `zonedDateTimeToUtc` or `transactionFromStatementLine` when the calendar date belongs to the user's time zone.
 */
export function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LedgerError("invalid_posting", "Timestamp is required");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    return zonedDateTimeToUtc({ year, month, day, timeZone: "UTC" }).toISOString();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new LedgerError("invalid_posting", `Invalid timestamp "${value}"`);
  }
  return new Date(parsed).toISOString();
}

type ZonedParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = new Map<string, string>();
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") map.set(part.type, part.value);
  }
  const year = numberPart(map, "year");
  const month = numberPart(map, "month");
  const day = numberPart(map, "day");
  let hour = numberPart(map, "hour");
  const minute = numberPart(map, "minute");
  const second = numberPart(map, "second");
  if (hour === 24) hour = 0;
  return { year, month, day, hour, minute, second };
}

function numberPart(map: ReadonlyMap<string, string>, type: string): number {
  const raw = map.get(type);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new LedgerError("invalid_time_zone", `Could not read calendar part ${type}`);
  }
  return Number(raw);
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}
