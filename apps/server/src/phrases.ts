import {
  type CalendarMonth,
  CURRENCY_TOKEN,
  LedgerError,
  monthContaining,
  type ParsedAmount,
  parseAmount,
  zonedDateTimeToUtc,
} from "@mon22r/domain";

export type MovementPhrase = {
  readonly type: "expense" | "income" | "refund";
  readonly note: string;
  readonly amountMinor: number;
  readonly currency: string | null;
  readonly occurredAt: string;
  /** Text of a `#category` tag, with underscores read as spaces. */
  readonly categoryName: string | null;
};

export type PlanPhrase = {
  readonly type: "plan";
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: string | null;
  readonly dayOfMonth: number;
  readonly month: CalendarMonth;
};

export type TransferPhrase = {
  readonly type: "transfer";
  readonly amountMinor: number;
  readonly currency: string | null;
  /** Account named after `с` / `из`. Null picks the usual account of the amount's currency. */
  readonly sourceName: string | null;
  /**
   * Everything after `на` / `в`: an account name, optionally followed by the amount that arrived
   * when the two accounts hold different currencies.
   */
  readonly destinationText: string;
  readonly occurredAt: string;
};

export type ParsedPhrase = MovementPhrase | PlanPhrase | TransferPhrase;

const DATE_OFFSET: Readonly<Record<string, number>> = {
  сегодня: 0,
  вчера: -1,
  позавчера: -2,
};

/**
 * Every place an amount may start: after the start or a space, at a digit or at a currency mark before one.
 * The lookahead consumes nothing, so `city bus 150` yields both `bus 150` and `150` as candidates.
 */
const AMOUNT_START = new RegExp(`(?:^|\\s)(?=(?:(?:${CURRENCY_TOKEN})\\s*)?\\d)`, "giu");
const TAG = /(?:^|\s)#([\p{L}\p{N}_-]+)/gu;

export function nextCalendarMonth(now: Date, timeZone: string): CalendarMonth {
  const current = monthContaining(now, timeZone);
  if (current.month === 12) return { year: current.year + 1, month: 1 };
  return { year: current.year, month: current.month + 1 };
}

/**
 * Reads one chat line.
 * `bareCurrency` is the currency of an amount written without one; it decides the decimal places.
 */
export function parsePhrase(text: string, now: Date, timeZone: string, bareCurrency?: string): ParsedPhrase | null {
  const tagged = peelTag(normalizeSpace(text));
  const normalized = tagged.rest;
  if (normalized.length === 0 || normalized.startsWith("/")) return null;
  const classified = classify(normalized);
  const dated = peelDate(classified.rest, now, timeZone);
  if (dated === null) return null;
  if (classified.kind === "transfer") return parseTransfer(dated.rest, dated.occurredAt, bareCurrency);
  if (classified.kind === "plan") return parsePlan(dated.rest, now, timeZone, bareCurrency);
  const split = splitNoteAndAmount(dated.rest, bareCurrency);
  if (split === null) return null;
  return {
    type: classified.kind,
    note: split.note,
    amountMinor: split.amount.minor,
    currency: split.amount.currency,
    occurredAt: dated.occurredAt,
    categoryName: tagged.tag,
  };
}

/** Splits `name 58600` into the name and the trailing amount. Null when the text has no trailing amount. */
export function splitTrailingAmount(
  text: string,
  fallbackCurrency: string,
): { readonly name: string; readonly amount: ParsedAmount } | null {
  const split = splitNoteAndAmount(text, fallbackCurrency);
  return split === null ? null : { name: split.note, amount: split.amount };
}

function parsePlan(rest: string, now: Date, timeZone: string, bareCurrency: string | undefined): PlanPhrase | null {
  const peeled = peelDay(rest);
  if (peeled === null) return null;
  const split = splitNoteAndAmount(peeled.rest, bareCurrency);
  if (split === null) return null;
  return {
    type: "plan",
    name: split.note,
    amountMinor: split.amount.minor,
    currency: split.amount.currency,
    dayOfMonth: peeled.day,
    month: nextCalendarMonth(now, timeZone),
  };
}

function parseTransfer(rest: string, occurredAt: string, bareCurrency: string | undefined): TransferPhrase | null {
  const match = /^(.+?)(?:\s+(?:с|со|из)\s+(.+?))?\s+(?:на|в)\s+(.+)$/iu.exec(rest);
  const amountText = match?.[1]?.trim();
  const sourceName = match?.[2]?.trim() ?? null;
  const destinationText = match?.[3]?.trim();
  if (amountText === undefined || destinationText === undefined || destinationText.length === 0) return null;
  try {
    const amount = parseAmount(amountText, bareCurrency);
    if (amount.minor <= 0) return null;
    return {
      type: "transfer",
      amountMinor: amount.minor,
      currency: amount.currency,
      sourceName: sourceName === null || sourceName.length === 0 ? null : sourceName,
      destinationText,
      occurredAt,
    };
  } catch {
    return null;
  }
}

function classify(input: string): {
  readonly kind: "plan" | "transfer" | "income" | "refund" | "expense";
  readonly rest: string;
} {
  for (const [word, kind] of [
    ["план", "plan"],
    ["перевод", "transfer"],
    ["возврат", "refund"],
  ] as const) {
    const prefix = new RegExp(`^${word}(?:\\s+|$)`, "iu");
    if (prefix.test(input)) return { kind, rest: input.replace(prefix, "").trim() };
  }
  if (input.startsWith("+")) return { kind: "income", rest: input.slice(1).trim() };
  return { kind: "expense", rest: input };
}

function peelTag(input: string): { readonly rest: string; readonly tag: string | null } {
  let tag: string | null = null;
  const rest = input.replace(TAG, (_match, name: string) => {
    tag ??= name.replaceAll("_", " ").trim();
    return " ";
  });
  return { rest: normalizeSpace(rest), tag: tag === null || tag === "" ? null : tag };
}

/**
 * Leading `вчера`, `позавчера`, or a calendar date such as `5.11` or `05.11.2026`.
 * A date keeps the current time of day. Without a year it is the latest such day that is not in the future.
 * Returns null for a date that does not exist or lies ahead.
 */
function peelDate(
  input: string,
  now: Date,
  timeZone: string,
): { readonly rest: string; readonly occurredAt: string } | null {
  const word = /^(сегодня|вчера|позавчера)(?:\s+|$)/iu.exec(input);
  if (word?.[1] !== undefined) {
    const offset = DATE_OFFSET[word[1].toLowerCase()] ?? 0;
    return { rest: input.slice(word[0].length).trim(), occurredAt: shiftLocalDays(now, timeZone, offset) };
  }
  const undated = { rest: input, occurredAt: now.toISOString() };
  // The month takes two digits, so `1.5 литра молока 200` stays a note.
  const dated = /^(\d{1,2})\.(\d{2})(?:\.(\d{4}))?\s+(?=\S)/u.exec(input);
  if (dated?.[1] === undefined || dated[2] === undefined) return undated;
  const rest = input.slice(dated[0].length).trim();
  // `12.50 кофе` has no amount left after the "date", so the number is not a date.
  if (!/\d/u.test(rest)) return undated;
  const clock = zonedClock(now, timeZone);
  const day = Number(dated[1]);
  const month = Number(dated[2]);
  let year = dated[3] === undefined ? clock.year : Number(dated[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undated;
  if (dated[3] === undefined && (month > clock.month || (month === clock.month && day > clock.day))) year -= 1;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const occurredAt = zonedDateTimeToUtc({
    year,
    month,
    day,
    hour: clock.hour,
    minute: clock.minute,
    second: clock.second,
    timeZone,
  });
  if (occurredAt.getTime() > now.getTime()) return null;
  return { rest, occurredAt: occurredAt.toISOString() };
}

function peelDay(input: string): { readonly rest: string; readonly day: number } | null {
  const match = /^(.*\S)\s+(\d{1,2})$/u.exec(input.trim());
  const rest = match?.[1];
  const dayText = match?.[2];
  if (rest === undefined || dayText === undefined || !/\d/.test(rest)) return null;
  const day = Number(dayText);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return { rest, day };
}

function splitNoteAndAmount(
  input: string,
  bareCurrency: string | undefined,
): { readonly note: string; readonly amount: ParsedAmount } | null {
  for (const match of input.matchAll(AMOUNT_START)) {
    const start = (match.index ?? 0) + match[0].length;
    const note = input.slice(0, start).trim();
    if (note.length === 0) continue;
    const amount = tryAmount(input.slice(start).trim(), bareCurrency);
    if (amount !== null && amount.minor > 0) return { note, amount };
  }
  return null;
}

function tryAmount(text: string, bareCurrency: string | undefined): ParsedAmount | null {
  try {
    return parseAmount(text, bareCurrency);
  } catch (error) {
    if (error instanceof LedgerError) return null;
    throw error;
  }
}

export function shiftLocalDays(now: Date, timeZone: string, dayOffset: number): string {
  const parts = zonedClock(now, timeZone);
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, parts.hour, parts.minute, parts.second),
  );
  return zonedDateTimeToUtc({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    timeZone,
  }).toISOString();
}

function zonedClock(
  instant: Date,
  timeZone: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} {
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
  const read = (type: string): number => {
    const raw = map.get(type);
    if (raw === undefined || !/^\d+$/.test(raw)) {
      throw new LedgerError("invalid_time_zone", `Could not read ${type}`);
    }
    return Number(raw);
  };
  const hour = read("hour") === 24 ? 0 : read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

function normalizeSpace(input: string): string {
  return input.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}
