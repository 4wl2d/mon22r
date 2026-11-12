import { listCategories, type Mon22rDb } from "@mon22r/db";
import type { CalendarMonth, User } from "@mon22r/domain";

import { dayLabel, monthLabel, text } from "./copy.js";
import { formatMinor, formatMoney } from "./format.js";
import { buildMonthView } from "./month-view.js";

const TOP_CATEGORIES = 4;

/** Plain-text month summary for the chat: totals per currency, the largest categories, and the estimate. */
export function monthSummary(db: Mon22rDb, user: User, month: CalendarMonth): string {
  const view = buildMonthView(db, user, month);
  const title = monthLabel(month.year, month.month);
  const heading = `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
  if (view.totalsByCurrency.length === 0) return `${heading}\n${text.monthEmpty}`;
  const names = new Map(listCategories(db, user.id).map((category) => [category.id, category.name]));
  const blocks: string[] = [];
  for (const totals of view.totalsByCurrency) {
    const lines = [totals.currency];
    const flows: string[] = [];
    if (totals.expenseMinor !== 0) flows.push(`ушло ${formatMinor(totals.expenseMinor, totals.currency)}`);
    if (totals.incomeMinor !== 0) flows.push(`пришло ${formatMinor(totals.incomeMinor, totals.currency)}`);
    if (flows.length > 0) lines.push(flows.join(" · "));
    const spend = view.categorySpend
      .filter((row) => row.currency === totals.currency && row.spentMinor > 0)
      .sort((left, right) => right.spentMinor - left.spentMinor)
      .slice(0, TOP_CATEGORIES)
      .map((row) => {
        const name = row.categoryId === null ? "без категории" : (names.get(row.categoryId) ?? "категория");
        return `${name} ${formatMinor(row.spentMinor, row.currency)}`;
      });
    if (spend.length > 0) lines.push(spend.join(" · "));
    blocks.push(lines.join("\n"));
  }
  const estimate = view.estimateInHomeCurrency;
  if (estimate?.usedConversion) {
    const rate = estimate.asOf === null ? "" : `, курс ${dayLabel(estimate.asOf)}`;
    blocks.push(`Итог ≈ ${formatMoney(estimate.minor, estimate.currency)}${rate}`);
  }
  return [heading, ...blocks].join("\n\n");
}
