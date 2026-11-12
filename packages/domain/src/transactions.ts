import { assertUserId, LedgerError } from "./errors.js";
import { assertCurrency, assertPositiveMinor, type CurrencyCode, type Money } from "./money.js";
import { canonicalTimestamp } from "./month.js";

export const TRANSACTION_KINDS = ["expense", "income", "refund", "transfer"] as const;
export const DIRECTIONS = ["inflow", "outflow"] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];
export type Direction = (typeof DIRECTIONS)[number];

/**
 * Stable identity of one imported statement line.
 * `source` is the profile name (`tbank-csv`, not a per-file random id).
 * The same user, source, and externalKey must not create a second transaction.
 */
export type ImportIdentity = {
  readonly source: string;
  readonly externalKey: string;
};

export type Transaction = {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  /** Null means uncategorized. Do not invent a category row for that state. */
  readonly categoryId: string | null;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly direction: Direction;
  readonly kind: TransactionKind;
  readonly transferGroupId: string | null;
  readonly refundOfTransactionId: string | null;
  readonly occurredAt: string;
  readonly description: string;
  readonly createdAt: string;
  readonly importIdentity: ImportIdentity | null;
};

type TransactionBase = {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredAt: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly categoryId?: string | null;
  readonly importIdentity?: ImportIdentity | null;
};

export type CreateTransactionInput =
  | (TransactionBase & { readonly kind: "expense" })
  | (TransactionBase & { readonly kind: "income" })
  | (TransactionBase & { readonly kind: "refund"; readonly refundOfTransactionId?: string | null })
  | (TransactionBase & {
      readonly kind: "transfer";
      readonly direction: Direction;
      readonly transferGroupId: string;
      readonly categoryId?: null;
    });

/**
 * Build one ledger transaction.
 * Amounts stay positive minor units; direction carries the sign.
 * A refund is an inflow. Its categoryId is the original category whose spend it reduces.
 */
export function createTransaction(input: CreateTransactionInput): Transaction {
  const userId = assertUserId(input.userId);
  const amountMinor = assertPositiveMinor(input.amountMinor);
  const occurredAt = canonicalTimestamp(input.occurredAt);
  const createdAt = canonicalTimestamp(input.createdAt ?? occurredAt);
  const categoryId = input.categoryId ?? null;
  const importIdentity = normalizeImportIdentity(input.importIdentity ?? null);
  const description = input.description ?? "";
  if (input.kind === "transfer") {
    if (categoryId !== null) {
      throw new LedgerError("invalid_posting", "A transfer has no category");
    }
    return {
      id: requiredId(input.id),
      userId,
      accountId: requiredId(input.accountId),
      categoryId: null,
      amountMinor,
      currency: assertCurrency(input.currency),
      direction: input.direction,
      kind: "transfer",
      transferGroupId: requiredId(input.transferGroupId),
      refundOfTransactionId: null,
      occurredAt,
      description,
      createdAt,
      importIdentity,
    };
  }
  const direction: Direction = input.kind === "expense" ? "outflow" : "inflow";
  const refundOfTransactionId =
    input.kind === "refund" ? normalizeOptionalId(input.refundOfTransactionId ?? null) : null;
  return {
    id: requiredId(input.id),
    userId,
    accountId: requiredId(input.accountId),
    categoryId,
    amountMinor,
    currency: assertCurrency(input.currency),
    direction,
    kind: input.kind,
    transferGroupId: null,
    refundOfTransactionId,
    occurredAt,
    description,
    createdAt,
    importIdentity,
  };
}

/** Two legs that share transferGroupId. Neither leg is income or expense. */
export function createTransfer(input: {
  readonly userId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly from: Money;
  readonly to: Money;
  readonly occurredAt: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly outflowId: string;
  readonly inflowId: string;
  readonly transferGroupId: string;
}): readonly [Transaction, Transaction] {
  if (input.fromAccountId === input.toAccountId) {
    throw new LedgerError("invalid_posting", "A transfer needs two different accounts");
  }
  const group = requiredId(input.transferGroupId);
  const shared = {
    userId: input.userId,
    occurredAt: input.occurredAt,
    description: input.description ?? "",
    createdAt: input.createdAt,
    kind: "transfer" as const,
    transferGroupId: group,
    categoryId: null,
    importIdentity: null,
  };
  const outflow = createTransaction({
    ...shared,
    id: input.outflowId,
    accountId: input.fromAccountId,
    amountMinor: input.from.minor,
    currency: input.from.currency,
    direction: "outflow",
  });
  const inflow = createTransaction({
    ...shared,
    id: input.inflowId,
    accountId: input.toAccountId,
    amountMinor: input.to.minor,
    currency: input.to.currency,
    direction: "inflow",
  });
  return [outflow, inflow];
}

export function isTransaction(value: unknown): value is Transaction {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "expense" || kind === "income" || kind === "refund" || kind === "transfer";
}

export type AppendTransactionResult = {
  readonly status: "created" | "duplicate";
  readonly transactions: readonly Transaction[];
  /** The stored transaction. On a duplicate this is the original row, not the rejected input. */
  readonly transaction: Transaction;
};

/**
 * Append a transaction unless the same user already has this statement identity.
 * Manual transactions have a null import identity and are never collapsed.
 */
export function appendTransaction(existing: readonly Transaction[], transaction: Transaction): AppendTransactionResult {
  const duplicate = findImportedDuplicate(existing, transaction);
  if (duplicate) {
    return { status: "duplicate", transactions: existing, transaction: duplicate };
  }
  return {
    status: "created",
    transactions: [...existing, transaction],
    transaction,
  };
}

export function findImportedDuplicate(
  existing: readonly Transaction[],
  candidate: Pick<Transaction, "userId" | "importIdentity">,
): Transaction | null {
  const identity = candidate.importIdentity;
  if (identity === null) return null;
  for (const transaction of existing) {
    if (transaction.userId !== candidate.userId || transaction.importIdentity === null) continue;
    if (
      transaction.importIdentity.source === identity.source &&
      transaction.importIdentity.externalKey === identity.externalKey
    ) {
      return transaction;
    }
  }
  return null;
}

function normalizeImportIdentity(value: ImportIdentity | null): ImportIdentity | null {
  if (value === null) return null;
  if (
    typeof value.source !== "string" ||
    typeof value.externalKey !== "string" ||
    value.source.length === 0 ||
    value.externalKey.length === 0 ||
    value.source.trim() !== value.source ||
    value.externalKey.trim() !== value.externalKey
  ) {
    throw new LedgerError("invalid_posting", "Import source and external key must both be non-empty");
  }
  return { source: value.source, externalKey: value.externalKey };
}

function normalizeOptionalId(value: string | null): string | null {
  if (value === null) return null;
  return requiredId(value);
}

function requiredId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LedgerError("invalid_posting", "Id is required");
  }
  return value;
}
