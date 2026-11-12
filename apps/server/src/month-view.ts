import { listFxRates, listIncomeExpectations, listTransactions, type Mon22rDb } from "@mon22r/db";
import {
  estimateInHomeCurrency,
  LedgerError,
  monthRange,
  spendByCategory,
  totalsByCurrency,
  type CalendarMonth,
  type CategorySpend,
  type CurrencyTotals,
  type HomeCurrencyEstimate,
  type IncomeExpectation,
  type User,
} from "@mon22r/domain";

import { materializeApplicable } from "./plans.js";

export type MonthView = {
  readonly month: CalendarMonth;
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly totalsByCurrency: readonly CurrencyTotals[];
  readonly categorySpend: readonly CategorySpend[];
  readonly expectations: readonly IncomeExpectation[];
  readonly estimateInHomeCurrency: HomeCurrencyEstimate | null;
};

export function buildMonthView(db: Mon22rDb, user: User, month: CalendarMonth): MonthView {
  materializeApplicable(db, user.id, month);
  const range = monthRange(month, user.timeZone);
  const transactions = listTransactions(db, user.id, {
    fromInclusive: range.startInclusive.toISOString(),
    toExclusive: range.endExclusive.toISOString(),
  });
  const totals = totalsByCurrency(transactions);
  return {
    month,
    homeCurrency: user.homeCurrency,
    timeZone: user.timeZone,
    totalsByCurrency: totals,
    categorySpend: spendByCategory(transactions),
    expectations: listIncomeExpectations(db, user.id, month),
    estimateInHomeCurrency: estimateTotals(totals, user.homeCurrency, listFxRates(db)),
  };
}

function estimateTotals(
  totals: readonly CurrencyTotals[],
  homeCurrency: string,
  rates: ReturnType<typeof listFxRates>,
): HomeCurrencyEstimate | null {
  try {
    return estimateInHomeCurrency({
      parts: totals.map((row) => ({ minor: row.incomeMinor - row.expenseMinor, currency: row.currency })),
      homeCurrency,
      rates,
    });
  } catch (error) {
    if (error instanceof LedgerError && (error.code === "fx_rate_missing" || error.code === "invalid_fx_rate")) return null;
    throw error;
  }
}
