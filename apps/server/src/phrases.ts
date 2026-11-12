import { type CalendarMonth, LedgerError, monthContaining, parseAmount, zonedDateTimeToUtc } from "@mon22r/domain";

export type ExpensePhrase = {
  readonly type: "expense";
  readonly note: string;
  readonly amountMinor: number;
  readonly currency: string | null;
  readonly occurredAt: string;
};

export type IncomePhrase = {
  readonly type: "income";
  readonly note: string;
  readonly amountMinor: number;
  readonly currency: string | null;
  readonly occurredAt: string;
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
  readonly destinationName: string;
  readonly occurredAt: string;
};

export type ParsedPhrase = ExpensePhrase | IncomePhrase | PlanPhrase | TransferPhrase;

const DATE_OFFSET: Readonly<Record<string, number>> = {
  сегодня: 0,
  вчера: -1,
  позавчера: -2,
};

const AMOUNT_START = /(?:^|\s)(?:(?:£|₽|руб|р|[A-Za-z]{3})\s+)?\d/giu;

export function normalizeNote(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function rememberedCategoryId(
  note: string,
  history: readonly {
    readonly description: string;
    readonly categoryId: string | null;
    readonly createdAt: string;
    readonly id?: string;
  }[],
): string | null {
  const key = normalizeNote(note);
  if (key.length === 0) return null;
  let best: { readonly categoryId: string; readonly createdAt: string; readonly id: string } | null = null;
  for (const row of history) {
    if (row.categoryId === null || normalizeNote(row.description) !== key) continue;
    const id = row.id ?? "";
    if (best === null || row.createdAt > best.createdAt || (row.createdAt === best.createdAt && id > best.id)) {
      best = { categoryId: row.categoryId, createdAt: row.createdAt, id };
    }
  }
  return best?.categoryId ?? null;
}

export function nextCalendarMonth(now: Date, timeZone: string): CalendarMonth {
  const current = monthContaining(now, timeZone);
  if (current.month === 12) return { year: current.year + 1, month: 1 };
  return { year: current.year, month: current.month + 1 };
}

export function parsePhrase(text: string, now: Date, timeZone: string): ParsedPhrase | null {
  const normalized = normalizeSpace(text);
  if (normalized.length === 0 || normalized.startsWith("/")) return null;
  const classified = classify(normalized);
  const dated = peelDate(classified.rest);
  const occurredAt = shiftLocalDays(now, timeZone, dated.offset);
  if (classified.kind === "transfer") return parseTransfer(dated.rest, occurredAt);
  if (classified.kind === "plan") return parsePlan(dated.rest, now, timeZone);
  const split = splitNoteAndAmount(dated.rest);
  if (split === null) return null;
  if (classified.kind === "income") {
    return {
      type: "income",
      note: split.note,
      amountMinor: split.amount.minor,
      currency: split.amount.currency,
      occurredAt,
    };
  }
  return {
    type: "expense",
    note: split.note,
    amountMinor: split.amount.minor,
    currency: split.amount.currency,
    occurredAt,
  };
}

function parsePlan(rest: string, now: Date, timeZone: string): PlanPhrase | null {
  const peeled = peelDay(rest);
  if (peeled === null) return null;
  const split = splitNoteAndAmount(peeled.rest);
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

function parseTransfer(rest: string, occurredAt: string): TransferPhrase | null {
  const match = /^(.+?)\s+на\s+(.+)$/iu.exec(rest);
  const amountText = match?.[1]?.trim();
  const destinationName = match?.[2]?.trim();
  if (amountText === undefined || destinationName === undefined || destinationName.length === 0) return null;
  try {
    const amount = parseAmount(amountText);
    return {
      type: "transfer",
      amountMinor: amount.minor,
      currency: amount.currency,
      destinationName,
      occurredAt,
    };
  } catch {
    return null;
  }
}

function classify(input: string): { readonly kind: "plan" | "transfer" | "income" | "expense"; readonly rest: string } {
  if (/^план(?:\s+|$)/iu.test(input)) return { kind: "plan", rest: input.replace(/^план(?:\s+|$)/iu, "").trim() };
  if (/^перевод(?:\s+|$)/iu.test(input))
    return { kind: "transfer", rest: input.replace(/^перевод(?:\s+|$)/iu, "").trim() };
  if (input.startsWith("+")) return { kind: "income", rest: input.slice(1).trim() };
  return { kind: "expense", rest: input };
}

function peelDate(input: string): { readonly rest: string; readonly offset: number } {
  const match = /^(сегодня|вчера|позавчера)(?:\s+|$)/iu.exec(input);
  const word = match?.[1]?.toLowerCase();
  const full = match?.[0];
  if (word === undefined || full === undefined) return { rest: input, offset: 0 };
  return { rest: input.slice(full.length).trim(), offset: DATE_OFFSET[word] ?? 0 };
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
): { readonly note: string; readonly amount: ReturnType<typeof parseAmount> } | null {
  const starts: number[] = [];
  for (const match of input.matchAll(AMOUNT_START)) {
    const token = match[0];
    const index = match.index ?? 0;
    starts.push(/^\s/u.test(token) ? index + 1 : index);
  }
  for (const start of starts) {
    const suffix = input.slice(start).trim();
    try {
      const amount = parseAmount(suffix);
      const note = input.slice(0, start).trim();
      if (note.length === 0) continue;
      return { note, amount };
    } catch {}
  }
  return null;
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
  return input
    .replace(/[\u00A0\u202F\u2009]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
