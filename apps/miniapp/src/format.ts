const ZERO_DECIMAL = new Set(["CLP", "ISK", "JPY", "KRW", "UGX", "VND", "XAF", "XOF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const NOMINATIVE = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
] as const;

const GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;

export type MonthPoint = {
  readonly year: number;
  readonly month: number;
};

/** Display exponent. Matches the ledger table and does not change stored minor units. */
export function minorExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

export function monthKey(point: MonthPoint): string {
  return `${String(point.year).padStart(4, "0")}-${String(point.month).padStart(2, "0")}`;
}

export function addMonths(point: MonthPoint, delta: number): MonthPoint {
  const index = point.year * 12 + (point.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function currentMonth(timeZone: string, now = new Date()): MonthPoint {
  const zoned = zonedParts(now, timeZone) ?? zonedParts(now, "UTC");
  if (!zoned) return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  return { year: zoned.year, month: zoned.month };
}

export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function formatMonthTitle(point: MonthPoint): string {
  const name = NOMINATIVE[point.month - 1];
  if (!name) return String(point.year);
  const first = name[0];
  if (!first) return String(point.year);
  return `${first.toUpperCase()}${name.slice(1)} ${point.year}`;
}

export function formatRateDate(asOf: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(asOf);
  if (!match) return asOf;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const name = GENITIVE[month - 1];
  if (!name || !Number.isInteger(day)) return asOf;
  return `${day} ${name} ${year}`;
}

export function formatDayLabel(iso: string, timeZone: string): string {
  const parts = zonedParts(new Date(iso), timeZone);
  if (!parts) return iso;
  const name = GENITIVE[parts.month - 1];
  if (!name) return iso;
  return `${parts.day} ${name}`;
}

export function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: safeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function dayKey(iso: string, timeZone: string): string {
  const parts = zonedParts(new Date(iso), timeZone);
  if (!parts) return iso;
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function formatMinor(amountMinor: number, currency: string): string {
  const negative = amountMinor < 0;
  const body = formatMajor(Math.abs(amountMinor), currency, true);
  return `${negative ? "−" : ""}${body} ${currency}`;
}

export function formatMinorInput(amountMinor: number, currency: string): string {
  return formatMajor(Math.abs(amountMinor), currency, false);
}

/**
 * Read a typed major-unit amount back into stored minor units.
 * Returns null when the text is empty or has more fraction digits than the currency allows.
 */
export function parseMinorInput(input: string, currency: string): number | null {
  let compact = input.replace(/[\u00A0\u202F\u2009]/g, " ").trim();
  if (compact.length === 0) return null;
  if (compact.startsWith("+")) compact = compact.slice(1).trim();
  if (compact.startsWith("−") || compact.startsWith("-")) return null;
  compact = compact.replace(/ /g, "");
  if (!/^\d[\d.,]*$/.test(compact)) return null;
  const parts = splitMajorFraction(compact);
  if (!parts) return null;
  const exponent = minorExponent(currency);
  if (parts.fraction.length > exponent) return null;
  const digits = `${parts.major}${parts.fraction.padEnd(exponent, "0")}`.replace(/^0+(?=\d)/, "");
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

function formatMajor(absoluteMinor: number, currency: string, grouped: boolean): string {
  const exponent = minorExponent(currency);
  const scale = 10 ** exponent;
  const major = Math.floor(absoluteMinor / scale);
  const fraction = absoluteMinor % scale;
  const majorText = grouped ? new Intl.NumberFormat("ru-RU").format(major) : String(major);
  if (exponent === 0) return majorText;
  return `${majorText},${String(fraction).padStart(exponent, "0")}`;
}

function splitMajorFraction(compact: string): { major: string; fraction: string } | null {
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    const decimalIndex = Math.max(comma, dot);
    const decimalChar = compact[decimalIndex];
    if (decimalChar !== "," && decimalChar !== ".") return null;
    const grouping = decimalChar === "," ? "." : ",";
    const major = compact.slice(0, decimalIndex).replaceAll(grouping, "");
    const fraction = compact.slice(decimalIndex + 1);
    if (!digitsOnly(major) || !digitsOnly(fraction)) return null;
    if (major.includes(grouping) || fraction.includes(",") || fraction.includes(".")) return null;
    return { major, fraction };
  }
  if (/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/.test(compact)) {
    return { major: compact.replaceAll(/[.,]/g, ""), fraction: "" };
  }
  if (comma !== -1 || dot !== -1) {
    const decimalIndex = Math.max(comma, dot);
    const major = compact.slice(0, decimalIndex);
    const fraction = compact.slice(decimalIndex + 1);
    if (major.includes(",") || major.includes(".") || fraction.includes(",") || fraction.includes(".")) return null;
    if (!digitsOnly(major) || !digitsOnly(fraction)) return null;
    return { major, fraction };
  }
  if (!digitsOnly(compact)) return null;
  return { major: compact, fraction: "" };
}

function digitsOnly(value: string): boolean {
  return /^\d+$/.test(value);
}

function safeZone(timeZone: string): string {
  return isTimeZone(timeZone) ? timeZone : "UTC";
}

function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number } | null {
  if (Number.isNaN(instant.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: safeZone(timeZone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
  } catch {
    return null;
  }
  const year = numberPart(parts, "year");
  const month = numberPart(parts, "month");
  const day = numberPart(parts, "day");
  if (year === null || month === null || day === null) return null;
  return { year, month, day };
}

function numberPart(parts: readonly Intl.DateTimeFormatPart[], type: string): number | null {
  const raw = parts.find((part) => part.type === type)?.value;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}
