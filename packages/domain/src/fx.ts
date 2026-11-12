import { LedgerError } from "./errors.js";
import { assertCurrency, type CurrencyCode, type Money } from "./money.js";

/**
 * How many quote minor units one base minor unit is worth, as a rational.
 * Example: 1.00 EUR = 117.20 RSD is numerator 11720 and denominator 100.
 * Estimates read rates. They must not be written back onto stored transactions.
 */
export type FxRate = {
  readonly baseCurrency: CurrencyCode;
  readonly quoteCurrency: CurrencyCode;
  readonly numerator: number;
  readonly denominator: number;
  readonly asOf: string;
  readonly source: string;
};

export type HomeCurrencyEstimate = {
  readonly kind: "estimate";
  readonly minor: number;
  readonly currency: CurrencyCode;
  readonly asOf: string | null;
  readonly source: string | null;
  readonly usedConversion: boolean;
};

type Factor = {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly asOf: string | null;
  readonly source: string | null;
};

/**
 * Sum amounts in the home currency.
 * The inputs are not modified. The result is marked `estimate` so it cannot be mistaken for a stored amount.
 */
export function assertFxRate(rate: FxRate): FxRate {
  const baseCurrency = assertCurrency(rate.baseCurrency);
  const quoteCurrency = assertCurrency(rate.quoteCurrency);
  if (baseCurrency === quoteCurrency) {
    throw new LedgerError("invalid_fx_rate", "FX rate currencies must differ");
  }
  if (!Number.isSafeInteger(rate.numerator) || rate.numerator <= 0) {
    throw new LedgerError("invalid_fx_rate", "FX numerator must be a positive integer");
  }
  if (!Number.isSafeInteger(rate.denominator) || rate.denominator <= 0) {
    throw new LedgerError("invalid_fx_rate", "FX denominator must be a positive integer");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rate.asOf)) {
    throw new LedgerError("invalid_fx_rate", "FX asOf must be YYYY-MM-DD");
  }
  if (typeof rate.source !== "string" || rate.source.trim() === "" || rate.source.trim() !== rate.source) {
    throw new LedgerError("invalid_fx_rate", "FX source is required");
  }
  return {
    baseCurrency,
    quoteCurrency,
    numerator: rate.numerator,
    denominator: rate.denominator,
    asOf: rate.asOf,
    source: rate.source,
  };
}

export function estimateInHomeCurrency(input: {
  readonly parts: readonly Money[];
  readonly homeCurrency: CurrencyCode;
  readonly rates: readonly FxRate[];
}): HomeCurrencyEstimate {
  const home = assertCurrency(input.homeCurrency);
  const rates = input.rates.map(assertFxRate);
  let total = 0n;
  let asOf: string | null = null;
  let source: string | null = null;
  let usedConversion = false;
  for (const part of input.parts) {
    if (!Number.isSafeInteger(part.minor)) {
      throw new LedgerError("invalid_amount", "Amount must be a safe integer");
    }
    const currency = assertCurrency(part.currency);
    const factor = resolveFactor(currency, home, rates);
    if (currency !== home) usedConversion = true;
    total += applyFactor(BigInt(part.minor), factor);
    asOf = earlierDate(asOf, factor.asOf);
    source = mergeSource(source, factor.source);
  }
  const minor = Number(total);
  if (!Number.isSafeInteger(minor)) {
    throw new LedgerError("invalid_amount", "Estimate is too large");
  }
  return {
    kind: "estimate",
    minor,
    currency: home,
    asOf,
    source,
    usedConversion,
  };
}

function resolveFactor(from: CurrencyCode, to: CurrencyCode, rates: readonly FxRate[]): Factor {
  if (from === to) return { numerator: 1n, denominator: 1n, asOf: null, source: null };
  const direct = factorBetween(from, to, rates);
  if (direct) return direct;
  const pivots = new Set<string>();
  for (const rate of rates) pivots.add(rate.baseCurrency);
  for (const pivot of pivots) {
    if (pivot === from || pivot === to) continue;
    const left = factorBetween(from, pivot, rates);
    const right = factorBetween(pivot, to, rates);
    if (left && right) return multiply(left, right);
  }
  throw new LedgerError("fx_rate_missing", `No FX rate from ${from} to ${to}`);
}

function factorBetween(from: CurrencyCode, to: CurrencyCode, rates: readonly FxRate[]): Factor | null {
  const direct = latestRate(rates, from, to);
  if (direct) {
    return {
      numerator: BigInt(direct.numerator),
      denominator: BigInt(direct.denominator),
      asOf: direct.asOf,
      source: direct.source,
    };
  }
  const inverse = latestRate(rates, to, from);
  if (inverse) {
    return {
      numerator: BigInt(inverse.denominator),
      denominator: BigInt(inverse.numerator),
      asOf: inverse.asOf,
      source: inverse.source,
    };
  }
  return null;
}

function latestRate(rates: readonly FxRate[], base: CurrencyCode, quote: CurrencyCode): FxRate | null {
  let selected: FxRate | null = null;
  for (const rate of rates) {
    if (rate.baseCurrency !== base || rate.quoteCurrency !== quote) continue;
    if (selected === null || rate.asOf >= selected.asOf) selected = rate;
  }
  return selected;
}

function multiply(left: Factor, right: Factor): Factor {
  return {
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
    asOf: earlierDate(left.asOf, right.asOf),
    source: mergeSource(left.source, right.source),
  };
}

function applyFactor(value: bigint, factor: Factor): bigint {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const half = factor.denominator / 2n;
  const rounded = (absolute * factor.numerator + half) / factor.denominator;
  return negative ? -rounded : rounded;
}

function earlierDate(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left <= right ? left : right;
}

function mergeSource(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null || right === left) return left;
  return `${left}+${right}`;
}
