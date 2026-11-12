import {
  claimUpdate,
  createCategory,
  createIncomePlan,
  findCategoryByName,
  isUpdateHandled,
  lastManualAccountId,
  listAccounts,
  listIncomePlans,
  listOpenExpectations,
  type Mon22rDb,
  materializePlanExpectation,
  readUserFlags,
  recordTransaction,
  recordTransfer,
  rememberedCategoryId,
  updateIncomeExpectation,
  updateIncomePlan,
} from "@mon22r/db";
import {
  type Account,
  type Category,
  type IncomeExpectation,
  type IncomePlan,
  matchInflowToExpectation,
  minorExponent,
  noteKey,
  type ParsedAmount,
  type Transaction,
  type User,
} from "@mon22r/domain";

import {
  type MovementPhrase,
  type PlanPhrase,
  parsePhrase,
  splitTrailingAmount,
  type TransferPhrase,
} from "./phrases.js";
import { refreshOpenExpectations } from "./plans.js";

export type CaptureResult =
  | {
      readonly type: "saved";
      readonly transaction: Transaction;
      readonly account: Account;
      /** Set when a `#tag` named a category that did not exist yet. */
      readonly createdCategory: Category | null;
    }
  | {
      readonly type: "transfer";
      readonly transactions: readonly [Transaction, Transaction];
      readonly from: Account;
      readonly to: Account;
    }
  | { readonly type: "plan"; readonly plan: IncomePlan; readonly expectation: IncomeExpectation }
  | { readonly type: "unparsed" }
  /** The same Telegram update was applied before; nothing was written now. */
  | { readonly type: "replayed" }
  | { readonly type: "no_account"; readonly currency: string }
  | { readonly type: "unknown_account"; readonly name: string }
  | { readonly type: "ambiguous_account"; readonly name: string; readonly candidates: readonly Account[] }
  | { readonly type: "same_account" }
  | { readonly type: "arrival_amount_required"; readonly from: Account; readonly to: Account }
  | {
      readonly type: "currency_mismatch";
      readonly accountName: string;
      readonly accountCurrency: string;
      readonly amountCurrency: string;
    };

type Wallet = {
  readonly accounts: readonly Account[];
  readonly defaultAccount: Account | null;
  /** Currency of an amount written without one. */
  readonly bareCurrency: string;
};

/**
 * Applies one chat line to the ledger.
 * With `updateId` the write and the "this update is done" mark share one SQLite transaction,
 * so a redelivered update returns `replayed` instead of writing a second time.
 */
export function applyPhrase(
  db: Mon22rDb,
  user: User,
  text: string,
  now: Date,
  options?: { readonly updateId?: number },
): CaptureResult {
  const updateId = options?.updateId;
  const apply = db.sqlite.transaction((): CaptureResult => {
    if (updateId !== undefined && isUpdateHandled(db, updateId)) return { type: "replayed" };
    const wallet = readWallet(db, user);
    const phrase = parsePhrase(text, now, user.timeZone, wallet.bareCurrency);
    if (phrase === null) return { type: "unparsed" };
    const result =
      phrase.type === "plan"
        ? applyPlan(db, user, phrase, wallet)
        : phrase.type === "transfer"
          ? applyTransfer(db, user, phrase, wallet, now)
          : applyMovement(db, user, phrase, wallet, now);
    const wrote = result.type === "saved" || result.type === "transfer" || result.type === "plan";
    if (wrote && updateId !== undefined) claimUpdate(db, updateId, now);
    return result;
  });
  return apply();
}

export function readWallet(db: Mon22rDb, user: User): Wallet {
  const accounts = listAccounts(db, user.id);
  const defaultId = readUserFlags(db, user.id)?.defaultAccountId ?? null;
  const defaultAccount = accounts.find((account) => account.id === defaultId && !account.archived) ?? null;
  return { accounts, defaultAccount, bareCurrency: defaultAccount?.currency ?? user.homeCurrency };
}

/**
 * Account for a new entry in `currency`: the default account when it holds that currency,
 * else the account the last hand-entered line of that currency went to, else the oldest active one.
 */
export function pickAccount(
  db: Mon22rDb,
  userId: string,
  wallet: Wallet,
  currency: string,
  exceptId?: string,
): Account | null {
  const usable = wallet.accounts.filter(
    (account) => !account.archived && account.currency === currency && account.id !== exceptId,
  );
  if (usable.length === 0) return null;
  const preferred = usable.find((account) => account.id === wallet.defaultAccount?.id);
  if (preferred !== undefined) return preferred;
  const lastId = lastManualAccountId(db, userId, currency);
  return usable.find((account) => account.id === lastId) ?? usable[0] ?? null;
}

/**
 * Active account by name. An exact name wins; otherwise the name may be any part of it
 * (`личная` finds `Карта личная`). `currency` narrows several matches down.
 */
export function findAccountByName(
  accounts: readonly Account[],
  name: string,
  options?: { readonly currency?: string; readonly exceptId?: string },
): { readonly account: Account | null; readonly candidates: readonly Account[] } {
  const wanted = noteKey(name);
  const active = accounts.filter((account) => !account.archived && account.id !== options?.exceptId);
  if (wanted.length === 0) return { account: null, candidates: [] };
  const exact = active.filter((account) => noteKey(account.name) === wanted);
  const partial = exact.length > 0 ? exact : active.filter((account) => noteKey(account.name).includes(wanted));
  if (partial.length <= 1) return { account: partial[0] ?? null, candidates: partial };
  const narrowed = options?.currency === undefined ? [] : partial.filter((item) => item.currency === options.currency);
  if (narrowed.length === 1) return { account: narrowed[0] ?? null, candidates: narrowed };
  return { account: null, candidates: narrowed.length > 1 ? narrowed : partial };
}

function applyMovement(db: Mon22rDb, user: User, phrase: MovementPhrase, wallet: Wallet, now: Date): CaptureResult {
  const currency = phrase.currency ?? wallet.bareCurrency;
  const account = pickAccount(db, user.id, wallet, currency);
  if (account === null) return { type: "no_account", currency };
  let categoryId = rememberedCategoryId(db, user.id, phrase.note);
  let createdCategory: Category | null = null;
  if (phrase.categoryName !== null) {
    let category = findCategoryByName(db, user.id, phrase.categoryName);
    if (category === null) {
      category = createCategory(db, user.id, { name: phrase.categoryName, createdAt: now.toISOString() });
      createdCategory = category;
    }
    categoryId = category.id;
  }
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
  return { type: "saved", transaction: recorded.transaction, account, createdCategory };
}

function applyTransfer(db: Mon22rDb, user: User, phrase: TransferPhrase, wallet: Wallet, now: Date): CaptureResult {
  let currency = phrase.currency ?? wallet.bareCurrency;
  let source: Account | null = null;
  if (phrase.sourceName !== null) {
    const found = findAccountByName(wallet.accounts, phrase.sourceName, { currency });
    if (found.account === null) return missingAccount(phrase.sourceName, found.candidates);
    source = found.account;
    if (source.currency !== currency) {
      // A bare amount takes the named account's currency when both use the same number of decimals.
      if (phrase.currency !== null || minorExponent(source.currency) !== minorExponent(currency)) {
        return mismatch(source, currency);
      }
      currency = source.currency;
    }
  }

  const destination = resolveDestination(wallet.accounts, phrase.destinationText, source, currency);
  if (destination.type !== "found") return destination.result;
  const to = destination.account;
  source ??= pickAccount(db, user.id, wallet, currency, to.id);
  if (source === null) {
    const sameCurrencyExists = wallet.accounts.some((account) => !account.archived && account.currency === currency);
    return sameCurrencyExists ? { type: "same_account" } : { type: "no_account", currency };
  }
  if (source.id === to.id) return { type: "same_account" };

  let arrivalMinor = phrase.amountMinor;
  if (destination.arrival !== null) {
    if (destination.arrival.currency !== null && destination.arrival.currency !== to.currency) {
      return mismatch(to, destination.arrival.currency);
    }
    arrivalMinor = destination.arrival.minor;
  } else if (to.currency !== source.currency) {
    return { type: "arrival_amount_required", from: source, to };
  }
  const pair = recordTransfer(db, user.id, {
    fromAccountId: source.id,
    toAccountId: to.id,
    from: { minor: phrase.amountMinor, currency: source.currency },
    to: { minor: arrivalMinor, currency: to.currency },
    occurredAt: phrase.occurredAt,
    description: `${source.name} → ${to.name}`,
    createdAt: now.toISOString(),
  });
  return { type: "transfer", transactions: pair, from: source, to };
}

/**
 * The text after `на` is an account name, or a name followed by the amount that arrived.
 * The whole text is tried as a name first, so an account called `Счёт 2` still works.
 */
function resolveDestination(
  accounts: readonly Account[],
  text: string,
  source: Account | null,
  currency: string,
):
  | { readonly type: "found"; readonly account: Account; readonly arrival: ParsedAmount | null }
  | { readonly type: "failed"; readonly result: CaptureResult } {
  const exceptId = source?.id;
  const whole = findAccountByName(accounts, text, { currency, exceptId });
  if (whole.account !== null) return { type: "found", account: whole.account, arrival: null };
  const split = splitTrailingAmount(text, currency);
  if (split === null) return { type: "failed", result: missingAccount(text, whole.candidates) };
  // With an arrival amount the accounts usually differ in currency, so the hint is the arrival currency if written.
  const named = findAccountByName(accounts, split.name, { currency: split.amount.currency ?? undefined, exceptId });
  let account = named.account;
  if (account === null && split.amount.currency === null) {
    // An arrival amount means a conversion, so among several matches the one in another currency is meant.
    const converted = named.candidates.filter((candidate) => candidate.currency !== currency);
    if (converted.length === 1) account = converted[0] ?? null;
  }
  if (account === null) return { type: "failed", result: missingAccount(split.name, named.candidates) };
  // Read the arrival amount again with the destination's decimal places.
  const arrival = splitTrailingAmount(text, account.currency)?.amount ?? split.amount;
  return { type: "found", account, arrival };
}

function applyPlan(db: Mon22rDb, user: User, phrase: PlanPhrase, wallet: Wallet): CaptureResult {
  const currency = phrase.currency ?? wallet.bareCurrency;
  const account = pickAccount(db, user.id, wallet, currency);
  if (account === null) return { type: "no_account", currency };
  const existing = listIncomePlans(db, user.id).find(
    (plan) => plan.active && plan.currency === currency && noteKey(plan.name) === noteKey(phrase.name),
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

/** Open income line this inflow could close, if any. Nothing is closed here. */
export function offerFor(
  db: Mon22rDb,
  userId: string,
  transaction: Transaction,
): { readonly expectationId: string; readonly name: string } | null {
  if (transaction.kind !== "income") return null;
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

function missingAccount(name: string, candidates: readonly Account[]): CaptureResult {
  if (candidates.length > 1) return { type: "ambiguous_account", name, candidates };
  return { type: "unknown_account", name };
}

function mismatch(account: Account, amountCurrency: string): CaptureResult {
  return {
    type: "currency_mismatch",
    accountName: account.name,
    accountCurrency: account.currency,
    amountCurrency,
  };
}
