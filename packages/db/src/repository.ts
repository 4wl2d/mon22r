import { randomUUID } from "node:crypto";
import {
  type Account,
  assertAccountCurrency,
  assertCurrency,
  assertFxRate,
  assertOwnedAccount,
  assertOwnedCategory,
  assertTimeZone,
  assertUserId,
  createAccount as buildAccount,
  createCategory as buildCategory,
  createIncomeExpectation as buildIncomeExpectation,
  createIncomePlan as buildIncomePlan,
  type CalendarMonth,
  type Category,
  type CurrencyCode,
  canonicalTimestamp,
  createTransaction,
  createTransfer,
  createUserProfile,
  DEFAULT_TIME_ZONE,
  type ExpectationStatus,
  expectationFromPlan,
  type FxRate,
  type ImportIdentity,
  type IncomeExpectation,
  type IncomePlan,
  LedgerError,
  type Money,
  matchInflowToExpectation,
  type PlanRecurrence,
  type Transaction,
  type User,
} from "@mon22r/domain";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";

import type { Mon22rDb } from "./client.js";
import {
  accounts,
  categories,
  fxRates,
  importExternalKeys,
  importPreviews,
  incomeExpectations,
  incomePlans,
  statementProfiles,
  transactions,
  users,
} from "./schema.js";

export type RecordTransactionInput = {
  readonly id?: string;
  readonly accountId: string;
  readonly kind: "expense" | "income" | "refund";
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly categoryId?: string | null;
  readonly refundOfTransactionId?: string | null;
  readonly occurredAt: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly importIdentity?: ImportIdentity | null;
};

export type RecordTransactionResult = {
  readonly status: "created" | "duplicate";
  /** On a duplicate, this is the original transaction. */
  readonly transaction: Transaction;
};

export type ListTransactionsFilter = {
  readonly fromInclusive?: string;
  readonly toExclusive?: string;
};

export type IncomePlanPatch = {
  readonly name?: string;
  readonly amountMinor?: number;
  readonly currency?: CurrencyCode;
  readonly dayOfMonth?: number;
  readonly accountId?: string | null;
  readonly remind?: boolean;
  readonly active?: boolean;
};

export type IncomeExpectationPatch = {
  readonly name?: string;
  readonly expectedMinor?: number;
  readonly receivedMinor?: number;
  readonly accountId?: string | null;
  readonly dayOfMonth?: number;
  readonly status?: ExpectationStatus;
  readonly matchedTransactionId?: string | null;
};

export function createUser(
  db: Mon22rDb,
  input: {
    readonly id?: string;
    readonly telegramId?: number | null;
    readonly homeCurrency: string;
    readonly timeZone?: string;
    readonly createdAt?: string;
  },
): User {
  const user = createUserProfile({
    id: input.id ?? randomUUID(),
    telegramId: input.telegramId ?? null,
    homeCurrency: input.homeCurrency,
    timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  try {
    db.orm
      .insert(users)
      .values({
        id: user.id,
        telegramId: user.telegramId,
        homeCurrency: user.homeCurrency,
        timeZone: user.timeZone,
        createdAt: user.createdAt,
      })
      .run();
  } catch (error) {
    if (isUniqueConstraint(error)) throw new LedgerError("conflict", "Telegram id is already registered");
    throw error;
  }
  return user;
}

/** Lookup by the user's own id. */
export function getUser(db: Mon22rDb, userId: string): User | null {
  const owner = assertUserId(userId);
  const row = db.orm.select().from(users).where(eq(users.id, owner)).get();
  return row === undefined ? null : toUser(row);
}

/**
 * Bootstraps a session from Telegram. This is the identity lookup that yields a userId.
 * Every later ledger query takes that userId.
 */
export function getUserByTelegramId(db: Mon22rDb, telegramId: number): User | null {
  if (!Number.isSafeInteger(telegramId)) {
    throw new LedgerError("invalid_posting", "telegramId must be an integer");
  }
  const row = db.orm.select().from(users).where(eq(users.telegramId, telegramId)).get();
  return row === undefined ? null : toUser(row);
}

export function createAccount(
  db: Mon22rDb,
  userId: string,
  input: {
    readonly id?: string;
    readonly name: string;
    readonly currency: string;
    readonly archived?: boolean;
    readonly createdAt?: string;
  },
): Account {
  const owner = assertUserId(userId);
  requireUserRow(db, owner);
  const account = buildAccount({
    id: input.id ?? randomUUID(),
    userId: owner,
    name: input.name,
    currency: input.currency,
    archived: input.archived ?? false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  db.orm
    .insert(accounts)
    .values({
      id: account.id,
      userId: account.userId,
      name: account.name,
      currency: account.currency,
      archived: account.archived ? 1 : 0,
      createdAt: account.createdAt,
    })
    .run();
  return account;
}

export function listAccounts(db: Mon22rDb, userId: string): readonly Account[] {
  const owner = assertUserId(userId);
  return db.orm
    .select()
    .from(accounts)
    .where(eq(accounts.userId, owner))
    .orderBy(accounts.createdAt, accounts.id)
    .all()
    .map(toAccount);
}

export function createCategory(
  db: Mon22rDb,
  userId: string,
  input: { readonly id?: string; readonly name: string; readonly createdAt?: string },
): Category {
  const owner = assertUserId(userId);
  requireUserRow(db, owner);
  const category = buildCategory({
    id: input.id ?? randomUUID(),
    userId: owner,
    name: input.name,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  try {
    db.orm
      .insert(categories)
      .values({
        id: category.id,
        userId: category.userId,
        name: category.name,
        createdAt: category.createdAt,
      })
      .run();
  } catch (error) {
    if (isUniqueConstraint(error)) throw new LedgerError("conflict", "Category name already exists");
    throw error;
  }
  return category;
}

export function listCategories(db: Mon22rDb, userId: string): readonly Category[] {
  const owner = assertUserId(userId);
  return db.orm
    .select()
    .from(categories)
    .where(eq(categories.userId, owner))
    .orderBy(categories.name, categories.id)
    .all()
    .map(toCategory);
}

/**
 * Insert one transaction for this user.
 * The same (userId, source, externalKey) returns the original transaction and does not insert another.
 * `source` must stay stable per statement profile, otherwise a repeated file will not match.
 */
export function recordTransaction(
  db: Mon22rDb,
  userId: string,
  input: RecordTransactionInput,
): RecordTransactionResult {
  const owner = assertUserId(userId);
  const apply = db.sqlite.transaction(() => {
    if (input.importIdentity) {
      const existing = findTransactionByImportKey(
        db,
        owner,
        input.importIdentity.source,
        input.importIdentity.externalKey,
      );
      if (existing) return { status: "duplicate" as const, transaction: existing };
    }
    const account = requireAccount(db, owner, input.accountId);
    assertAccountCurrency(account, assertCurrency(input.currency));
    if (input.categoryId != null) requireCategory(db, owner, input.categoryId);
    if (input.kind === "refund" && input.refundOfTransactionId != null) {
      const original = getTransaction(db, owner, input.refundOfTransactionId);
      if (original === null) throw new LedgerError("not_found", "Refund target was not found for this user");
    }
    const transaction = buildRecordedTransaction(owner, input);
    insertTransaction(db, transaction);
    insertImportKey(db, transaction);
    return { status: "created" as const, transaction };
  });
  try {
    return apply();
  } catch (error) {
    if (input.importIdentity && isUniqueConstraint(error)) {
      const existing = findTransactionByImportKey(
        db,
        owner,
        input.importIdentity.source,
        input.importIdentity.externalKey,
      );
      if (existing) return { status: "duplicate", transaction: existing };
    }
    throw error;
  }
}

export function recordTransfer(
  db: Mon22rDb,
  userId: string,
  input: {
    readonly fromAccountId: string;
    readonly toAccountId: string;
    readonly from: Money;
    readonly to: Money;
    readonly occurredAt: string;
    readonly description?: string;
    readonly createdAt?: string;
    readonly outflowId?: string;
    readonly inflowId?: string;
    readonly transferGroupId?: string;
  },
): readonly [Transaction, Transaction] {
  const owner = assertUserId(userId);
  const apply = db.sqlite.transaction(() => {
    const fromAccount = requireAccount(db, owner, input.fromAccountId);
    const toAccount = requireAccount(db, owner, input.toAccountId);
    assertAccountCurrency(fromAccount, assertCurrency(input.from.currency));
    assertAccountCurrency(toAccount, assertCurrency(input.to.currency));
    const pair = createTransfer({
      userId: owner,
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      from: input.from,
      to: input.to,
      occurredAt: input.occurredAt,
      description: input.description,
      createdAt: input.createdAt ?? new Date().toISOString(),
      outflowId: input.outflowId ?? randomUUID(),
      inflowId: input.inflowId ?? randomUUID(),
      transferGroupId: input.transferGroupId ?? randomUUID(),
    });
    insertTransaction(db, pair[0]);
    insertTransaction(db, pair[1]);
    return pair;
  });
  return apply();
}

export function getTransaction(db: Mon22rDb, userId: string, id: string): Transaction | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, owner), eq(transactions.id, id)))
    .get();
  if (row === undefined) return null;
  return toTransaction(row, loadIdentity(db, owner, row.id));
}

/**
 * Transactions for one user, newest first.
 * Pass instants from `monthRange` as `fromInclusive` and `toExclusive`.
 * A date-only string is UTC midnight, not midnight in the user's time zone.
 */
export function listTransactions(
  db: Mon22rDb,
  userId: string,
  filter?: ListTransactionsFilter,
): readonly Transaction[] {
  const owner = assertUserId(userId);
  const from = filter?.fromInclusive === undefined ? undefined : canonicalTimestamp(filter.fromInclusive);
  const to = filter?.toExclusive === undefined ? undefined : canonicalTimestamp(filter.toExclusive);
  return db.orm
    .select({
      row: transactions,
      source: importExternalKeys.source,
      externalKey: importExternalKeys.externalKey,
    })
    .from(transactions)
    .leftJoin(
      importExternalKeys,
      and(eq(importExternalKeys.transactionId, transactions.id), eq(importExternalKeys.userId, owner)),
    )
    .where(
      and(
        eq(transactions.userId, owner),
        from === undefined ? undefined : gte(transactions.occurredAt, from),
        to === undefined ? undefined : lt(transactions.occurredAt, to),
      ),
    )
    .orderBy(desc(transactions.occurredAt), desc(transactions.createdAt), desc(transactions.id))
    .all()
    .map(fromJoined);
}

/** Latest inserted transaction for this user. This is the row `/undo` should remove. */
export function latestTransaction(db: Mon22rDb, userId: string): Transaction | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select({
      row: transactions,
      source: importExternalKeys.source,
      externalKey: importExternalKeys.externalKey,
    })
    .from(transactions)
    .leftJoin(
      importExternalKeys,
      and(eq(importExternalKeys.transactionId, transactions.id), eq(importExternalKeys.userId, owner)),
    )
    .where(eq(transactions.userId, owner))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(1)
    .get();
  return row === undefined ? null : fromJoined(row);
}

export function findTransactionByImportKey(
  db: Mon22rDb,
  userId: string,
  source: string,
  externalKey: string,
): Transaction | null {
  const owner = assertUserId(userId);
  assertImportParts(source, externalKey);
  const key = db.orm
    .select()
    .from(importExternalKeys)
    .where(
      and(
        eq(importExternalKeys.userId, owner),
        eq(importExternalKeys.source, source),
        eq(importExternalKeys.externalKey, externalKey),
      ),
    )
    .get();
  if (key === undefined) return null;
  return getTransaction(db, owner, key.transactionId);
}

export function listImportKeys(
  db: Mon22rDb,
  userId: string,
  source: string,
): readonly { readonly externalKey: string; readonly transactionId: string }[] {
  const owner = assertUserId(userId);
  assertImportSource(source);
  return db.orm
    .select({
      externalKey: importExternalKeys.externalKey,
      transactionId: importExternalKeys.transactionId,
    })
    .from(importExternalKeys)
    .where(and(eq(importExternalKeys.userId, owner), eq(importExternalKeys.source, source)))
    .orderBy(importExternalKeys.externalKey)
    .all();
}

export function createIncomePlan(
  db: Mon22rDb,
  userId: string,
  input: {
    readonly id?: string;
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
  },
): IncomePlan {
  const owner = assertUserId(userId);
  requireUserRow(db, owner);
  const plan = buildIncomePlan({
    id: input.id ?? randomUUID(),
    userId: owner,
    name: input.name,
    amountMinor: input.amountMinor,
    currency: input.currency,
    dayOfMonth: input.dayOfMonth,
    accountId: input.accountId ?? null,
    recurrence: input.recurrence,
    startYear: input.startYear,
    startMonth: input.startMonth,
    remind: input.remind ?? false,
    active: input.active ?? true,
  });
  if (plan.accountId !== null) {
    assertAccountCurrency(requireAccount(db, owner, plan.accountId), plan.currency);
  }
  db.orm.insert(incomePlans).values(planRow(plan, new Date().toISOString())).run();
  return plan;
}

export function getIncomePlan(db: Mon22rDb, userId: string, id: string): IncomePlan | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select()
    .from(incomePlans)
    .where(and(eq(incomePlans.userId, owner), eq(incomePlans.id, id)))
    .get();
  return row === undefined ? null : toPlan(row);
}

export function listIncomePlans(db: Mon22rDb, userId: string): readonly IncomePlan[] {
  const owner = assertUserId(userId);
  return db.orm
    .select()
    .from(incomePlans)
    .where(eq(incomePlans.userId, owner))
    .orderBy(incomePlans.name, incomePlans.id)
    .all()
    .map(toPlan);
}

export function updateIncomePlan(db: Mon22rDb, userId: string, id: string, patch: IncomePlanPatch): IncomePlan {
  const owner = assertUserId(userId);
  const existing = getIncomePlan(db, owner, id);
  if (existing === null) throw new LedgerError("not_found", "Income plan was not found for this user");
  const next = buildIncomePlan({
    id: existing.id,
    userId: existing.userId,
    name: patch.name ?? existing.name,
    amountMinor: patch.amountMinor ?? existing.amountMinor,
    currency: patch.currency ?? existing.currency,
    dayOfMonth: patch.dayOfMonth ?? existing.dayOfMonth,
    accountId: patch.accountId === undefined ? existing.accountId : patch.accountId,
    recurrence: existing.recurrence,
    startYear: existing.startYear,
    startMonth: existing.startMonth,
    remind: patch.remind ?? existing.remind,
    active: patch.active ?? existing.active,
  });
  if (next.accountId !== null) {
    assertAccountCurrency(requireAccount(db, owner, next.accountId), next.currency);
  }
  const result = db.orm
    .update(incomePlans)
    .set({
      name: next.name,
      amountMinor: next.amountMinor,
      currency: next.currency,
      dayOfMonth: next.dayOfMonth,
      accountId: next.accountId,
      remind: next.remind ? 1 : 0,
      active: next.active ? 1 : 0,
    })
    .where(and(eq(incomePlans.userId, owner), eq(incomePlans.id, existing.id)))
    .run();
  if (result.changes === 0) throw new LedgerError("not_found", "Income plan was not found for this user");
  return next;
}

/**
 * Store the open expectation for a plan and month.
 * Repeating the call returns the existing expectation. It never inserts a transaction.
 */
export function materializePlanExpectation(
  db: Mon22rDb,
  userId: string,
  planId: string,
  month: CalendarMonth,
  id?: string,
): IncomeExpectation {
  const owner = assertUserId(userId);
  const plan = getIncomePlan(db, owner, planId);
  if (plan === null) throw new LedgerError("not_found", "Income plan was not found for this user");
  const existing = db.orm
    .select()
    .from(incomeExpectations)
    .where(
      and(
        eq(incomeExpectations.userId, owner),
        eq(incomeExpectations.planId, plan.id),
        eq(incomeExpectations.year, month.year),
        eq(incomeExpectations.month, month.month),
      ),
    )
    .get();
  if (existing !== undefined) return toExpectation(existing);
  const drafted = expectationFromPlan(plan, month, id ?? randomUUID());
  if (drafted === null) throw new LedgerError("invalid_plan", "Plan does not apply to that month");
  if (drafted.accountId !== null) {
    assertAccountCurrency(requireAccount(db, owner, drafted.accountId), drafted.currency);
  }
  try {
    insertExpectation(db, drafted, new Date().toISOString());
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const raced = db.orm
      .select()
      .from(incomeExpectations)
      .where(
        and(
          eq(incomeExpectations.userId, owner),
          eq(incomeExpectations.planId, plan.id),
          eq(incomeExpectations.year, month.year),
          eq(incomeExpectations.month, month.month),
        ),
      )
      .get();
    if (raced !== undefined) return toExpectation(raced);
    throw error;
  }
  return drafted;
}

export function createIncomeExpectation(
  db: Mon22rDb,
  userId: string,
  input: {
    readonly id?: string;
    readonly planId?: string | null;
    readonly year: number;
    readonly month: number;
    readonly name: string;
    readonly expectedMinor: number;
    readonly currency: CurrencyCode;
    readonly accountId?: string | null;
    readonly dayOfMonth: number;
    readonly status?: ExpectationStatus;
  },
): IncomeExpectation {
  const owner = assertUserId(userId);
  requireUserRow(db, owner);
  if (input.planId != null) {
    const plan = getIncomePlan(db, owner, input.planId);
    if (plan === null) throw new LedgerError("not_found", "Income plan was not found for this user");
  }
  const expectation = buildIncomeExpectation({
    id: input.id ?? randomUUID(),
    userId: owner,
    planId: input.planId ?? null,
    year: input.year,
    month: input.month,
    name: input.name,
    expectedMinor: input.expectedMinor,
    currency: input.currency,
    accountId: input.accountId ?? null,
    dayOfMonth: input.dayOfMonth,
    status: input.status ?? "expected",
  });
  if (expectation.accountId !== null) {
    assertAccountCurrency(requireAccount(db, owner, expectation.accountId), expectation.currency);
  }
  insertExpectation(db, expectation, new Date().toISOString());
  return expectation;
}

export function listIncomeExpectations(
  db: Mon22rDb,
  userId: string,
  month: CalendarMonth,
): readonly IncomeExpectation[] {
  const owner = assertUserId(userId);
  return db.orm
    .select()
    .from(incomeExpectations)
    .where(
      and(
        eq(incomeExpectations.userId, owner),
        eq(incomeExpectations.year, month.year),
        eq(incomeExpectations.month, month.month),
      ),
    )
    .orderBy(incomeExpectations.dayOfMonth, incomeExpectations.id)
    .all()
    .map(toExpectation);
}

export function updateIncomeExpectation(
  db: Mon22rDb,
  userId: string,
  id: string,
  patch: IncomeExpectationPatch,
): IncomeExpectation {
  const owner = assertUserId(userId);
  const existing = getExpectation(db, owner, id);
  if (existing === null) throw new LedgerError("not_found", "Income expectation was not found for this user");
  const next = buildIncomeExpectation({
    id: existing.id,
    userId: existing.userId,
    planId: existing.planId,
    year: existing.year,
    month: existing.month,
    name: patch.name ?? existing.name,
    expectedMinor: patch.expectedMinor ?? existing.expectedMinor,
    receivedMinor: patch.receivedMinor ?? existing.receivedMinor,
    currency: existing.currency,
    accountId: patch.accountId === undefined ? existing.accountId : patch.accountId,
    dayOfMonth: patch.dayOfMonth ?? existing.dayOfMonth,
    status: patch.status ?? existing.status,
    matchedTransactionId:
      patch.matchedTransactionId === undefined ? existing.matchedTransactionId : patch.matchedTransactionId,
  });
  if (next.accountId !== null) {
    assertAccountCurrency(requireAccount(db, owner, next.accountId), next.currency);
  }
  if (next.matchedTransactionId !== null && getTransaction(db, owner, next.matchedTransactionId) === null) {
    throw new LedgerError("not_found", "Matched transaction was not found for this user");
  }
  const result = db.orm
    .update(incomeExpectations)
    .set({
      name: next.name,
      expectedMinor: next.expectedMinor,
      receivedMinor: next.receivedMinor,
      accountId: next.accountId,
      dayOfMonth: next.dayOfMonth,
      status: next.status,
      matchedTransactionId: next.matchedTransactionId,
    })
    .where(and(eq(incomeExpectations.userId, owner), eq(incomeExpectations.id, existing.id)))
    .run();
  if (result.changes === 0) throw new LedgerError("not_found", "Income expectation was not found for this user");
  return next;
}

/**
 * Attach an existing income transaction to an open expectation.
 * Does not insert a transaction for the plan.
 */
export function matchInflowAndSave(
  db: Mon22rDb,
  userId: string,
  transactionId: string,
  options?: { readonly tolerance?: number },
): IncomeExpectation | null {
  const owner = assertUserId(userId);
  const transaction = getTransaction(db, owner, transactionId);
  if (transaction === null || transaction.kind !== "income") return null;
  const open = db.orm
    .select()
    .from(incomeExpectations)
    .where(and(eq(incomeExpectations.userId, owner), inArray(incomeExpectations.status, ["expected", "partial"])))
    .all()
    .map(toExpectation);
  const match = matchInflowToExpectation(
    open,
    {
      id: transaction.id,
      userId: owner,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      accountId: transaction.accountId,
    },
    options,
  );
  if (match === null) return null;
  return updateIncomeExpectation(db, owner, match.expectation.id, {
    status: match.status,
    receivedMinor: match.expectation.receivedMinor,
    matchedTransactionId: match.expectation.matchedTransactionId,
  });
}

/** Shared FX reference data. Saving a rate does not rewrite stored transaction amounts. */
export function upsertFxRate(db: Mon22rDb, rate: FxRate): FxRate {
  const valid = assertFxRate(rate);
  const existing = db.orm
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.baseCurrency, valid.baseCurrency),
        eq(fxRates.quoteCurrency, valid.quoteCurrency),
        eq(fxRates.asOf, valid.asOf),
        eq(fxRates.source, valid.source),
      ),
    )
    .get();
  if (existing !== undefined) {
    db.orm
      .update(fxRates)
      .set({ numerator: valid.numerator, denominator: valid.denominator })
      .where(eq(fxRates.id, existing.id))
      .run();
    return valid;
  }
  db.orm
    .insert(fxRates)
    .values({ id: randomUUID(), ...valid })
    .run();
  return valid;
}

export function listFxRates(db: Mon22rDb): readonly FxRate[] {
  return db.orm
    .select()
    .from(fxRates)
    .orderBy(desc(fxRates.asOf), fxRates.baseCurrency, fxRates.quoteCurrency)
    .all()
    .map((row) =>
      assertFxRate({
        baseCurrency: row.baseCurrency,
        quoteCurrency: row.quoteCurrency,
        numerator: row.numerator,
        denominator: row.denominator,
        asOf: row.asOf,
        source: row.source,
      }),
    );
}

function buildRecordedTransaction(userId: string, input: RecordTransactionInput): Transaction {
  const shared = {
    id: input.id ?? randomUUID(),
    userId,
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt,
    description: input.description,
    createdAt: input.createdAt ?? new Date().toISOString(),
    categoryId: input.categoryId ?? null,
    importIdentity: input.importIdentity ?? null,
  };
  if (input.kind === "refund") {
    return createTransaction({
      ...shared,
      kind: "refund",
      refundOfTransactionId: input.refundOfTransactionId ?? null,
    });
  }
  if (input.kind === "income") return createTransaction({ ...shared, kind: "income" });
  return createTransaction({ ...shared, kind: "expense" });
}

function insertTransaction(db: Mon22rDb, transaction: Transaction): void {
  db.orm
    .insert(transactions)
    .values({
      id: transaction.id,
      userId: transaction.userId,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      direction: transaction.direction,
      kind: transaction.kind,
      transferGroupId: transaction.transferGroupId,
      refundOfTransactionId: transaction.refundOfTransactionId,
      occurredAt: transaction.occurredAt,
      description: transaction.description,
      createdAt: transaction.createdAt,
    })
    .run();
}

function insertImportKey(db: Mon22rDb, transaction: Transaction): void {
  const identity = transaction.importIdentity;
  if (identity === null) return;
  db.orm
    .insert(importExternalKeys)
    .values({
      id: randomUUID(),
      userId: transaction.userId,
      source: identity.source,
      externalKey: identity.externalKey,
      transactionId: transaction.id,
      createdAt: transaction.createdAt,
    })
    .run();
}

function insertExpectation(db: Mon22rDb, expectation: IncomeExpectation, createdAt: string): void {
  db.orm
    .insert(incomeExpectations)
    .values({
      id: expectation.id,
      userId: expectation.userId,
      planId: expectation.planId,
      year: expectation.year,
      month: expectation.month,
      name: expectation.name,
      expectedMinor: expectation.expectedMinor,
      receivedMinor: expectation.receivedMinor,
      currency: expectation.currency,
      accountId: expectation.accountId,
      dayOfMonth: expectation.dayOfMonth,
      status: expectation.status,
      matchedTransactionId: expectation.matchedTransactionId,
      createdAt,
    })
    .run();
}

function planRow(plan: IncomePlan, createdAt: string) {
  return {
    id: plan.id,
    userId: plan.userId,
    name: plan.name,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    dayOfMonth: plan.dayOfMonth,
    accountId: plan.accountId,
    recurrence: plan.recurrence,
    startYear: plan.startYear,
    startMonth: plan.startMonth,
    remind: plan.remind ? 1 : 0,
    active: plan.active ? 1 : 0,
    createdAt,
  };
}

function requireUserRow(db: Mon22rDb, userId: string): User {
  const user = getUser(db, userId);
  if (user === null) throw new LedgerError("not_found", "User was not found");
  return user;
}

function requireAccount(db: Mon22rDb, userId: string, accountId: string): Account {
  const row = db.orm
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  return assertOwnedAccount(row === undefined ? null : toAccount(row), userId);
}

function requireCategory(db: Mon22rDb, userId: string, categoryId: string): Category {
  const row = db.orm
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, categoryId)))
    .get();
  return assertOwnedCategory(row === undefined ? null : toCategory(row), userId);
}

function getExpectation(db: Mon22rDb, userId: string, id: string): IncomeExpectation | null {
  const row = db.orm
    .select()
    .from(incomeExpectations)
    .where(and(eq(incomeExpectations.userId, userId), eq(incomeExpectations.id, id)))
    .get();
  return row === undefined ? null : toExpectation(row);
}

function loadIdentity(db: Mon22rDb, userId: string, transactionId: string): ImportIdentity | null {
  const row = db.orm
    .select()
    .from(importExternalKeys)
    .where(and(eq(importExternalKeys.userId, userId), eq(importExternalKeys.transactionId, transactionId)))
    .get();
  if (row === undefined) return null;
  return { source: row.source, externalKey: row.externalKey };
}

function fromJoined(joined: {
  readonly row: typeof transactions.$inferSelect;
  readonly source: string | null;
  readonly externalKey: string | null;
}): Transaction {
  const identity =
    joined.source !== null && joined.externalKey !== null
      ? { source: joined.source, externalKey: joined.externalKey }
      : null;
  return toTransaction(joined.row, identity);
}

function toTransaction(row: typeof transactions.$inferSelect, importIdentity: ImportIdentity | null): Transaction {
  const shared = {
    id: row.id,
    userId: row.userId,
    accountId: row.accountId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    occurredAt: row.occurredAt,
    description: row.description,
    createdAt: row.createdAt,
    categoryId: row.categoryId,
    importIdentity,
  };
  switch (row.kind) {
    case "expense":
      return createTransaction({ ...shared, kind: "expense" });
    case "income":
      return createTransaction({ ...shared, kind: "income" });
    case "refund":
      return createTransaction({
        ...shared,
        kind: "refund",
        refundOfTransactionId: row.refundOfTransactionId,
      });
    case "transfer":
      return createTransaction({
        id: row.id,
        userId: row.userId,
        accountId: row.accountId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        occurredAt: row.occurredAt,
        description: row.description,
        createdAt: row.createdAt,
        importIdentity,
        kind: "transfer",
        direction: directionOf(row.direction),
        transferGroupId: row.transferGroupId ?? "",
        categoryId: null,
      });
    default:
      throw new LedgerError("invalid_posting", `Unknown transaction kind ${row.kind}`);
  }
}

function toUser(row: typeof users.$inferSelect): User {
  return createUserProfile({
    id: row.id,
    telegramId: row.telegramId,
    homeCurrency: row.homeCurrency,
    timeZone: row.timeZone,
    createdAt: row.createdAt,
  });
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return buildAccount({
    id: row.id,
    userId: row.userId,
    name: row.name,
    currency: row.currency,
    archived: row.archived === 1,
    createdAt: row.createdAt,
  });
}

function toCategory(row: typeof categories.$inferSelect): Category {
  return buildCategory({
    id: row.id,
    userId: row.userId,
    name: row.name,
    createdAt: row.createdAt,
  });
}

function toPlan(row: typeof incomePlans.$inferSelect): IncomePlan {
  return buildIncomePlan({
    id: row.id,
    userId: row.userId,
    name: row.name,
    amountMinor: row.amountMinor,
    currency: row.currency,
    dayOfMonth: row.dayOfMonth,
    accountId: row.accountId,
    recurrence: recurrenceOf(row.recurrence),
    startYear: row.startYear,
    startMonth: row.startMonth,
    remind: row.remind === 1,
    active: row.active === 1,
  });
}

function toExpectation(row: typeof incomeExpectations.$inferSelect): IncomeExpectation {
  return buildIncomeExpectation({
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    year: row.year,
    month: row.month,
    name: row.name,
    expectedMinor: row.expectedMinor,
    receivedMinor: row.receivedMinor,
    currency: row.currency,
    accountId: row.accountId,
    dayOfMonth: row.dayOfMonth,
    status: statusOf(row.status),
    matchedTransactionId: row.matchedTransactionId,
  });
}

function directionOf(value: string): "inflow" | "outflow" {
  if (value === "inflow" || value === "outflow") return value;
  throw new LedgerError("invalid_posting", `Unknown direction ${value}`);
}

function recurrenceOf(value: string): PlanRecurrence {
  if (value === "monthly" || value === "once") return value;
  throw new LedgerError("invalid_plan", `Unknown recurrence ${value}`);
}

function statusOf(value: string): ExpectationStatus {
  if (value === "expected" || value === "received" || value === "partial" || value === "skipped") return value;
  throw new LedgerError("invalid_plan", `Unknown expectation status ${value}`);
}

function assertImportParts(source: string, externalKey: string): void {
  assertImportSource(source);
  if (externalKey.length === 0 || externalKey.trim() !== externalKey) {
    throw new LedgerError("invalid_posting", "Import source and external key must both be non-empty");
  }
}

function assertImportSource(source: string): void {
  if (typeof source !== "string" || source.length === 0 || source.trim() !== source) {
    throw new LedgerError("invalid_posting", "Import source is required");
  }
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export type OnboardingStep = "timezone" | "accounts";

export function readUserFlags(
  db: Mon22rDb,
  userId: string,
): { readonly onboardingStep: OnboardingStep | null; readonly pendingCsvJson: string | null } | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select({ onboardingStep: users.onboardingStep, pendingCsvJson: users.pendingCsvJson })
    .from(users)
    .where(eq(users.id, owner))
    .get();
  if (row === undefined) return null;
  return {
    onboardingStep: onboardingStepOf(row.onboardingStep),
    pendingCsvJson: row.pendingCsvJson,
  };
}

export function updateStoredUser(
  db: Mon22rDb,
  userId: string,
  patch: {
    readonly homeCurrency?: string;
    readonly timeZone?: string;
    readonly onboardingStep?: OnboardingStep | null;
    readonly pendingCsvJson?: string | null;
  },
): User {
  const owner = assertUserId(userId);
  const existing = getUser(db, owner);
  if (existing === null) throw new LedgerError("not_found", "User was not found");
  const homeCurrency = patch.homeCurrency === undefined ? existing.homeCurrency : assertCurrency(patch.homeCurrency);
  const timeZone = patch.timeZone === undefined ? existing.timeZone : assertTimeZone(patch.timeZone);
  const set: {
    homeCurrency: string;
    timeZone: string;
    onboardingStep?: string | null;
    pendingCsvJson?: string | null;
  } = { homeCurrency, timeZone };
  if (patch.onboardingStep !== undefined) set.onboardingStep = patch.onboardingStep;
  if (patch.pendingCsvJson !== undefined) set.pendingCsvJson = patch.pendingCsvJson;
  db.orm.update(users).set(set).where(eq(users.id, owner)).run();
  return { ...existing, homeCurrency, timeZone };
}

export function getAccount(db: Mon22rDb, userId: string, accountId: string): Account | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, owner), eq(accounts.id, accountId)))
    .get();
  return row === undefined ? null : toAccount(row);
}

export function updateAccount(
  db: Mon22rDb,
  userId: string,
  id: string,
  patch: { readonly name?: string; readonly archived?: boolean },
): Account {
  const owner = assertUserId(userId);
  const existing = getAccount(db, owner, id);
  if (existing === null) throw new LedgerError("account_not_found", "Account was not found for this user");
  if (patch.name === undefined && patch.archived === undefined) {
    throw new LedgerError("invalid_posting", "Nothing to update");
  }
  const next = buildAccount({
    id: existing.id,
    userId: existing.userId,
    name: patch.name ?? existing.name,
    currency: existing.currency,
    archived: patch.archived ?? existing.archived,
    createdAt: existing.createdAt,
  });
  const result = db.orm
    .update(accounts)
    .set({ name: next.name, archived: next.archived ? 1 : 0 })
    .where(and(eq(accounts.userId, owner), eq(accounts.id, existing.id)))
    .run();
  if (result.changes === 0) throw new LedgerError("account_not_found", "Account was not found for this user");
  return next;
}

export function correctTransaction(
  db: Mon22rDb,
  userId: string,
  id: string,
  patch: { readonly categoryId?: string | null; readonly accountId?: string },
): Transaction {
  const owner = assertUserId(userId);
  const existing = getTransaction(db, owner, id);
  if (existing === null) throw new LedgerError("not_found", "Transaction was not found for this user");
  if (patch.categoryId === undefined && patch.accountId === undefined) {
    throw new LedgerError("invalid_posting", "Nothing to correct");
  }
  const accountId = patch.accountId ?? existing.accountId;
  if (patch.accountId !== undefined) {
    assertAccountCurrency(requireAccount(db, owner, accountId), existing.currency);
  }
  let categoryId = existing.categoryId;
  if (patch.categoryId !== undefined) {
    if (existing.kind === "transfer" && patch.categoryId !== null) {
      throw new LedgerError("invalid_posting", "A transfer has no category");
    }
    if (patch.categoryId !== null) requireCategory(db, owner, patch.categoryId);
    categoryId = patch.categoryId;
  }
  const next = rebuildTransaction(existing, accountId, categoryId);
  const result = db.orm
    .update(transactions)
    .set({ accountId: next.accountId, categoryId: next.categoryId })
    .where(and(eq(transactions.userId, owner), eq(transactions.id, existing.id)))
    .run();
  if (result.changes === 0) throw new LedgerError("not_found", "Transaction was not found for this user");
  return next;
}

/** Removes one transaction for this user. A transfer removes both legs and their import keys. */
export function deleteTransaction(db: Mon22rDb, userId: string, id: string): readonly Transaction[] {
  const owner = assertUserId(userId);
  const existing = getTransaction(db, owner, id);
  if (existing === null) return [];
  const targets =
    existing.transferGroupId === null
      ? [existing]
      : db.orm
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, owner), eq(transactions.transferGroupId, existing.transferGroupId)))
          .all()
          .map((row) => toTransaction(row, loadIdentity(db, owner, row.id)));
  const ids = targets.map((item) => item.id);
  const apply = db.sqlite.transaction(() => {
    db.orm
      .update(incomeExpectations)
      .set({ matchedTransactionId: null })
      .where(and(eq(incomeExpectations.userId, owner), inArray(incomeExpectations.matchedTransactionId, ids)))
      .run();
    db.orm
      .update(transactions)
      .set({ refundOfTransactionId: null })
      .where(and(eq(transactions.userId, owner), inArray(transactions.refundOfTransactionId, ids)))
      .run();
    db.orm
      .delete(importExternalKeys)
      .where(and(eq(importExternalKeys.userId, owner), inArray(importExternalKeys.transactionId, ids)))
      .run();
    db.orm
      .delete(transactions)
      .where(and(eq(transactions.userId, owner), inArray(transactions.id, ids)))
      .run();
  });
  apply();
  return targets;
}

/** Deletes the row `latestTransaction` would return, including the other transfer leg. */
export function deleteLatestTransaction(db: Mon22rDb, userId: string): readonly Transaction[] {
  const latest = latestTransaction(db, userId);
  if (latest === null) return [];
  return deleteTransaction(db, userId, latest.id);
}

export function getIncomeExpectation(db: Mon22rDb, userId: string, id: string): IncomeExpectation | null {
  return getExpectation(db, assertUserId(userId), id);
}

export function listOpenExpectations(db: Mon22rDb, userId: string): readonly IncomeExpectation[] {
  const owner = assertUserId(userId);
  return db.orm
    .select()
    .from(incomeExpectations)
    .where(and(eq(incomeExpectations.userId, owner), inArray(incomeExpectations.status, ["expected", "partial"])))
    .orderBy(incomeExpectations.year, incomeExpectations.month, incomeExpectations.dayOfMonth, incomeExpectations.id)
    .all()
    .map(toExpectation);
}

export type StatementProfileRecord = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly mappingJson: string;
  readonly createdAt: string;
};

export function saveStatementProfile(
  db: Mon22rDb,
  userId: string,
  input: { readonly name: string; readonly fingerprint: string; readonly mappingJson: string; readonly id?: string },
): StatementProfileRecord {
  const owner = assertUserId(userId);
  requireUserRow(db, owner);
  const name = requiredLabel(input.name, "Profile name is required");
  const fingerprint = requiredLabel(input.fingerprint, "Profile fingerprint is required");
  const mappingJson = requiredLabel(input.mappingJson, "Profile mapping is required");
  const existing = findStatementProfileByFingerprint(db, owner, fingerprint);
  if (existing !== null) {
    db.orm
      .update(statementProfiles)
      .set({ mappingJson })
      .where(and(eq(statementProfiles.userId, owner), eq(statementProfiles.id, existing.id)))
      .run();
    return { ...existing, mappingJson };
  }
  const record: StatementProfileRecord = {
    id: input.id ?? randomUUID(),
    userId: owner,
    name,
    fingerprint,
    mappingJson,
    createdAt: new Date().toISOString(),
  };
  try {
    db.orm.insert(statementProfiles).values(record).run();
  } catch (error) {
    if (isUniqueConstraint(error)) throw new LedgerError("conflict", "Statement profile already exists");
    throw error;
  }
  return record;
}

export function findStatementProfileByFingerprint(
  db: Mon22rDb,
  userId: string,
  fingerprint: string,
): StatementProfileRecord | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select()
    .from(statementProfiles)
    .where(and(eq(statementProfiles.userId, owner), eq(statementProfiles.fingerprint, fingerprint)))
    .get();
  return row === undefined ? null : toStatementProfile(row);
}

export type ImportPreviewRecord = {
  readonly id: string;
  readonly userId: string;
  readonly source: string;
  readonly accountId: string | null;
  readonly linesJson: string;
  readonly createdAt: string;
};

export function insertImportPreview(
  db: Mon22rDb,
  userId: string,
  input: {
    readonly source: string;
    readonly accountId: string | null;
    readonly linesJson: string;
    readonly id?: string;
  },
): ImportPreviewRecord {
  const owner = assertUserId(userId);
  requireUserRow(db, owner);
  if (input.accountId !== null) requireAccount(db, owner, input.accountId);
  const record: ImportPreviewRecord = {
    id: input.id ?? randomUUID(),
    userId: owner,
    source: requiredLabel(input.source, "Import source is required"),
    accountId: input.accountId,
    linesJson: requiredLabel(input.linesJson, "Import preview is required"),
    createdAt: new Date().toISOString(),
  };
  db.orm.insert(importPreviews).values(record).run();
  return record;
}

export function readImportPreview(db: Mon22rDb, userId: string, id: string): ImportPreviewRecord | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select()
    .from(importPreviews)
    .where(and(eq(importPreviews.userId, owner), eq(importPreviews.id, id)))
    .get();
  return row === undefined ? null : toImportPreview(row);
}

export function updateImportPreviewAccount(
  db: Mon22rDb,
  userId: string,
  id: string,
  accountId: string,
): ImportPreviewRecord {
  const owner = assertUserId(userId);
  const existing = readImportPreview(db, owner, id);
  if (existing === null) throw new LedgerError("not_found", "Import preview was not found for this user");
  requireAccount(db, owner, accountId);
  const result = db.orm
    .update(importPreviews)
    .set({ accountId })
    .where(and(eq(importPreviews.userId, owner), eq(importPreviews.id, existing.id)))
    .run();
  if (result.changes === 0) throw new LedgerError("not_found", "Import preview was not found for this user");
  return { ...existing, accountId };
}

export function removeImportPreview(db: Mon22rDb, userId: string, id: string): void {
  const owner = assertUserId(userId);
  db.orm
    .delete(importPreviews)
    .where(and(eq(importPreviews.userId, owner), eq(importPreviews.id, id)))
    .run();
}

function rebuildTransaction(existing: Transaction, accountId: string, categoryId: string | null): Transaction {
  const shared = {
    id: existing.id,
    userId: existing.userId,
    accountId,
    amountMinor: existing.amountMinor,
    currency: existing.currency,
    occurredAt: existing.occurredAt,
    description: existing.description,
    createdAt: existing.createdAt,
    importIdentity: existing.importIdentity,
  };
  if (existing.kind === "transfer") {
    return createTransaction({
      ...shared,
      kind: "transfer",
      direction: existing.direction,
      transferGroupId: existing.transferGroupId ?? "",
      categoryId: null,
    });
  }
  if (existing.kind === "refund") {
    return createTransaction({
      ...shared,
      kind: "refund",
      categoryId,
      refundOfTransactionId: existing.refundOfTransactionId,
    });
  }
  if (existing.kind === "income") return createTransaction({ ...shared, kind: "income", categoryId });
  return createTransaction({ ...shared, kind: "expense", categoryId });
}

function onboardingStepOf(value: string | null): OnboardingStep | null {
  if (value === "timezone" || value === "accounts") return value;
  return null;
}

function requiredLabel(value: string, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LedgerError("invalid_posting", message);
  }
  return value;
}

function toStatementProfile(row: typeof statementProfiles.$inferSelect): StatementProfileRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    fingerprint: row.fingerprint,
    mappingJson: row.mappingJson,
    createdAt: row.createdAt,
  };
}

function toImportPreview(row: typeof importPreviews.$inferSelect): ImportPreviewRecord {
  return {
    id: row.id,
    userId: row.userId,
    source: row.source,
    accountId: row.accountId,
    linesJson: row.linesJson,
    createdAt: row.createdAt,
  };
}
