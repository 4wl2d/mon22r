import {
  getIncomeExpectation,
  listIncomeExpectations,
  listIncomePlans,
  type Mon22rDb,
  materializePlanExpectation,
  removeOpenExpectations,
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

/**
 * Switches a plan off. Months from `from` onward stop listing it unless money already arrived there.
 * Past months keep their lines.
 */
export function stopPlan(db: Mon22rDb, userId: string, planId: string, from: CalendarMonth): IncomePlan {
  const apply = db.sqlite.transaction(() => {
    const plan = updateIncomePlan(db, userId, planId, { active: false });
    removeOpenExpectations(db, userId, plan.id, from);
    return plan;
  });
  return apply();
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
