import type { CurrencyCode } from "./money.js";
import { DEFAULT_TIME_ZONE, zonedDateTimeToUtc } from "./month.js";
import { createTransaction, type Direction, type Transaction } from "./transactions.js";

/**
 * Port for a future bank adapter.
 * beginConsent, listAccounts, and pullSince are the whole surface.
 * Passwords, sessions, and internet-banking credentials are not part of this port and are never stored.
 */
export type BankConsent = {
  readonly consentId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
};

export type ExternalBankAccount = {
  readonly externalAccountId: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly mask: string | null;
};

/** One statement line. amountMinor is a positive magnitude; direction carries the sign. */
export type PulledStatementLine = {
  readonly externalKey: string;
  readonly bookedAt: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly direction: Direction;
  readonly description: string;
};

export type BeginConsentInput = {
  readonly userId: string;
  readonly redirectUrl: string;
};

export type ListBankAccountsInput = {
  readonly userId: string;
  readonly consentId: string;
};

export type PullSinceInput = {
  readonly userId: string;
  readonly consentId: string;
  readonly externalAccountId: string;
  /** Inclusive ISO date or timestamp. The adapter chooses the provider's cursor. */
  readonly since: string;
};

export interface BankConnector {
  beginConsent(input: BeginConsentInput): Promise<BankConsent>;
  listAccounts(input: ListBankAccountsInput): Promise<readonly ExternalBankAccount[]>;
  pullSince(input: PullSinceInput): Promise<readonly PulledStatementLine[]>;
}

/**
 * Map one pulled statement line into a transaction.
 * A date-only bookedAt is local midnight in `timeZone` (Europe/Belgrade by default).
 * Inflow becomes income and outflow becomes expense. Refunds and transfers stay a caller choice.
 */
export function transactionFromStatementLine(input: {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly source: string;
  readonly line: PulledStatementLine;
  readonly timeZone?: string;
  readonly categoryId?: string | null;
  readonly createdAt?: string;
}): Transaction {
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const kind = input.line.direction === "inflow" ? "income" : "expense";
  return createTransaction({
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    kind,
    amountMinor: input.line.amountMinor,
    currency: input.line.currency,
    categoryId: input.categoryId ?? null,
    occurredAt: occurredAtFromBooked(input.line.bookedAt, timeZone),
    description: input.line.description,
    createdAt: input.createdAt,
    importIdentity: { source: input.source, externalKey: input.line.externalKey },
  });
}

function occurredAtFromBooked(bookedAt: string, timeZone: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bookedAt);
  const year = dateOnly?.[1];
  const month = dateOnly?.[2];
  const day = dateOnly?.[3];
  if (year !== undefined && month !== undefined && day !== undefined) {
    return zonedDateTimeToUtc({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      timeZone,
    }).toISOString();
  }
  return bookedAt;
}
