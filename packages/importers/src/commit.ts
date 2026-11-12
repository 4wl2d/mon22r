import { randomUUID } from "node:crypto";

import { transactionFromStatementLine, type PulledStatementLine, type Transaction } from "@mon22r/domain";

export type CommitRecordInput = {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "expense" | "income";
  readonly amountMinor: number;
  readonly currency: string;
  readonly categoryId: string | null;
  readonly occurredAt: string;
  readonly description: string;
  readonly createdAt: string;
  readonly importIdentity: { readonly source: string; readonly externalKey: string };
};

export type CommitResult = {
  readonly created: number;
  readonly duplicate: number;
  readonly transactions: readonly Transaction[];
};

/**
 * Writes statement lines through the ledger.
 * `record` is `recordTransaction`: the same (userId, source, externalKey) inserts nothing.
 */
export function commitStatementLines(input: {
  readonly userId: string;
  readonly accountId: string;
  readonly source: string;
  readonly timeZone: string;
  readonly lines: readonly PulledStatementLine[];
  readonly now?: Date;
  readonly record: (row: CommitRecordInput) => { readonly status: "created" | "duplicate"; readonly transaction: Transaction };
}): CommitResult {
  const createdAt = (input.now ?? new Date()).toISOString();
  let created = 0;
  let duplicate = 0;
  const transactions: Transaction[] = [];
  for (const line of input.lines) {
    const draft = transactionFromStatementLine({
      id: randomUUID(),
      userId: input.userId,
      accountId: input.accountId,
      source: input.source,
      line,
      timeZone: input.timeZone,
      categoryId: null,
      createdAt,
    });
    const identity = draft.importIdentity;
    if (identity === null || (draft.kind !== "income" && draft.kind !== "expense")) continue;
    const result = input.record({
      id: draft.id,
      accountId: draft.accountId,
      kind: draft.kind,
      amountMinor: draft.amountMinor,
      currency: draft.currency,
      categoryId: null,
      occurredAt: draft.occurredAt,
      description: draft.description,
      createdAt: draft.createdAt,
      importIdentity: identity,
    });
    if (result.status === "duplicate") {
      duplicate += 1;
      continue;
    }
    created += 1;
    transactions.push(result.transaction);
  }
  return { created, duplicate, transactions };
}
