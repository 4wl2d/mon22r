import {
  createIncomeExpectation,
  getIncomeExpectation,
  listIncomeExpectations,
  listIncomePlans,
  type Mon22rDb,
  materializePlanExpectation,
  updateIncomeExpectation,
  updateIncomePlan,
} from "@mon22r/db";
import {
  type CalendarMonth,
  type ExpectationStatus,
  expectationFromPlan,
  type IncomeExpectation,
  type IncomePlan,
} from "@mon22r/domain";

import { normalizeNote } from "./phrases.js";

export function materializeApplicable(db: Mon22rDb, userId: string, month: CalendarMonth): void {
  for (const plan of listIncomePlans(db, userId)) {
    if (expectationFromPlan(plan, month, "draft") === null) continue;
    materializePlanExpectation(db, userId, plan.id, month);
  }
}

export function refreshOpenExpectations(db: Mon22rDb, userId: string, plan: IncomePlan): void {
  const open = listIncomeExpectationsForPlan(db, userId, plan.id);
  for (const expectation of open) {
    if (expectation.currency !== plan.currency || expectation.status !== "expected" || expectation.receivedMinor !== 0)
      continue;
    updateIncomeExpectation(db, userId, expectation.id, {
      name: plan.name,
      expectedMinor: plan.amountMinor,
      dayOfMonth: plan.dayOfMonth,
      accountId: plan.accountId,
    });
  }
}

export function setExpectationStatus(
  db: Mon22rDb,
  userId: string,
  id: string,
  status: ExpectationStatus,
): IncomeExpectation {
  const existing = getIncomeExpectation(db, userId, id);
  if (existing === null) {
    return updateIncomeExpectation(db, userId, id, { status });
  }
  if (status === "expected") {
    return updateIncomeExpectation(db, userId, id, { status, receivedMinor: 0, matchedTransactionId: null });
  }
  if (status === "received") {
    return updateIncomeExpectation(db, userId, id, {
      status,
      receivedMinor: Math.max(existing.receivedMinor, existing.expectedMinor),
    });
  }
  return updateIncomeExpectation(db, userId, id, { status });
}

export function copyPlans(
  db: Mon22rDb,
  userId: string,
  from: CalendarMonth,
  to: CalendarMonth,
): readonly IncomeExpectation[] {
  if (from.year === to.year && from.month === to.month) return listIncomeExpectations(db, userId, to);
  const source = listIncomeExpectations(db, userId, from);
  const plans = listIncomePlans(db, userId);
  if (source.length === 0) {
    for (const plan of plans) {
      if (expectationFromPlan(plan, from, "draft") === null || expectationFromPlan(plan, to, "draft") === null)
        continue;
      materializePlanExpectation(db, userId, plan.id, to);
    }
    return listIncomeExpectations(db, userId, to);
  }
  const copied = [...listIncomeExpectations(db, userId, to)];
  for (const expectation of source) {
    if (expectation.status === "skipped") continue;
    const plan = expectation.planId === null ? null : (plans.find((item) => item.id === expectation.planId) ?? null);
    if (plan !== null && expectationFromPlan(plan, to, "draft") !== null) {
      const materialized = materializePlanExpectation(db, userId, plan.id, to);
      if (materialized.status === "expected" && materialized.receivedMinor === 0) {
        const updated = updateIncomeExpectation(db, userId, materialized.id, {
          name: expectation.name,
          expectedMinor: expectation.expectedMinor,
          dayOfMonth: expectation.dayOfMonth,
          accountId: expectation.accountId,
        });
        replaceExpectation(copied, updated);
      }
      continue;
    }
    if (alreadyThere(copied, expectation)) continue;
    const created = createIncomeExpectation(db, userId, {
      year: to.year,
      month: to.month,
      name: expectation.name,
      expectedMinor: expectation.expectedMinor,
      currency: expectation.currency,
      accountId: expectation.accountId,
      dayOfMonth: expectation.dayOfMonth,
      status: "expected",
    });
    copied.push(created);
  }
  return listIncomeExpectations(db, userId, to);
}

function listIncomeExpectationsForPlan(db: Mon22rDb, userId: string, planId: string): IncomeExpectation[] {
  const plans = listIncomePlans(db, userId);
  const plan = plans.find((item) => item.id === planId);
  if (plan === undefined) return [];
  const months = new Set<string>();
  const rows: IncomeExpectation[] = [];
  const cursor = { year: plan.startYear, month: plan.startMonth };
  for (let index = 0; index < 36; index += 1) {
    const key = `${cursor.year}-${cursor.month}`;
    if (months.has(key)) break;
    months.add(key);
    if (expectationFromPlan(plan, cursor, "draft") !== null) {
      rows.push(...listIncomeExpectations(db, userId, cursor).filter((item) => item.planId === planId));
    }
    if (plan.recurrence === "once") break;
    if (cursor.month === 12) {
      cursor.year += 1;
      cursor.month = 1;
    } else {
      cursor.month += 1;
    }
  }
  return rows;
}

function alreadyThere(rows: readonly IncomeExpectation[], expectation: IncomeExpectation): boolean {
  const name = normalizeNote(expectation.name);
  return rows.some(
    (row) =>
      normalizeNote(row.name) === name &&
      row.currency === expectation.currency &&
      row.dayOfMonth === expectation.dayOfMonth &&
      row.planId === null,
  );
}

function replaceExpectation(rows: IncomeExpectation[], next: IncomeExpectation): void {
  const index = rows.findIndex((row) => row.id === next.id);
  if (index === -1) rows.push(next);
  else rows[index] = next;
}
