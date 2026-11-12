import {
  createAccount,
  createCategory,
  createUser,
  listIncomeExpectations,
  listIncomePlans,
  listTransactions,
  type Mon22rDb,
  matchInflowAndSave,
  migrate,
  openDatabase,
  recordTransaction,
} from "@mon22r/db";
import { isTransaction, totalsByCurrency } from "@mon22r/domain";
import { afterEach, describe, expect, it } from "vitest";

import { applyPhrase } from "../src/capture.js";
import { createStarterAccounts } from "../src/starter.js";

const open: Mon22rDb[] = [];
const now = new Date("2026-11-12T10:00:00.000Z");

function database(): Mon22rDb {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

function readyUser(db: Mon22rDb) {
  const user = createUser(db, { id: "user-a", telegramId: 1, homeCurrency: "RSD", timeZone: "Europe/Belgrade" });
  createStarterAccounts(db, user.id);
  return user;
}

describe("capture", () => {
  it("records an expense in the home currency and a currency-specific account", () => {
    const db = database();
    const user = readyUser(db);
    const coffee = applyPhrase(db, user, "кофе 350", now);
    expect(coffee).toMatchObject({
      type: "saved",
      account: { name: "Поштанска", currency: "RSD" },
      transaction: { kind: "expense", amountMinor: 35_000, currency: "RSD", categoryId: null, description: "кофе" },
    });
    const pounds = applyPhrase(db, user, "кофе 4.50 gbp", now);
    expect(pounds).toMatchObject({
      type: "saved",
      account: { name: "UK", currency: "GBP" },
      transaction: { kind: "expense", amountMinor: 450, currency: "GBP", categoryId: null },
    });
  });

  it("creates or updates next month's income plan without a transaction", () => {
    const db = database();
    const user = readyUser(db);
    const first = applyPhrase(db, user, "план зп 180000 5", now);
    expect(first.type).toBe("plan");
    if (first.type !== "plan") return;
    expect(isTransaction(first.plan)).toBe(false);
    expect(isTransaction(first.expectation)).toBe(false);
    expect(first.expectation).toMatchObject({
      year: 2026,
      month: 12,
      dayOfMonth: 5,
      expectedMinor: 18_000_000,
      status: "expected",
    });
    expect(listTransactions(db, user.id)).toEqual([]);

    const second = applyPhrase(db, user, "план зп 90000 7", now);
    expect(second.type).toBe("plan");
    if (second.type !== "plan") return;
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.expectation.expectedMinor).toBe(9_000_000);
    expect(second.expectation.dayOfMonth).toBe(7);
    expect(listIncomePlans(db, user.id)).toHaveLength(1);
    expect(listIncomeExpectations(db, user.id, { year: 2026, month: 12 })).toHaveLength(1);
    expect(listTransactions(db, user.id)).toEqual([]);
  });

  it("offers to close a matching plan line and does not close it by itself", () => {
    const db = database();
    const user = readyUser(db);
    applyPhrase(db, user, "план зп 180000 5", now);
    const income = applyPhrase(db, user, "+зп 180000", now);
    expect(income).toMatchObject({
      type: "saved",
      transaction: { kind: "income", amountMinor: 18_000_000 },
      offer: { name: "зп" },
    });
    const openExpectation = listIncomeExpectations(db, user.id, { year: 2026, month: 12 })[0];
    expect(openExpectation?.status).toBe("expected");
    expect(income.type === "saved" ? income.transaction.kind : null).toBe("income");
    if (income.type !== "saved") return;
    const closed = matchInflowAndSave(db, user.id, income.transaction.id);
    expect(closed?.status).toBe("received");
    expect(listTransactions(db, user.id).map((transaction) => transaction.kind)).toEqual(["income"]);
  });

  it("remembers a category and keeps a transfer out of income and expense", () => {
    const db = database();
    const user = readyUser(db);
    const food = createCategory(db, user.id, { name: "еда" });
    const card = createAccount(db, user.id, { name: "Поштанска extra", currency: "RSD" });
    recordTransaction(db, user.id, {
      accountId: card.id,
      kind: "expense",
      amountMinor: 100,
      currency: "RSD",
      categoryId: food.id,
      occurredAt: "2026-11-01T10:00:00.000Z",
      description: "кофе",
      createdAt: "2026-11-01T10:00:00.000Z",
    });
    const again = applyPhrase(db, user, "кофе 200", now);
    expect(again).toMatchObject({ type: "saved", transaction: { categoryId: food.id, amountMinor: 20_000 } });
    const taxi = applyPhrase(db, user, "такси 10", now);
    expect(taxi).toMatchObject({ type: "saved", transaction: { categoryId: null } });

    createAccount(db, user.id, { name: "Наличные", currency: "RSD" });
    const before = listTransactions(db, user.id).length;
    const transfer = applyPhrase(db, user, "перевод 5000 на наличные", now);
    expect(transfer.type).toBe("transfer");
    if (transfer.type !== "transfer") return;
    expect(transfer.transactions.map((transaction) => transaction.kind)).toEqual(["transfer", "transfer"]);
    expect(totalsByCurrency([...transfer.transactions])).toEqual([]);
    expect(listTransactions(db, user.id)).toHaveLength(before + 2);
    expect(listTransactions(db, user.id).filter((transaction) => transaction.kind === "transfer")).toHaveLength(2);
  });
});
