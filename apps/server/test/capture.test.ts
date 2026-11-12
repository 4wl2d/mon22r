import {
  createAccount,
  createCategory,
  createUser,
  listCategories,
  listIncomeExpectations,
  listIncomePlans,
  listTransactions,
  type Mon22rDb,
  matchInflowAndSave,
  migrate,
  openDatabase,
  recordTransaction,
  updateAccount,
  updateStoredUser,
} from "@mon22r/db";
import { isTransaction, totalsByCurrency } from "@mon22r/domain";
import { afterEach, describe, expect, it } from "vitest";

import { applyPhrase, findAccountByName, offerFor } from "../src/capture.js";
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

/** A ledger with a EUR home currency, daily spending in RSD, and several accounts per currency. */
function multiAccountUser(db: Mon22rDb) {
  const user = createUser(db, { id: "user-a", telegramId: 1, homeCurrency: "EUR", timeZone: "Europe/Belgrade" });
  const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();
  const starter = createAccount(db, user.id, { id: "starter", name: "Карта", currency: "RSD", createdAt: at(1) });
  const personal = createAccount(db, user.id, {
    id: "personal",
    name: "Карта личная",
    currency: "RSD",
    createdAt: at(2),
  });
  const euro = createAccount(db, user.id, {
    id: "euro",
    name: "Счёт фирмы EUR",
    currency: "EUR",
    createdAt: at(3),
  });
  const business = createAccount(db, user.id, {
    id: "business",
    name: "Счёт фирмы",
    currency: "RSD",
    createdAt: at(4),
  });
  return { user, starter, personal, euro, business };
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
    expect(applyPhrase(db, user, "кофе 5 usd", now)).toEqual({ type: "no_account", currency: "USD" });
    expect(applyPhrase(db, user, "просто текст", now)).toEqual({ type: "unparsed" });
  });

  it("books a bare amount on the default account, in that account's currency", () => {
    const db = database();
    const { user, business } = multiAccountUser(db);
    // Without a default the amount is read in the home currency.
    expect(applyPhrase(db, user, "кофе 350", now)).toMatchObject({
      type: "saved",
      account: { id: "euro" },
      transaction: { currency: "EUR", amountMinor: 35_000 },
    });

    updateStoredUser(db, user.id, { defaultAccountId: business.id });
    expect(applyPhrase(db, user, "кофе 350", now)).toMatchObject({
      type: "saved",
      account: { id: "business" },
      transaction: { currency: "RSD", amountMinor: 35_000 },
    });
    // An explicit currency still wins over the default account.
    expect(applyPhrase(db, user, "обед 12 eur", now)).toMatchObject({ type: "saved", account: { id: "euro" } });

    // Archiving the default clears it, so capture falls back instead of writing to a closed account.
    updateAccount(db, user.id, business.id, { archived: true });
    expect(applyPhrase(db, user, "кофе 350", now)).toMatchObject({ type: "saved", account: { id: "euro" } });
  });

  it("keeps using the account the last hand-entered line of that currency went to", () => {
    const db = database();
    const { user, personal } = multiAccountUser(db);
    expect(applyPhrase(db, user, "рынок 900 rsd", now)).toMatchObject({ type: "saved", account: { id: "starter" } });
    // The user moves the entry with the account button; the next RSD line follows.
    recordTransaction(db, user.id, {
      accountId: personal.id,
      kind: "expense",
      amountMinor: 100,
      currency: "RSD",
      occurredAt: now.toISOString(),
      createdAt: new Date(now.getTime() + 1000).toISOString(),
    });
    expect(applyPhrase(db, user, "хлеб 120 rsd", new Date(now.getTime() + 2000))).toMatchObject({
      type: "saved",
      account: { id: "personal" },
    });
    // A statement import does not move the choice.
    recordTransaction(db, user.id, {
      accountId: "business",
      kind: "expense",
      amountMinor: 100,
      currency: "RSD",
      occurredAt: now.toISOString(),
      createdAt: new Date(now.getTime() + 3000).toISOString(),
      importIdentity: { source: "bank", externalKey: "line-1" },
    });
    expect(applyPhrase(db, user, "молоко 150 rsd", new Date(now.getTime() + 4000))).toMatchObject({
      type: "saved",
      account: { id: "personal" },
    });
  });

  it("applies a tagged category, creating it once, and remembers it for the same note", () => {
    const db = database();
    const user = readyUser(db);
    const first = applyPhrase(db, user, "кофе 350 #Кафе", now);
    expect(first).toMatchObject({ type: "saved", createdCategory: { name: "Кафе" } });
    const again = applyPhrase(db, user, "обед 900 #кафе", now);
    expect(again).toMatchObject({ type: "saved", createdCategory: null });
    expect(listCategories(db, user.id).map((category) => category.name)).toEqual(["Кафе"]);
    const remembered = applyPhrase(db, user, "Кофе 200", new Date(now.getTime() + 1000));
    if (first.type !== "saved" || remembered.type !== "saved") throw new Error("expected saved entries");
    expect(remembered.transaction.categoryId).toBe(first.transaction.categoryId);
    expect(applyPhrase(db, user, "такси 10", now)).toMatchObject({ type: "saved", transaction: { categoryId: null } });
  });

  it("records a refund that lowers spending instead of counting as income", () => {
    const db = database();
    const user = readyUser(db);
    applyPhrase(db, user, "кроссовки 9000 #одежда", now);
    const refund = applyPhrase(db, user, "возврат кроссовки 9000", new Date(now.getTime() + 1000));
    expect(refund).toMatchObject({ type: "saved", transaction: { kind: "refund", direction: "inflow" } });
    expect(totalsByCurrency(listTransactions(db, user.id))).toEqual([
      { currency: "RSD", incomeMinor: 0, expenseMinor: 0 },
    ]);
  });

  it("applies a Telegram update once, even if it is delivered again", () => {
    const db = database();
    const user = readyUser(db);
    expect(applyPhrase(db, user, "кофе 350", now, { updateId: 700 }).type).toBe("saved");
    expect(applyPhrase(db, user, "кофе 350", now, { updateId: 700 })).toEqual({ type: "replayed" });
    expect(listTransactions(db, user.id)).toHaveLength(1);
    // The same text in a new message is a new purchase.
    expect(applyPhrase(db, user, "кофе 350", now, { updateId: 701 }).type).toBe("saved");
    // A line that wrote nothing can be retried after the user fixes the cause.
    expect(applyPhrase(db, user, "кофе 5 usd", now, { updateId: 702 }).type).toBe("no_account");
    createAccount(db, user.id, { name: "Dollars", currency: "USD" });
    expect(applyPhrase(db, user, "кофе 5 usd", now, { updateId: 702 }).type).toBe("saved");
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
    expect(income).toMatchObject({ type: "saved", transaction: { kind: "income", amountMinor: 18_000_000 } });
    if (income.type !== "saved") return;
    expect(offerFor(db, user.id, income.transaction)).toMatchObject({ name: "зп" });
    expect(listIncomeExpectations(db, user.id, { year: 2026, month: 12 })[0]?.status).toBe("expected");
    const closed = matchInflowAndSave(db, user.id, income.transaction.id);
    expect(closed?.status).toBe("received");
    expect(offerFor(db, user.id, income.transaction)).toBeNull();
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

    createAccount(db, user.id, { name: "Наличные", currency: "RSD" });
    const before = listTransactions(db, user.id).length;
    const transfer = applyPhrase(db, user, "перевод 5000 на наличные", now);
    expect(transfer.type).toBe("transfer");
    if (transfer.type !== "transfer") return;
    expect(transfer.to.name).toBe("Наличные");
    expect(transfer.transactions.map((transaction) => transaction.kind)).toEqual(["transfer", "transfer"]);
    expect(totalsByCurrency([...transfer.transactions])).toEqual([]);
    expect(listTransactions(db, user.id)).toHaveLength(before + 2);
  });

  it("moves money between named accounts, including a conversion with the amount that arrived", () => {
    const db = database();
    const { user } = multiAccountUser(db);
    const conversion = applyPhrase(db, user, "перевод 500 eur на фирмы 58600", now);
    expect(conversion).toMatchObject({
      type: "transfer",
      from: { id: "euro" },
      to: { id: "business" },
      transactions: [
        { direction: "outflow", amountMinor: 50_000, currency: "EUR" },
        { direction: "inflow", amountMinor: 5_860_000, currency: "RSD" },
      ],
    });

    const named = applyPhrase(db, user, "перевод 3000 rsd с фирмы на личная", now);
    expect(named).toMatchObject({ type: "transfer", from: { id: "business" }, to: { id: "personal" } });

    // A conversion needs the arrived amount: guessing a rate would put a wrong number in the ledger.
    expect(applyPhrase(db, user, "перевод 500 eur на личная", now)).toMatchObject({
      type: "arrival_amount_required",
      from: { id: "euro" },
      to: { id: "personal" },
    });
    expect(applyPhrase(db, user, "перевод 500 rsd на карта", now)).toMatchObject({
      type: "transfer",
      to: { id: "starter" },
    });
    expect(applyPhrase(db, user, "перевод 500 rsd на сбер", now)).toEqual({ type: "unknown_account", name: "сбер" });
    expect(applyPhrase(db, user, "перевод 500 rsd с личная на личная", now)).toMatchObject({ type: "unknown_account" });
    expect(listTransactions(db, user.id).filter((row) => row.kind === "transfer")).toHaveLength(6);
  });

  it("finds an account by any part of its name and asks when several fit", () => {
    const db = database();
    const { user, starter, personal, euro, business } = multiAccountUser(db);
    const accounts = [starter, personal, euro, business];
    expect(findAccountByName(accounts, "Карта").account?.id).toBe("starter");
    expect(findAccountByName(accounts, "личная").account?.id).toBe("personal");
    expect(findAccountByName(accounts, "фирмы").account).toBeNull();
    expect(findAccountByName(accounts, "фирмы").candidates.map((account) => account.id)).toEqual(["euro", "business"]);
    expect(findAccountByName(accounts, "фирмы", { currency: "RSD" }).account?.id).toBe("business");
    expect(findAccountByName(accounts, "фирмы", { exceptId: "euro" }).account?.id).toBe("business");
    expect(applyPhrase(db, user, "перевод 100 usd на фирмы", now)).toMatchObject({
      type: "ambiguous_account",
      name: "фирмы",
    });
  });
});
