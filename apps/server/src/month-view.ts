import { listFxRates, listIncomeExpectations, listIncomePlans, listTransactions, type Mon22rDb } from "@mon22r/db";
import {
  type CalendarMonth,
  type CategorySpend,
  type CurrencyTotals,
  estimateInHomeCurrency,
  expectationFromPlan,
  type HomeCurrencyEstimate,
  type IncomeExpectation,
  type IncomePlan,
  LedgerError,
  type Money,
  monthRange,
  spendByCategory,
  totalsByCurrency,
  type User,
} from "@mon22r/domain";

import { materializeApplicable } from "./plans.js";

export type MonthView = {
  readonly month: CalendarMonth;
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly totalsByCurrency: readonly CurrencyTotals[];
  readonly categorySpend: readonly CategorySpend[];
  /** Income lines of this month, with the plans they come from. */
  readonly expectations: readonly IncomeExpectation[];
  readonly plans: readonly IncomePlan[];
  /** Net of the month in the home currency. Null when a needed rate is missing. */
  readonly estimateInHomeCurrency: HomeCurrencyEstimate | null;
  /** Spending and income of the month in the home currency, under the same rule as the net. */
  readonly expenseInHomeCurrency: HomeCurrencyEstimate | null;
  readonly incomeInHomeCurrency: HomeCurrencyEstimate | null;
};

/** Everything the month screen and the chat summary show, in one read. */
export function buildMonthView(db: Mon22rDb, user: User, month: CalendarMonth): MonthView {
  materializeApplicable(db, user.id, month);
  const range = monthRange(month, user.timeZone);
  const transactions = listTransactions(db, user.id, {
    fromInclusive: range.startInclusive.toISOString(),
    toExclusive: range.endExclusive.toISOString(),
  });
  const totals = totalsByCurrency(transactions);
  const rates = listFxRates(db);
  const estimate = (pick: (row: CurrencyTotals) => number) =>
    estimateParts(
      totals.map((row) => ({ minor: pick(row), currency: row.currency })),
      user.homeCurrency,
      rates,
    );
  return {
    month,
    homeCurrency: user.homeCurrency,
    timeZone: user.timeZone,
    totalsByCurrency: totals,
    categorySpend: spendByCategory(transactions),
    expectations: listIncomeExpectations(db, user.id, month),
    plans: listIncomePlans(db, user.id).filter((plan) => expectationFromPlan(plan, month, "draft") !== null),
    estimateInHomeCurrency: estimate((row) => row.incomeMinor - row.expenseMinor),
    expenseInHomeCurrency: estimate((row) => row.expenseMinor),
    incomeInHomeCurrency: estimate((row) => row.incomeMinor),
  };
}

function estimateParts(
  parts: readonly Money[],
  homeCurrency: string,
  rates: ReturnType<typeof listFxRates>,
): HomeCurrencyEstimate | null {
  try {
    return estimateInHomeCurrency({ parts, homeCurrency, rates });
  } catch (error) {
    if (error instanceof LedgerError && (error.code === "fx_rate_missing" || error.code === "invalid_fx_rate"))
      return null;
    throw error;
  }
}
