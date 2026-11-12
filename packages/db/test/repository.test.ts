import {
  createAccount,
  createIncomePlan,
  createUser,
  findTransactionByImportKey,
  getTransaction,
  initialSchemaSql,
  listAccounts,
  listImportKeys,
  listTransactions,
  type Mon22rDb,
  matchInflowAndSave,
  materializePlanExpectation,
  migrate,
  openDatabase,
  recordTransaction,
  recordTransfer,
  updateIncomeExpectation,
  upsertFxRate,
} from "@mon22r/db";

import { EXPECTATION_STATUSES, isTransaction, LedgerError } from "@mon22r/domain";
import { afterEach, describe, expect, it } from "vitest";

const open: Mon22rDb[] = [];

function database(): Mon22rDb {
  const db = openDatabase(":memory:");
  migrate(db);
  migrate(db);
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

describe("sqlite ledger", () => {
  it("keeps the expectation statuses in the schema", () => {
    for (const status of EXPECTATION_STATUSES) {
      expect(initialSchemaSql).toContain(`'${status}'`);
    }
  });

  it("does not insert a second transaction for the same external key", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", telegramId: 101, homeCurrency: "RSD" });
    const other = createUser(db, { id: "user-b", telegramId: 202, homeCurrency: "EUR" });
    const account = createAccount(db, user.id, { id: "acct-a", name: "Поштанска", currency: "RSD" });
    const otherAccount = createAccount(db, other.id, { id: "acct-b", name: "Other", currency: "EUR" });

    const first = recordTransaction(db, user.id, {
      id: "tx-1",
      accountId: account.id,
      kind: "expense",
      amountMinor: 120_050,
      currency: "RSD",
      occurredAt: "2026-11-03T10:00:00.000Z",
      description: "shop",
      importIdentity: { source: "tbank-csv", externalKey: "line-1" },
    });
    const repeated = recordTransaction(db, user.id, {
      id: "tx-2",
      accountId: account.id,
      kind: "expense",
      amountMinor: 1,
      currency: "RSD",
      occurredAt: "2026-11-04T10:00:00.000Z",
      importIdentity: { source: "tbank-csv", externalKey: "line-1" },
    });
    const sameKeyOtherUser = recordTransaction(db, other.id, {
      id: "tx-3",
      accountId: otherAccount.id,
      kind: "expense",
      amountMinor: 450,
      currency: "EUR",
      occurredAt: "2026-11-03T10:00:00.000Z",
      importIdentity: { source: "tbank-csv", externalKey: "line-1" },
    });

    expect(first.status).toBe("created");
    expect(repeated.status).toBe("duplicate");
    expect(repeated.transaction.id).toBe("tx-1");
    expect(repeated.transaction.amountMinor).toBe(120_050);
    expect(listTransactions(db, user.id)).toHaveLength(1);
    expect(findTransactionByImportKey(db, user.id, "tbank-csv", "line-1")?.id).toBe("tx-1");
    expect(listImportKeys(db, user.id, "tbank-csv")).toEqual([{ externalKey: "line-1", transactionId: "tx-1" }]);
    expect(sameKeyOtherUser.status).toBe("created");
    expect(listTransactions(db, user.id).map((transaction) => transaction.userId)).toEqual(["user-a"]);
    expect(listTransactions(db, other.id).map((transaction) => transaction.id)).toEqual(["tx-3"]);
    expect(listAccounts(db, user.id).map((item) => item.id)).toEqual(["acct-a"]);
    expect(() =>
      recordTransaction(db, user.id, {
        accountId: otherAccount.id,
        kind: "expense",
        amountMinor: 450,
        currency: "EUR",
        occurredAt: "2026-11-03T10:00:00.000Z",
      }),
    ).toThrow(LedgerError);
  });

  it("stores an income plan without a transaction and then matches a real inflow", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD", timeZone: "Europe/Belgrade" });
    const account = createAccount(db, user.id, { id: "acct-a", name: "Рубли", currency: "RSD" });
    const plan = createIncomePlan(db, user.id, {
      id: "plan-salary",
      name: "зп",
      amountMinor: 100_000,
      currency: "RSD",
      dayOfMonth: 5,
      accountId: account.id,
      recurrence: "monthly",
      startYear: 2026,
      startMonth: 11,
    });
    const expectation = materializePlanExpectation(db, user.id, plan.id, { year: 2026, month: 11 }, "exp-1");
    const again = materializePlanExpectation(db, user.id, plan.id, { year: 2026, month: 11 });
    expect(again.id).toBe(expectation.id);
    expect(expectation.status).toBe("expected");
    expect(isTransaction(expectation)).toBe(false);
    expect(listTransactions(db, user.id)).toEqual([]);

    const income = recordTransaction(db, user.id, {
      id: "pay-1",
      accountId: account.id,
      kind: "income",
      amountMinor: 100_000,
      currency: "RSD",
      occurredAt: "2026-11-05T09:00:00.000Z",
      description: "зп",
    });
    const matched = matchInflowAndSave(db, user.id, income.transaction.id);
    expect(income.status).toBe("created");
    expect(matched).toMatchObject({
      id: "exp-1",
      status: "received",
      receivedMinor: 100_000,
      matchedTransactionId: "pay-1",
    });
    expect(listTransactions(db, user.id).map((transaction) => transaction.id)).toEqual(["pay-1"]);
    expect(() => updateIncomeExpectation(db, "someone-else", expectation.id, { status: "skipped" })).toThrow(
      LedgerError,
    );
  });

  it("records a transfer as two legs and does not rewrite amounts when a rate is saved", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD" });
    const card = createAccount(db, user.id, { id: "card", name: "Card", currency: "RSD" });
    const cash = createAccount(db, user.id, { id: "cash", name: "Cash", currency: "RSD" });
    const spent = recordTransaction(db, user.id, {
      id: "spent",
      accountId: card.id,
      kind: "expense",
      amountMinor: 35_050,
      currency: "RSD",
      occurredAt: "2026-11-02T12:00:00.000Z",
    });
    const [outflow, inflow] = recordTransfer(db, user.id, {
      fromAccountId: card.id,
      toAccountId: cash.id,
      from: { minor: 500_000, currency: "RSD" },
      to: { minor: 500_000, currency: "RSD" },
      occurredAt: "2026-11-06T12:00:00.000Z",
      description: "на наличные",
      transferGroupId: "group-1",
    });
    upsertFxRate(db, {
      baseCurrency: "EUR",
      quoteCurrency: "RSD",
      numerator: 11_720,
      denominator: 100,
      asOf: "2026-11-10",
      source: "ecb",
    });
    expect(outflow.transferGroupId).toBe("group-1");
    expect(inflow.transferGroupId).toBe(outflow.transferGroupId);
    const refund = recordTransaction(db, user.id, {
      id: "refund-1",
      accountId: card.id,
      kind: "refund",
      amountMinor: 5_000,
      currency: "RSD",
      refundOfTransactionId: spent.transaction.id,
      occurredAt: "2026-11-07T12:00:00.000Z",
    });
    expect(refund.status).toBe("created");
    expect(getTransaction(db, user.id, "refund-1")).toMatchObject({
      kind: "refund",
      direction: "inflow",
      categoryId: null,
      refundOfTransactionId: "spent",
      amountMinor: 5_000,
    });
    expect(getTransaction(db, user.id, spent.transaction.id)?.amountMinor).toBe(35_050);
    expect(listTransactions(db, user.id).filter((transaction) => transaction.kind === "transfer")).toHaveLength(2);
  });
});
