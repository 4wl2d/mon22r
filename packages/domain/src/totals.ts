import type { CurrencyCode } from "./money.js";
import { type CalendarMonth, monthRange } from "./month.js";
import type { Transaction } from "./transactions.js";

export type CurrencyTotals = {
  readonly currency: CurrencyCode;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
};

export type CategorySpend = {
  readonly categoryId: string | null;
  readonly currency: CurrencyCode;
  /** Expenses in this category minus refunds that name the same category. */
  readonly spentMinor: number;
};

/**
 * Income and expense by currency.
 * Transfer legs are omitted, including any row that carries transferGroupId.
 * A refund reduces expense and is not income.
 * Currencies are never added together.
 */
export function totalsByCurrency(transactions: readonly Transaction[]): readonly CurrencyTotals[] {
  const totals = new Map<string, { incomeMinor: number; expenseMinor: number }>();
  for (const transaction of transactions) {
    if (isTransfer(transaction)) continue;
    const current = totals.get(transaction.currency) ?? { incomeMinor: 0, expenseMinor: 0 };
    if (transaction.kind === "income") current.incomeMinor += transaction.amountMinor;
    else if (transaction.kind === "expense") current.expenseMinor += transaction.amountMinor;
    else if (transaction.kind === "refund") current.expenseMinor -= transaction.amountMinor;
    totals.set(transaction.currency, current);
  }
  return [...totals.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([currency, amounts]) => ({
      currency,
      incomeMinor: amounts.incomeMinor,
      expenseMinor: amounts.expenseMinor,
    }));
}

/** Spend after refunds, per currency and category. categoryId null is uncategorized. */
export function spendByCategory(transactions: readonly Transaction[]): readonly CategorySpend[] {
  const spend = new Map<string, { categoryId: string | null; currency: CurrencyCode; spentMinor: number }>();
  for (const transaction of transactions) {
    if (isTransfer(transaction)) continue;
    if (transaction.kind !== "expense" && transaction.kind !== "refund") continue;
    const key = `${transaction.currency}\u0000${transaction.categoryId ?? ""}`;
    const current = spend.get(key) ?? {
      categoryId: transaction.categoryId,
      currency: transaction.currency,
      spentMinor: 0,
    };
    current.spentMinor += transaction.kind === "expense" ? transaction.amountMinor : -transaction.amountMinor;
    spend.set(key, current);
  }
  return [...spend.values()].sort((left, right) => {
    const byCurrency = left.currency.localeCompare(right.currency);
    if (byCurrency !== 0) return byCurrency;
    return (left.categoryId ?? "\uffff").localeCompare(right.categoryId ?? "\uffff");
  });
}

export function transactionsInMonth(
  transactions: readonly Transaction[],
  month: CalendarMonth,
  timeZone: string,
): readonly Transaction[] {
  const range = monthRange(month, timeZone);
  const start = range.startInclusive.getTime();
  const end = range.endExclusive.getTime();
  return transactions.filter((transaction) => {
    const time = Date.parse(transaction.occurredAt);
    return time >= start && time < end;
  });
}

export function monthTotals(
  transactions: readonly Transaction[],
  month: CalendarMonth,
  timeZone: string,
): readonly CurrencyTotals[] {
  return totalsByCurrency(transactionsInMonth(transactions, month, timeZone));
}

function isTransfer(transaction: Transaction): boolean {
  return transaction.kind === "transfer" || transaction.transferGroupId !== null;
}
