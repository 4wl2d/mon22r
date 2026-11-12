import {
  createAccount,
  createUser,
  getTransaction,
  type Mon22rDb,
  migrate,
  openDatabase,
  recordTransaction,
  upsertFxRate,
} from "@mon22r/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildMonthView } from "../src/month-view.js";

const open: Mon22rDb[] = [];

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

describe("month estimate", () => {
  it("returns null when a rate is missing and leaves the transaction amount alone", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD", timeZone: "Europe/Belgrade" });
    const uk = createAccount(db, user.id, { id: "uk", name: "UK", currency: "GBP" });
    const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
    recordTransaction(db, user.id, {
      id: "pounds",
      accountId: uk.id,
      kind: "expense",
      amountMinor: 450,
      currency: "GBP",
      occurredAt: "2026-11-12T10:00:00.000Z",
    });
    recordTransaction(db, user.id, {
      id: "dinars",
      accountId: card.id,
      kind: "expense",
      amountMinor: 35_000,
      currency: "RSD",
      occurredAt: "2026-11-12T11:00:00.000Z",
    });
    const missing = buildMonthView(db, user, { year: 2026, month: 11 });
    expect(missing.estimateInHomeCurrency).toBeNull();
    expect(missing.totalsByCurrency).toEqual([
      { currency: "GBP", incomeMinor: 0, expenseMinor: 450 },
      { currency: "RSD", incomeMinor: 0, expenseMinor: 35_000 },
    ]);
    expect(getTransaction(db, user.id, "pounds")?.amountMinor).toBe(450);

    upsertFxRate(db, {
      baseCurrency: "GBP",
      quoteCurrency: "RSD",
      numerator: 150,
      denominator: 1,
      asOf: "2026-11-12",
      source: "ecb",
    });
    const estimated = buildMonthView(db, user, { year: 2026, month: 11 });
    expect(estimated.estimateInHomeCurrency).toMatchObject({
      kind: "estimate",
      currency: "RSD",
      usedConversion: true,
      asOf: "2026-11-12",
    });
    expect(estimated.estimateInHomeCurrency?.minor).toBe(-450 * 150 - 35_000);
    expect(getTransaction(db, user.id, "pounds")?.amountMinor).toBe(450);
    expect(getTransaction(db, user.id, "dinars")?.amountMinor).toBe(35_000);
  });
});
