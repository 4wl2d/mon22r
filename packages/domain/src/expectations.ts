import { assertUserId, LedgerError } from "./errors.js";
import { assertCurrency, assertPositiveMinor, type CurrencyCode } from "./money.js";
import { assertCalendarMonth, type CalendarMonth, clampDayOfMonth } from "./month.js";

export const EXPECTATION_STATUSES = ["expected", "received", "partial", "skipped"] as const;
export const PLAN_RECURRENCES = ["monthly", "once"] as const;

export type ExpectationStatus = (typeof EXPECTATION_STATUSES)[number];
export type PlanRecurrence = (typeof PLAN_RECURRENCES)[number];

/** A plan is not a transaction. Money movement is recorded only when it actually happens. */
export type IncomePlan = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly dayOfMonth: number;
  readonly accountId: string | null;
  readonly recurrence: PlanRecurrence;
  readonly startYear: number;
  readonly startMonth: number;
  readonly remind: boolean;
  readonly active: boolean;
};

export type IncomeExpectation = {
  readonly id: string;
  readonly userId: string;
  readonly planId: string | null;
  readonly year: number;
  readonly month: number;
  readonly name: string;
  readonly expectedMinor: number;
  readonly receivedMinor: number;
  readonly currency: CurrencyCode;
  readonly accountId: string | null;
  readonly dayOfMonth: number;
  readonly status: ExpectationStatus;
  readonly matchedTransactionId: string | null;
};

/** Relative window for "a similar amount". 0.15 means 15% of the still-open amount. */
export const DEFAULT_INCOME_MATCH_TOLERANCE = 0.15;

export type InflowMatchInput = {
  readonly id: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly accountId: string | null;
};

export type IncomeMatch = {
  readonly expectation: IncomeExpectation;
  readonly status: "received" | "partial";
};

export function createIncomePlan(input: {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly dayOfMonth: number;
  readonly accountId?: string | null;
  readonly recurrence: PlanRecurrence;
  readonly startYear: number;
  readonly startMonth: number;
  readonly remind?: boolean;
  readonly active?: boolean;
}): IncomePlan {
  const start = assertCalendarMonth({ year: input.startYear, month: input.startMonth });
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
    throw new LedgerError("invalid_plan", "Day of month must be from 1 to 31");
  }
  if (input.recurrence !== "monthly" && input.recurrence !== "once") {
    throw new LedgerError("invalid_plan", "Recurrence must be monthly or once");
  }
  return {
    id: requiredId(input.id),
    userId: assertUserId(input.userId),
    name: requiredName(input.name),
    amountMinor: assertPositiveMinor(input.amountMinor),
    currency: assertCurrency(input.currency),
    dayOfMonth: input.dayOfMonth,
    accountId: input.accountId ?? null,
    recurrence: input.recurrence,
    startYear: start.year,
    startMonth: start.month,
    remind: input.remind ?? false,
    active: input.active ?? true,
  };
}

/**
 * Draft the open expectation for a plan and month.
 * Returns null when the plan is inactive or does not apply to that month.
 * This does not create a transaction.
 */
export function expectationFromPlan(plan: IncomePlan, month: CalendarMonth, id: string): IncomeExpectation | null {
  if (!plan.active) return null;
  const target = assertCalendarMonth(month);
  const startIndex = plan.startYear * 12 + plan.startMonth;
  const targetIndex = target.year * 12 + target.month;
  if (targetIndex < startIndex) return null;
  if (plan.recurrence === "once" && targetIndex !== startIndex) return null;
  return {
    id: requiredId(id),
    userId: plan.userId,
    planId: plan.id,
    year: target.year,
    month: target.month,
    name: plan.name,
    expectedMinor: plan.amountMinor,
    receivedMinor: 0,
    currency: plan.currency,
    accountId: plan.accountId,
    dayOfMonth: clampDayOfMonth(target.year, target.month, plan.dayOfMonth),
    status: "expected",
    matchedTransactionId: null,
  };
}

export function createIncomeExpectation(input: {
  readonly id: string;
  readonly userId: string;
  readonly planId?: string | null;
  readonly year: number;
  readonly month: number;
  readonly name: string;
  readonly expectedMinor: number;
  readonly receivedMinor?: number;
  readonly currency: CurrencyCode;
  readonly accountId?: string | null;
  readonly dayOfMonth: number;
  readonly status?: ExpectationStatus;
  readonly matchedTransactionId?: string | null;
}): IncomeExpectation {
  const month = assertCalendarMonth({ year: input.year, month: input.month });
  const status = input.status ?? "expected";
  assertStatus(status);
  const receivedMinor = input.receivedMinor ?? 0;
  if (!Number.isSafeInteger(receivedMinor) || receivedMinor < 0) {
    throw new LedgerError("invalid_plan", "receivedMinor must be a non-negative integer");
  }
  return {
    id: requiredId(input.id),
    userId: assertUserId(input.userId),
    planId: input.planId ?? null,
    year: month.year,
    month: month.month,
    name: requiredName(input.name),
    expectedMinor: assertPositiveMinor(input.expectedMinor),
    receivedMinor,
    currency: assertCurrency(input.currency),
    accountId: input.accountId ?? null,
    dayOfMonth: clampDayOfMonth(month.year, month.month, input.dayOfMonth),
    status,
    matchedTransactionId: input.matchedTransactionId ?? null,
  };
}

/**
 * Match one real inflow to the closest open expectation of a similar amount.
 * Does not create a transaction and does not mutate the inputs.
 * `received` means the inflow covers the expectation. `partial` means it is similar but short.
 * An amount outside the tolerance is left open.
 */
export function matchInflowToExpectation(
  expectations: readonly IncomeExpectation[],
  inflow: InflowMatchInput,
  options?: { readonly tolerance?: number },
): IncomeMatch | null {
  const tolerance = options?.tolerance ?? DEFAULT_INCOME_MATCH_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) {
    throw new LedgerError("invalid_plan", "Income match tolerance must be from 0 inclusive to 1 exclusive");
  }
  const userId = assertUserId(inflow.userId);
  const amountMinor = assertPositiveMinor(inflow.amountMinor);
  let best: { expectation: IncomeExpectation; diff: number; accountSpecific: boolean } | null = null;
  for (const expectation of expectations) {
    if (expectation.userId !== userId || expectation.currency !== inflow.currency) continue;
    if (expectation.status !== "expected" && expectation.status !== "partial") continue;
    const remaining = expectation.expectedMinor - expectation.receivedMinor;
    if (remaining <= 0) continue;
    if (expectation.accountId !== null && inflow.accountId !== null && expectation.accountId !== inflow.accountId) {
      continue;
    }
    const diff = Math.abs(amountMinor - remaining);
    const limit = Math.round(remaining * tolerance);
    if (diff > limit) continue;
    const candidate = {
      expectation,
      diff,
      accountSpecific: expectation.accountId !== null,
    };
    if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
  }
  if (best === null) return null;
  const receivedMinor = best.expectation.receivedMinor + amountMinor;
  const status: "received" | "partial" = receivedMinor >= best.expectation.expectedMinor ? "received" : "partial";
  return {
    status,
    expectation: {
      ...best.expectation,
      receivedMinor,
      status,
      matchedTransactionId: inflow.id,
    },
  };
}

function compareCandidates(
  left: { diff: number; accountSpecific: boolean; expectation: IncomeExpectation },
  right: { diff: number; accountSpecific: boolean; expectation: IncomeExpectation },
): number {
  if (left.diff !== right.diff) return left.diff - right.diff;
  if (left.accountSpecific !== right.accountSpecific) return left.accountSpecific ? -1 : 1;
  return left.expectation.id < right.expectation.id ? -1 : left.expectation.id > right.expectation.id ? 1 : 0;
}

function assertStatus(status: ExpectationStatus): void {
  if (!EXPECTATION_STATUSES.includes(status)) {
    throw new LedgerError("invalid_plan", "Unknown expectation status");
  }
}

function requiredId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LedgerError("invalid_plan", "Id is required");
  }
  return value;
}

function requiredName(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LedgerError("invalid_plan", "Name is required");
  }
  return value.trim();
}
