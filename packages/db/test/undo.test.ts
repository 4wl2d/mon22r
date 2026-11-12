import {
  createAccount,
  createIncomeExpectation,
  createUser,
  deleteLatestTransaction,
  deleteTransaction,
  findStatementProfileByFingerprint,
  findTransactionByImportKey,
  getIncomeExpectation,
  listTransactions,
  type Mon22rDb,
  matchInflowAndSave,
  migrate,
  openDatabase,
  readUserFlags,
  recordTransaction,
  recordTransfer,
  saveStatementProfile,
  updateAccount,
  updateStoredUser,
} from "@mon22r/db";
import { LedgerError } from "@mon22r/domain";
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

describe("undo", () => {
  it("deletes both legs of the latest transfer and leaves other rows", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", telegramId: 1, homeCurrency: "RSD" });
    const other = createUser(db, { id: "user-b", telegramId: 2, homeCurrency: "RSD" });
    const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
    const cash = createAccount(db, user.id, { id: "cash", name: "Наличные", currency: "RSD" });
    const otherCard = createAccount(db, other.id, { id: "other-card", name: "Other", currency: "RSD" });
    const otherCash = createAccount(db, other.id, { id: "other-cash", name: "Other cash", currency: "RSD" });
    recordTransaction(db, user.id, {
      id: "coffee",
      accountId: card.id,
      kind: "expense",
      amountMinor: 35_000,
      currency: "RSD",
      occurredAt: "2026-11-02T12:00:00.000Z",
      createdAt: "2026-11-02T12:00:00.000Z",
      importIdentity: { source: "sample", externalKey: "coffee-1" },
    });
    recordTransfer(db, user.id, {
      fromAccountId: card.id,
      toAccountId: cash.id,
      from: { minor: 500_000, currency: "RSD" },
      to: { minor: 500_000, currency: "RSD" },
      occurredAt: "2026-11-06T12:00:00.000Z",
      createdAt: "2026-11-06T12:00:00.000Z",
      transferGroupId: "group-1",
    });
    recordTransfer(db, other.id, {
      fromAccountId: otherCard.id,
      toAccountId: otherCash.id,
      from: { minor: 100, currency: "RSD" },
      to: { minor: 100, currency: "RSD" },
      occurredAt: "2026-11-06T12:00:00.000Z",
      createdAt: "2026-11-06T12:00:00.000Z",
      transferGroupId: "group-other",
    });

    const deleted = deleteLatestTransaction(db, user.id);
    expect(deleted.map((transaction) => transaction.transferGroupId)).toEqual(["group-1", "group-1"]);
    expect(listTransactions(db, user.id).map((transaction) => transaction.id)).toEqual(["coffee"]);
    expect(listTransactions(db, other.id)).toHaveLength(2);
    expect(deleteTransaction(db, other.id, "coffee")).toEqual([]);
    expect(listTransactions(db, user.id)).toHaveLength(1);

    // An imported statement line is not "the last thing I typed": undo leaves it alone.
    expect(deleteLatestTransaction(db, user.id)).toEqual([]);
    expect(listTransactions(db, user.id)).toHaveLength(1);
    const removed = deleteTransaction(db, user.id, "coffee");
    expect(removed.map((transaction) => transaction.id)).toEqual(["coffee"]);
    expect(findTransactionByImportKey(db, user.id, "sample", "coffee-1")).toBeNull();
    expect(listTransactions(db, user.id)).toEqual([]);
    expect(listTransactions(db, other.id)).toHaveLength(2);
  });

  it("undoes only the latest expense when it was inserted after a transfer", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD" });
    const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
    const cash = createAccount(db, user.id, { id: "cash", name: "Наличные", currency: "RSD" });
    recordTransfer(db, user.id, {
      fromAccountId: card.id,
      toAccountId: cash.id,
      from: { minor: 500_000, currency: "RSD" },
      to: { minor: 500_000, currency: "RSD" },
      occurredAt: "2026-11-06T12:00:00.000Z",
      createdAt: "2026-11-06T12:00:00.000Z",
    });
    recordTransaction(db, user.id, {
      id: "later",
      accountId: card.id,
      kind: "expense",
      amountMinor: 100,
      currency: "RSD",
      occurredAt: "2026-11-07T12:00:00.000Z",
      createdAt: "2026-11-07T12:00:00.000Z",
    });
    expect(deleteLatestTransaction(db, user.id).map((transaction) => transaction.id)).toEqual(["later"]);
    expect(listTransactions(db, user.id).filter((transaction) => transaction.kind === "transfer")).toHaveLength(2);
  });

  it("stores onboarding step and a statement profile per user", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", telegramId: 1, homeCurrency: "RSD" });
    const other = createUser(db, { id: "user-b", telegramId: 2, homeCurrency: "EUR" });
    updateStoredUser(db, user.id, {
      onboardingStep: "accounts",
      pendingCsvJson: '{"fingerprint":"a|b","headers":["A","B"]}',
    });
    expect(readUserFlags(db, user.id)).toEqual({
      onboardingStep: "accounts",
      pendingCsvJson: '{"fingerprint":"a|b","headers":["A","B"]}',
      defaultAccountId: null,
    });
    updateStoredUser(db, user.id, { onboardingStep: null, timeZone: "Europe/London" });
    expect(readUserFlags(db, user.id)?.onboardingStep).toBeNull();
    const profile = saveStatementProfile(db, user.id, {
      name: "sample",
      fingerprint: "date|amount",
      mappingJson: '{"date":"Date","amount":"Amount","description":"Details"}',
    });
    saveStatementProfile(db, user.id, {
      name: "ignored",
      fingerprint: "date|amount",
      mappingJson: '{"date":"Date","amount":"Sum","description":"Details"}',
    });
    expect(findStatementProfileByFingerprint(db, user.id, "date|amount")).toMatchObject({
      id: profile.id,
      name: "sample",
      mappingJson: '{"date":"Date","amount":"Sum","description":"Details"}',
    });
    expect(findStatementProfileByFingerprint(db, other.id, "date|amount")).toBeNull();
  });

  it("reopens an income line when the transaction that closed it is removed", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD" });
    const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
    const expectation = createIncomeExpectation(db, user.id, {
      id: "salary-nov",
      year: 2026,
      month: 11,
      name: "зп",
      expectedMinor: 18_000_000,
      currency: "RSD",
      accountId: card.id,
      dayOfMonth: 5,
    });
    const income = recordTransaction(db, user.id, {
      id: "salary",
      accountId: card.id,
      kind: "income",
      amountMinor: 18_000_000,
      currency: "RSD",
      occurredAt: "2026-11-05T09:00:00.000Z",
    }).transaction;
    expect(matchInflowAndSave(db, user.id, income.id)).toMatchObject({ status: "received", receivedMinor: 18_000_000 });

    deleteTransaction(db, user.id, income.id);
    expect(getIncomeExpectation(db, user.id, expectation.id)).toMatchObject({
      status: "expected",
      receivedMinor: 0,
      matchedTransactionId: null,
    });
  });

  it("keeps the default account valid: owned, active, and cleared when archived", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "EUR" });
    const other = createUser(db, { id: "user-b", homeCurrency: "EUR" });
    const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
    const foreign = createAccount(db, other.id, { id: "foreign", name: "Other", currency: "RSD" });

    expect(() => updateStoredUser(db, user.id, { defaultAccountId: foreign.id })).toThrow(LedgerError);
    updateStoredUser(db, user.id, { defaultAccountId: card.id });
    expect(readUserFlags(db, user.id)?.defaultAccountId).toBe(card.id);

    updateAccount(db, user.id, card.id, { archived: true });
    expect(readUserFlags(db, user.id)?.defaultAccountId).toBeNull();
    expect(() => updateStoredUser(db, user.id, { defaultAccountId: card.id })).toThrow(LedgerError);
  });
});
