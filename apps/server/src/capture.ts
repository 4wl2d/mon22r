import {
  createIncomePlan,
  listAccounts,
  listCategories,
  listIncomePlans,
  listOpenExpectations,
  listTransactions,
  type Mon22rDb,
  materializePlanExpectation,
  recordTransaction,
  recordTransfer,
  updateIncomeExpectation,
  updateIncomePlan,
} from "@mon22r/db";
import {
  type Account,
  type IncomeExpectation,
  type IncomePlan,
  matchInflowToExpectation,
  type Transaction,
  type User,
} from "@mon22r/domain";

import { normalizeNote, type ParsedPhrase, parsePhrase, rememberedCategoryId } from "./phrases.js";
import { refreshOpenExpectations } from "./plans.js";

export type CaptureResult =
  | {
      readonly type: "saved";
      readonly transaction: Transaction;
      readonly account: Account;
      readonly offer: { readonly expectationId: string; readonly name: string } | null;
    }
  | {
      readonly type: "transfer";
      readonly transactions: readonly [Transaction, Transaction];
      readonly from: Account;
      readonly to: Account;
    }
  | { readonly type: "plan"; readonly plan: IncomePlan; readonly expectation: IncomeExpectation }
  | { readonly type: "unparsed" }
  | { readonly type: "no_account"; readonly currency: string }
  | { readonly type: "no_destination"; readonly name: string }
  | { readonly type: "same_account" }
  | {
      readonly type: "currency_mismatch";
      readonly accountName: string;
      readonly accountCurrency: string;
      readonly amountCurrency: string;
    };

export function applyPhrase(db: Mon22rDb, user: User, text: string, now: Date): CaptureResult {
  const phrase = parsePhrase(text, now, user.timeZone);
  if (phrase === null) return { type: "unparsed" };
  const accounts = listAccounts(db, user.id);
  if (phrase.type === "plan") return applyPlan(db, user, phrase, accounts, now);
  if (phrase.type === "transfer") return applyTransfer(db, user, phrase, accounts, now);
  return applyMovement(db, user, phrase, accounts, now);
}

function applyMovement(
  db: Mon22rDb,
  user: User,
  phrase: Extract<ParsedPhrase, { type: "expense" | "income" }>,
  accounts: readonly Account[],
  now: Date,
): CaptureResult {
  const currency = phrase.currency ?? user.homeCurrency;
  const account = selectAccount(accounts, currency);
  if (account === null) return { type: "no_account", currency };
  const categoryId = categoryFor(db, user.id, phrase.note);
  const recorded = recordTransaction(db, user.id, {
    accountId: account.id,
    kind: phrase.type,
    amountMinor: phrase.amountMinor,
    currency,
    categoryId,
    occurredAt: phrase.occurredAt,
    description: phrase.note,
    createdAt: now.toISOString(),
  });
  const offer = phrase.type === "income" ? offerFor(db, user.id, recorded.transaction) : null;
  return { type: "saved", transaction: recorded.transaction, account, offer };
}

function applyTransfer(
  db: Mon22rDb,
  user: User,
  phrase: Extract<ParsedPhrase, { type: "transfer" }>,
  accounts: readonly Account[],
  now: Date,
): CaptureResult {
  const destination = findAccountByName(accounts, phrase.destinationName);
  if (destination === null) return { type: "no_destination", name: phrase.destinationName };
  const currency = phrase.currency ?? user.homeCurrency;
  if (destination.currency !== currency) {
    return {
      type: "currency_mismatch",
      accountName: destination.name,
      accountCurrency: destination.currency,
      amountCurrency: currency,
    };
  }
  const source = selectAccount(accounts, currency, destination.id);
  if (source === null) return { type: "same_account" };
  const pair = recordTransfer(db, user.id, {
    fromAccountId: source.id,
    toAccountId: destination.id,
    from: { minor: phrase.amountMinor, currency },
    to: { minor: phrase.amountMinor, currency: destination.currency },
    occurredAt: phrase.occurredAt,
    description: `на ${phrase.destinationName}`,
    createdAt: now.toISOString(),
  });
  return { type: "transfer", transactions: pair, from: source, to: destination };
}

function applyPlan(
  db: Mon22rDb,
  user: User,
  phrase: Extract<ParsedPhrase, { type: "plan" }>,
  accounts: readonly Account[],
  now: Date,
): CaptureResult {
  const currency = phrase.currency ?? user.homeCurrency;
  const account = selectAccount(accounts, currency);
  if (account === null) return { type: "no_account", currency };
  const existing = listIncomePlans(db, user.id).find(
    (plan) => plan.active && plan.currency === currency && normalizeNote(plan.name) === normalizeNote(phrase.name),
  );
  let plan = existing ?? null;
  if (plan !== null) {
    plan = updateIncomePlan(db, user.id, plan.id, {
      name: phrase.name,
      amountMinor: phrase.amountMinor,
      currency,
      dayOfMonth: phrase.dayOfMonth,
      accountId: account.id,
    });
  } else {
    plan = createIncomePlan(db, user.id, {
      name: phrase.name,
      amountMinor: phrase.amountMinor,
      currency,
      dayOfMonth: phrase.dayOfMonth,
      accountId: account.id,
      recurrence: "monthly",
      startYear: phrase.month.year,
      startMonth: phrase.month.month,
      remind: false,
      active: true,
    });
  }
  let expectation = materializePlanExpectation(db, user.id, plan.id, phrase.month);
  if (
    expectation.status === "expected" &&
    expectation.receivedMinor === 0 &&
    (expectation.expectedMinor !== plan.amountMinor ||
      expectation.dayOfMonth !== plan.dayOfMonth ||
      expectation.name !== plan.name ||
      expectation.accountId !== plan.accountId)
  ) {
    expectation = updateIncomeExpectation(db, user.id, expectation.id, {
      name: plan.name,
      expectedMinor: plan.amountMinor,
      dayOfMonth: plan.dayOfMonth,
      accountId: plan.accountId,
    });
  }
  refreshOpenExpectations(db, user.id, plan);
  return { type: "plan", plan, expectation };
}

function offerFor(
  db: Mon22rDb,
  userId: string,
  transaction: Transaction,
): { expectationId: string; name: string } | null {
  const match = matchInflowToExpectation(listOpenExpectations(db, userId), {
    id: transaction.id,
    userId,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    accountId: transaction.accountId,
  });
  if (match === null) return null;
  return { expectationId: match.expectation.id, name: match.expectation.name };
}

function categoryFor(db: Mon22rDb, userId: string, note: string): string | null {
  const known = new Set(listCategories(db, userId).map((category) => category.id));
  const remembered = rememberedCategoryId(note, listTransactions(db, userId));
  return remembered !== null && known.has(remembered) ? remembered : null;
}

export function selectAccount(accounts: readonly Account[], currency: string, exceptId?: string): Account | null {
  return (
    accounts.find((account) => !account.archived && account.currency === currency && account.id !== exceptId) ?? null
  );
}

export function findAccountByName(accounts: readonly Account[], name: string): Account | null {
  const key = normalizeNote(name);
  return accounts.find((account) => !account.archived && normalizeNote(account.name) === key) ?? null;
}
