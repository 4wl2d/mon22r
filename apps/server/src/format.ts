import { minorExponent, type Transaction } from "@mon22r/domain";

const GROUP = " ";

/** `1 200,50` or `350`: grouped thousands, a decimal comma, and no empty fraction. */
export function formatMinor(minor: number, currency: string): string {
  const exponent = minorExponent(currency);
  const sign = minor < 0 ? "−" : "";
  const absolute = Math.abs(minor);
  const scale = 10 ** exponent;
  const major = String(Math.trunc(absolute / scale)).replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  const fraction = absolute % scale;
  if (exponent === 0 || fraction === 0) return `${sign}${major}`;
  return `${sign}${major},${String(fraction).padStart(exponent, "0")}`;
}

export function formatMoney(minor: number, currency: string): string {
  return `${formatMinor(minor, currency)}${GROUP}${currency}`;
}

/** One-line confirmation of a saved income, expense, or refund: amount, note, account, category. */
export function formatEntry(
  transaction: Pick<Transaction, "kind" | "amountMinor" | "currency" | "description">,
  accountName: string,
  categoryName: string | null,
): string {
  const lead = transaction.kind === "income" ? "+" : transaction.kind === "refund" ? "возврат " : "";
  const parts = [`${lead}${formatMoney(transaction.amountMinor, transaction.currency)}`];
  if (transaction.description.trim().length > 0) parts.push(transaction.description.trim());
  parts.push(accountName);
  if (categoryName !== null) parts.push(categoryName);
  return parts.join(" · ");
}

/** One-line confirmation of a transfer. Shows both amounts only when they differ. */
export function formatTransfer(
  outflow: Pick<Transaction, "amountMinor" | "currency">,
  inflow: Pick<Transaction, "amountMinor" | "currency">,
  fromName: string,
  toName: string,
): string {
  const sent = formatMoney(outflow.amountMinor, outflow.currency);
  const same = outflow.currency === inflow.currency && outflow.amountMinor === inflow.amountMinor;
  const amounts = same ? sent : `${sent} → ${formatMoney(inflow.amountMinor, inflow.currency)}`;
  return `перевод ${amounts} · ${fromName} → ${toName}`;
}
