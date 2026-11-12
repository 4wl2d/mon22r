import { minorExponent } from "@mon22r/domain";

export function formatMinor(minor: number, currency: string): string {
  const exponent = minorExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  if (exponent === 0) return `${sign}${absolute}`;
  const scale = 10 ** exponent;
  const major = Math.trunc(absolute / scale);
  const fraction = absolute % scale;
  if (fraction === 0) return `${sign}${major}`;
  return `${sign}${major}.${String(fraction).padStart(exponent, "0")}`;
}

/** Short confirmation: amount, currency, note, account. */
export function formatEntry(amountMinor: number, currency: string, note: string, accountName: string): string {
  return `${formatMinor(amountMinor, currency)} ${currency} · ${note} · ${accountName}`;
}
