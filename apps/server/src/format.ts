import { minorExponent, type Transaction } from "@mon22r/domain";

import { esc } from "./copy.js";

const GROUP = "\u00A0";

type Amount = Pick<Transaction, "amountMinor" | "currency">;
type Entry = Pick<Transaction, "kind" | "amountMinor" | "currency" | "description">;

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

/** Money with the direction it moved: `−350 RSD` for an expense, `+5 000 RSD` for an income or a refund. */
export function formatSigned(entry: Pick<Transaction, "kind" | "amountMinor" | "currency">): string {
  return `${entry.kind === "expense" ? "−" : "+"}${formatMoney(entry.amountMinor, entry.currency)}`;
}

/**
 * Confirmation of a saved income, expense, or refund, as Telegram HTML:
 * the amount and the note on the first line, where it went on the second.
 * An expense or refund without a category says so, because the buttons under it offer one.
 */
export function entryHtml(entry: Entry, accountName: string, categoryName: string | null): string {
  const note = entry.description.trim();
  const head = `<b>${formatSigned(entry)}</b>${note.length > 0 ? ` · ${esc(note)}` : ""}`;
  return `${head}\n${esc(entryPlace(entry, accountName, categoryName, true).join(" · "))}`;
}

/** The same entry on one line without emphasis, escaped, for saying what was removed. */
export function entryLine(entry: Entry, accountName: string, categoryName: string | null): string {
  const parts = [formatSigned(entry)];
  const note = entry.description.trim();
  if (note.length > 0) parts.push(note);
  parts.push(...entryPlace(entry, accountName, categoryName, false));
  return esc(parts.join(" · "));
}

function entryPlace(entry: Entry, accountName: string, categoryName: string | null, nameGap: boolean): string[] {
  const parts = [accountName];
  if (entry.kind === "refund") parts.push("возврат");
  if (categoryName !== null) parts.push(categoryName);
  else if (nameGap && entry.kind !== "income") parts.push("без категории");
  return parts;
}

/** Confirmation of a transfer, as Telegram HTML. Shows both amounts only when they differ. */
export function transferHtml(outflow: Amount, inflow: Amount, fromName: string, toName: string): string {
  return `<b>${transferAmounts(outflow, inflow)}</b> · перевод\n${esc(fromName)} → ${esc(toName)}`;
}

/** A transfer on one line without emphasis, escaped. */
export function transferLine(outflow: Amount, inflow: Amount, fromName: string, toName: string): string {
  return esc(`перевод ${transferAmounts(outflow, inflow)} · ${fromName} → ${toName}`);
}

function transferAmounts(outflow: Amount, inflow: Amount): string {
  const sent = formatMoney(outflow.amountMinor, outflow.currency);
  const same = outflow.currency === inflow.currency && outflow.amountMinor === inflow.amountMinor;
  return same ? sent : `${sent} → ${formatMoney(inflow.amountMinor, inflow.currency)}`;
}
