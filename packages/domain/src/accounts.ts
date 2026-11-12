import { assertUserId, LedgerError } from "./errors.js";
import { assertCurrency, type CurrencyCode } from "./money.js";
import { assertTimeZone, canonicalTimestamp } from "./month.js";

export type User = {
  readonly id: string;
  readonly telegramId: number | null;
  readonly homeCurrency: CurrencyCode;
  readonly timeZone: string;
  readonly createdAt: string;
};

export type Account = {
  readonly id: string;
  readonly userId: string;
  /** One account keeps one currency for its whole life. */
  readonly currency: CurrencyCode;
  readonly name: string;
  readonly archived: boolean;
  readonly createdAt: string;
};

export type Category = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: string;
};

export function createUserProfile(input: {
  readonly id: string;
  readonly telegramId: number | null;
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly createdAt: string;
}): User {
  if (input.telegramId !== null && !Number.isSafeInteger(input.telegramId)) {
    throw new LedgerError("invalid_posting", "telegramId must be an integer");
  }
  return {
    id: assertId(input.id),
    telegramId: input.telegramId,
    homeCurrency: assertCurrency(input.homeCurrency),
    timeZone: assertTimeZone(input.timeZone),
    createdAt: canonicalTimestamp(input.createdAt),
  };
}

export function createAccount(input: {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly currency: string;
  readonly archived?: boolean;
  readonly createdAt: string;
}): Account {
  return {
    id: assertId(input.id),
    userId: assertUserId(input.userId),
    name: assertName(input.name),
    currency: assertCurrency(input.currency),
    archived: input.archived ?? false,
    createdAt: canonicalTimestamp(input.createdAt),
  };
}

export function createCategory(input: {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: string;
}): Category {
  return {
    id: assertId(input.id),
    userId: assertUserId(input.userId),
    name: assertName(input.name),
    createdAt: canonicalTimestamp(input.createdAt),
  };
}

export function assertOwnedAccount(account: Account | null, userId: string): Account {
  const owner = assertUserId(userId);
  if (account === null || account.userId !== owner) {
    throw new LedgerError("account_not_found", "Account was not found for this user");
  }
  return account;
}

export function assertAccountCurrency(account: Account, currency: CurrencyCode): void {
  if (account.currency !== currency) {
    throw new LedgerError(
      "currency_mismatch",
      `Account ${account.id} is ${account.currency} and cannot store ${currency}`,
    );
  }
}

export function assertOwnedCategory(category: Category | null, userId: string): Category {
  const owner = assertUserId(userId);
  if (category === null || category.userId !== owner) {
    throw new LedgerError("category_not_found", "Category was not found for this user");
  }
  return category;
}

function assertId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LedgerError("invalid_posting", "Id is required");
  }
  return value;
}

function assertName(value: string): string {
  if (typeof value !== "string") {
    throw new LedgerError("invalid_posting", "Name is required");
  }
  const name = value.trim();
  if (name.length === 0) {
    throw new LedgerError("invalid_posting", "Name is required");
  }
  return name;
}
