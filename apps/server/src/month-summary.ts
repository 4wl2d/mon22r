import { listCategories, type Mon22rDb } from "@mon22r/db";
import type { CalendarMonth, User } from "@mon22r/domain";

import { dayLabel, esc, monthLabel, text } from "./copy.js";
import { formatMinor, formatMoney } from "./format.js";
import { buildMonthView } from "./month-view.js";

const TOP_CATEGORIES = 4;

/**
 * Month summary for the chat, as Telegram HTML: per currency the totals and the largest categories,
 * then the estimate in the home currency. The home currency comes first.
 */
export function monthSummary(db: Mon22rDb, user: User, month: CalendarMonth): string {
  const view = buildMonthView(db, user, month);
  const title = monthLabel(month.year, month.month);
  const heading = `<b>${title.charAt(0).toUpperCase()}${title.slice(1)}</b>`;
  if (view.totalsByCurrency.length === 0) return `${heading}\n${text.monthEmpty}`;
  const names = new Map(listCategories(db, user.id).map((category) => [category.id, category.name]));
  const ordered = [...view.totalsByCurrency].sort(
    (left, right) => Number(right.currency === user.homeCurrency) - Number(left.currency === user.homeCurrency),
  );
  const blocks: string[] = [];
  for (const totals of ordered) {
    const flows: string[] = [];
    if (totals.expenseMinor !== 0) flows.push(`расходы ${formatMinor(totals.expenseMinor, totals.currency)}`);
    if (totals.incomeMinor !== 0) flows.push(`доходы ${formatMinor(totals.incomeMinor, totals.currency)}`);
    const lines = [[`<b>${totals.currency}</b>`, ...flows].join(" · ")];
    const spend = view.categorySpend
      .filter((row) => row.currency === totals.currency && row.spentMinor > 0)
      .sort((left, right) => right.spentMinor - left.spentMinor)
      .slice(0, TOP_CATEGORIES)
      .map((row) => {
        const name = row.categoryId === null ? "без категории" : (names.get(row.categoryId) ?? "категория");
        return `${esc(name)} ${formatMinor(row.spentMinor, row.currency)}`;
      });
    if (spend.length > 0) lines.push(spend.join(" · "));
    blocks.push(lines.join("\n"));
  }
  const estimate = view.estimateInHomeCurrency;
  if (estimate?.usedConversion) {
    const rate = estimate.asOf === null ? "" : ` по курсу на ${dayLabel(estimate.asOf)}`;
    const sign = estimate.minor > 0 ? "+" : "";
    blocks.push(`Итог ≈ <b>${sign}${formatMoney(estimate.minor, estimate.currency)}</b>${rate}`);
  }
  return [heading, ...blocks].join("\n\n");
}
