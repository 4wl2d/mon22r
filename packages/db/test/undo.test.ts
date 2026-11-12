import {
  createAccount,
  createUser,
  deleteLatestTransaction,
  deleteTransaction,
  findStatementProfileByFingerprint,
  findTransactionByImportKey,
  listTransactions,
  type Mon22rDb,
  migrate,
  openDatabase,
  readUserFlags,
  recordTransaction,
  recordTransfer,
  saveStatementProfile,
  updateStoredUser,
} from "@mon22r/db";
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

    const removed = deleteLatestTransaction(db, user.id);
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
});
