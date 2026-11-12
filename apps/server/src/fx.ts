import { listFxPairsInUse, type Mon22rDb, replaceFxRate } from "@mon22r/db";
import { type FxRate, minorExponent } from "@mon22r/domain";

/** Free daily reference rates, no key. Terms ask for a visible "Rates By Exchange Rate API" link. */
export const FX_ENDPOINT = "https://open.er-api.com/v6/latest";
export const FX_SOURCE = "er-api";

const FETCH_TIMEOUT_MS = 10_000;
const RATE_SCALE = 1_000_000;

export type FxRefresh = { readonly asOf: string; readonly pairs: number };

/**
 * Fetches today's rates for every home currency in use and stores one row per pair.
 * Amounts in the ledger are never touched; the rates only feed the labeled estimate.
 * Throws on a network failure or an answer that does not look right, and stores nothing in that case.
 */
export async function refreshFxRates(input: {
  readonly db: Mon22rDb;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
}): Promise<FxRefresh | null> {
  const wanted = new Map<string, Set<string>>();
  for (const pair of listFxPairsInUse(input.db)) {
    const quotes = wanted.get(pair.homeCurrency) ?? new Set<string>();
    quotes.add(pair.currency);
    wanted.set(pair.homeCurrency, quotes);
  }
  if (wanted.size === 0) return null;
  const request = input.fetch ?? fetch;
  const rates: FxRate[] = [];
  for (const [base, quotes] of wanted) {
    const response = await request(`${input.endpoint ?? FX_ENDPOINT}/${base}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Rate request failed with status ${response.status}`);
    rates.push(...readRates(await response.json(), base, quotes));
  }
  const first = rates[0];
  if (first === undefined) return null;
  const store = input.db.sqlite.transaction(() => {
    for (const rate of rates) replaceFxRate(input.db, rate);
  });
  store();
  return { asOf: first.asOf, pairs: rates.length };
}

/** Validates one answer and turns the wanted quotes into stored rates. Unknown quotes are skipped. */
export function readRates(body: unknown, base: string, quotes: ReadonlySet<string>): FxRate[] {
  if (typeof body !== "object" || body === null) throw new Error("Rate answer is not an object");
  const answer = body as Record<string, unknown>;
  if (answer.result !== "success" || answer.base_code !== base) throw new Error("Rate answer is not a success");
  const updated = answer.time_last_update_unix;
  if (typeof updated !== "number" || !Number.isFinite(updated) || updated <= 0) {
    throw new Error("Rate answer has no update time");
  }
  const table = answer.rates;
  if (typeof table !== "object" || table === null) throw new Error("Rate answer has no rates");
  const asOf = new Date(updated * 1000).toISOString().slice(0, 10);
  const result: FxRate[] = [];
  for (const quote of quotes) {
    const value = (table as Record<string, unknown>)[quote];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    result.push(toFxRate(base, quote, value, asOf));
  }
  return result;
}

/**
 * `rate` is quote units per one base unit. The stored fraction is quote minor units per base minor unit,
 * kept to six decimal places and reduced.
 */
export function toFxRate(base: string, quote: string, rate: number, asOf: string): FxRate {
  const scaled = Math.round(rate * RATE_SCALE);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error(`Rate ${base}/${quote} is out of range`);
  let numerator = scaled * 10 ** minorExponent(quote);
  let denominator = RATE_SCALE * 10 ** minorExponent(base);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { baseCurrency: base, quoteCurrency: quote, numerator, denominator, asOf, source: FX_SOURCE };
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}
