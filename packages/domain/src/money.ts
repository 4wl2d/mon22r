import { LedgerError } from "./errors.js";

/** ISO 4217 alphabetic code. Amounts are stored separately as integer minor units. */
export type CurrencyCode = string;

export type Money = {
  readonly minor: number;
  readonly currency: CurrencyCode;
};

export type ParsedAmount = {
  readonly minor: number;
  /** Null when the text has no currency hint. Bare amounts use 2 decimal places. */
  readonly currency: CurrencyCode | null;
};

const ZERO_DECIMAL = new Set(["CLP", "ISK", "JPY", "KRW", "UGX", "VND", "XAF", "XOF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const NAMED_CURRENCIES: Readonly<Record<string, CurrencyCode>> = {
  rsd: "RSD",
  rub: "RUB",
  rur: "RUB",
  gbp: "GBP",
  eur: "EUR",
  usd: "USD",
  jpy: "JPY",
  р: "RUB",
  руб: "RUB",
  "₽": "RUB",
  "£": "GBP",
};

const CURRENCY_TOKEN = "£|₽|руб|[A-Za-z]{3}|р";

export function assertCurrency(value: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new LedgerError("invalid_currency", `Currency must be a 3-letter ISO code, received "${value}"`);
  }
  return value;
}

/** Minor-unit exponent. RSD, RUB, and GBP are 2. Unknown ISO codes default to 2. */
export function minorExponent(currency: CurrencyCode): number {
  const code = assertCurrency(currency);
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function money(minor: number, currency: CurrencyCode): Money {
  assertSafeInteger(minor, "invalid_amount");
  return { minor, currency: assertCurrency(currency) };
}

/**
 * Parse a magnitude such as `1 200,50`, `4.50`, or `1200`.
 * Currency hints include `rsd`, `rub`, `р`, `gbp`, and `£`.
 * The result is integer minor units. It does not round extra fractional digits.
 */
export function parseAmount(input: string): ParsedAmount {
  if (typeof input !== "string") {
    throw new LedgerError("invalid_amount", "Amount must be a string");
  }
  const normalized = input.replace(/[\u00A0\u202F\u2009]/g, " ").trim();
  if (normalized.length === 0) {
    throw new LedgerError("invalid_amount", "Amount is empty");
  }
  const peeled = peelCurrency(normalized);
  const exponent = peeled.currency === null ? 2 : minorExponent(peeled.currency);
  return {
    minor: parseNumericToMinor(peeled.numeric, exponent),
    currency: peeled.currency,
  };
}

export function assertPositiveMinor(minor: number): number {
  assertSafeInteger(minor, "invalid_amount");
  if (minor <= 0) {
    throw new LedgerError("invalid_amount", "Amount must be a positive number of minor units");
  }
  return minor;
}

function assertSafeInteger(minor: number, code: "invalid_amount" | "invalid_fx_rate"): void {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor)) {
    throw new LedgerError(code, "Amount must be a safe integer");
  }
}

function peelCurrency(input: string): { numeric: string; currency: CurrencyCode | null } {
  const prefix = new RegExp(`^(${CURRENCY_TOKEN})(?=\\s|\\d)`, "iu");
  const suffix = new RegExp(`(?:\\s|(?<=\\d))(${CURRENCY_TOKEN})$`, "iu");
  let currency: CurrencyCode | null = null;
  let numeric = input;
  const leading = prefix.exec(numeric);
  if (leading !== null) {
    const token = leading[1];
    const matched = leading[0];
    if (token === undefined || matched === undefined) {
      throw new LedgerError("invalid_amount", "Amount is empty");
    }
    currency = currencyFromToken(token);
    numeric = numeric.slice(matched.length).trimStart();
  }
  const trailing = suffix.exec(numeric);
  if (trailing !== null) {
    const token = trailing[1];
    if (token === undefined) throw new LedgerError("invalid_amount", "Amount is empty");
    const next = currencyFromToken(token);
    if (currency !== null && currency !== next) {
      throw new LedgerError("invalid_amount", "Amount has two currencies");
    }
    currency = next;
    numeric = numeric.slice(0, trailing.index).trimEnd();
  }
  return { numeric, currency };
}

function currencyFromToken(token: string): CurrencyCode {
  const mapped = NAMED_CURRENCIES[token.toLowerCase()];
  if (mapped !== undefined) return mapped;
  if (/^[A-Za-z]{3}$/.test(token)) return assertCurrency(token.toUpperCase());
  throw new LedgerError("invalid_currency", `Unknown currency "${token}"`);
}

function parseNumericToMinor(raw: string, exponent: number): number {
  let compact = raw.trim();
  if (compact.startsWith("+")) compact = compact.slice(1).trim();
  compact = compact.replace(/ /g, "");
  if (!/^\d[\d.,]*$/.test(compact)) {
    throw new LedgerError("invalid_amount", `Cannot parse amount "${raw}"`);
  }
  const digits = majorFractionDigits(compact, exponent);
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) {
    throw new LedgerError("invalid_amount", "Amount is too large");
  }
  return minor;
}

function majorFractionDigits(compact: string, exponent: number): string {
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  let major: string;
  let fraction: string;
  if (comma !== -1 && dot !== -1) {
    const decimalIndex = Math.max(comma, dot);
    const decimalChar = compact[decimalIndex];
    const grouping = decimalChar === "," ? "." : ",";
    major = compact.slice(0, decimalIndex).replaceAll(grouping, "");
    fraction = compact.slice(decimalIndex + 1);
    if (major.includes(",") || major.includes(".") || fraction.includes(",") || fraction.includes(".")) {
      throw new LedgerError("invalid_amount", `Cannot parse amount "${compact}"`);
    }
  } else if (/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/.test(compact)) {
    major = compact.replaceAll(/[.,]/g, "");
    fraction = "";
  } else if (comma !== -1 || dot !== -1) {
    const decimalIndex = Math.max(comma, dot);
    major = compact.slice(0, decimalIndex);
    fraction = compact.slice(decimalIndex + 1);
    if (major.includes(",") || major.includes(".") || fraction.includes(",") || fraction.includes(".")) {
      throw new LedgerError("invalid_amount", `Cannot parse amount "${compact}"`);
    }
  } else {
    major = compact;
    fraction = "";
  }
  if (!/^\d+$/.test(major) || (fraction.length > 0 && !/^\d+$/.test(fraction))) {
    throw new LedgerError("invalid_amount", `Cannot parse amount "${compact}"`);
  }
  if (fraction.length > exponent) {
    throw new LedgerError("invalid_amount", "Amount has more decimal places than the currency allows");
  }
  return `${major}${fraction.padEnd(exponent, "0")}`.replace(/^0+(?=\d)/, "");
}
