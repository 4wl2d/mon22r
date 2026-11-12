import {
  createUser,
  type Mon22rDb,
  migrate,
  openDatabase,
  recordTransaction,
  recordTransfer,
  updateStoredUser,
  upsertFxRate,
} from "@mon22r/db";
import { sign } from "@tma.js/init-data-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  copyPlans,
  createAccount,
  createCategory,
  createPlan,
  errorText,
  getAccounts,
  getMe,
  getMonth,
  getPlans,
  getTransactions,
  setInitData,
  setup,
  updateAccount,
  updateExpectationStatus,
  updatePlanAmount,
  updateTransaction,
} from "../../miniapp/src/api.js";
import { createApp } from "../src/http.js";

const open: Mon22rDb[] = [];
const token = "123456:TESTTOKEN";
let restoreFetch: (() => void) | null = null;

function database(): Mon22rDb {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function rawInit(id: number): string {
  return sign({ user: { id, first_name: "A" } }, token, new Date());
}

function useClient(db: Mon22rDb, telegramId: number): void {
  const app = createApp({
    db,
    botToken: token,
    allowed: new Set([42, 99]),
    miniAppDist: "/no/such/mon22r-dist",
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      "http://127.0.0.1",
    );
    const headers = new Headers(init?.headers);
    return app.request(`${url.pathname}${url.search}`, {
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
  };
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
  setInitData(rawInit(telegramId));
}

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  for (const db of open) db.close();
  open.length = 0;
});

describe("mini app reads the server JSON", () => {
  it("keeps setup open when a user already exists and is not ready", async () => {
    const db = database();
    const user = createUser(db, { telegramId: 42, homeCurrency: "GBP", timeZone: "Europe/London" });
    updateStoredUser(db, user.id, { onboardingStep: "accounts" });
    useClient(db, 42);

    const me = await getMe();
    expect(me.ready).toBe(false);
    expect(me.user?.homeCurrency).toBe("GBP");
    expect(me.user?.timeZone).toBe("Europe/London");
    expect(me.onboardingStep).toBe("accounts");
    expect(me.accounts).toEqual([]);
  });

  it("reads month, plans, feed, and accounts without adding currencies", async () => {
    const db = database();
    useClient(db, 42);
    const before = await getMe();
    expect(before).toMatchObject({ ready: false, user: null, onboardingStep: "currency", telegramId: 42 });

    const user = await setup({ homeCurrency: "RSD", timeZone: "Europe/Belgrade", starterAccounts: true });
    expect(user.homeCurrency).toBe("RSD");
    expect(user.timeZone).toBe("Europe/Belgrade");
    const ready = await getMe();
    expect(ready.ready).toBe(true);
    expect(ready.onboardingStep).toBeNull();
    expect(ready.accounts.map((account) => `${account.name} ${account.currency}`)).toEqual([
      "Поштанска RSD",
      "Рубли RUB",
      "UK GBP",
    ]);

    const accounts = await getAccounts();
    const rsd = accounts.find((account) => account.currency === "RSD");
    const pounds = accounts.find((account) => account.currency === "GBP");
    expect(rsd).toBeDefined();
    expect(pounds).toBeDefined();
    if (!rsd || !pounds || !ready.user) return;
    const cash = await createAccount({ name: "Наличные", currency: "RSD" });
    const food = await createCategory("еда");
    await expect(createCategory("еда")).rejects.toMatchObject({ message: "Category name already exists" });

    const spent = recordTransaction(db, ready.user.id, {
      accountId: rsd.id,
      kind: "expense",
      amountMinor: 35_000,
      currency: "RSD",
      categoryId: food.id,
      occurredAt: "2026-10-12T10:00:00.000Z",
      description: "кофе",
    }).transaction;
    recordTransaction(db, ready.user.id, {
      accountId: rsd.id,
      kind: "refund",
      amountMinor: 1_000,
      currency: "RSD",
      categoryId: food.id,
      refundOfTransactionId: spent.id,
      occurredAt: "2026-10-12T12:00:00.000Z",
      description: "возврат кофе",
    });
    recordTransaction(db, ready.user.id, {
      accountId: rsd.id,
      kind: "expense",
      amountMinor: 2_000,
      currency: "RSD",
      occurredAt: "2026-10-12T13:00:00.000Z",
      description: "такси",
    });
    recordTransaction(db, ready.user.id, {
      accountId: rsd.id,
      kind: "income",
      amountMinor: 5_000,
      currency: "RSD",
      occurredAt: "2026-10-12T14:00:00.000Z",
      description: "кэш",
    });
    recordTransfer(db, ready.user.id, {
      fromAccountId: rsd.id,
      toAccountId: cash.id,
      from: { minor: 5_000, currency: "RSD" },
      to: { minor: 5_000, currency: "RSD" },
      occurredAt: "2026-10-12T15:00:00.000Z",
      description: "наличные",
    });
    recordTransaction(db, ready.user.id, {
      accountId: pounds.id,
      kind: "expense",
      amountMinor: 450,
      currency: "GBP",
      occurredAt: "2026-11-12T10:00:00.000Z",
      description: "tea",
    });

    const october = await getMonth("2026-10");
    expect(october.totalsByCurrency).toEqual([{ currency: "RSD", incomeMinor: 5_000, expenseMinor: 36_000 }]);
    expect(october.categorySpend).toEqual([
      { categoryId: food.id, currency: "RSD", spentMinor: 34_000 },
      { categoryId: null, currency: "RSD", spentMinor: 2_000 },
    ]);
    expect(october.estimateInHomeCurrency).toEqual({
      kind: "estimate",
      minor: -31_000,
      currency: "RSD",
      asOf: null,
      source: null,
      usedConversion: false,
    });

    const missingRate = await getMonth("2026-11");
    expect(missingRate.totalsByCurrency).toEqual([{ currency: "GBP", incomeMinor: 0, expenseMinor: 450 }]);
    expect(missingRate.estimateInHomeCurrency).toBeNull();

    upsertFxRate(db, {
      baseCurrency: "GBP",
      quoteCurrency: "RSD",
      numerator: 150,
      denominator: 1,
      asOf: "2026-11-12",
      source: "ecb",
    });
    const estimated = await getMonth("2026-11");
    expect(estimated.estimateInHomeCurrency).toMatchObject({
      kind: "estimate",
      minor: -67_500,
      currency: "RSD",
      asOf: "2026-11-12",
      source: "ecb",
      usedConversion: true,
    });
    expect(estimated.totalsByCurrency).toEqual([{ currency: "GBP", incomeMinor: 0, expenseMinor: 450 }]);

    const feed = await getTransactions("2026-10");
    const refund = feed.find((row) => row.kind === "refund");
    expect(refund).toMatchObject({ amountMinor: 1_000, currency: "RSD", direction: "inflow", categoryId: food.id });
    expect(feed.filter((row) => row.kind === "transfer")).toHaveLength(2);
    const cleared = await updateTransaction(spent.id, { categoryId: null });
    expect(cleared.categoryId).toBeNull();
    expect(cleared.amountMinor).toBe(35_000);

    const plan = await createPlan({
      name: "Зарплата",
      amountMinor: 18_000_000,
      currency: "RSD",
      dayOfMonth: 5,
      accountId: null,
      recurrence: "monthly",
      startYear: 2026,
      startMonth: 12,
    });
    const rows = await getPlans("2026-12");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plan?.id).toBe(plan.id);
    expect(rows[0]?.expectation).toMatchObject({
      planId: plan.id,
      expectedMinor: 18_000_000,
      receivedMinor: 0,
      status: "expected",
      currency: "RSD",
    });
    const updated = await updatePlanAmount(plan.id, 9_000_000, "RSD");
    expect(updated.amountMinor).toBe(9_000_000);
    const expectationId = rows[0]?.expectation?.id;
    expect(expectationId).toBeTruthy();
    if (!expectationId) return;
    const received = await updateExpectationStatus(expectationId, "received");
    expect(received.status).toBe("received");
    expect(received.receivedMinor).toBe(9_000_000);
    await copyPlans("2026-12", "2027-01");
    const copied = await getPlans("2027-01");
    expect(copied.some((row) => row.expectation?.status === "expected")).toBe(true);

    const renamed = await updateAccount(cash.id, { name: "Карман" });
    expect(renamed.name).toBe("Карман");
    const archived = await updateAccount(cash.id, { archived: true });
    expect(archived.archived).toBe(true);

    setInitData("not-signed");
    const denied = await getMe().then(
      () => null,
      (error: unknown) => error,
    );
    expect(denied).toBeInstanceOf(ApiError);
    expect(errorText(denied, "fallback")).toBe("Нет доступа.");

    setInitData(rawInit(42));
    const badMonth = await getMonth("bad").then(
      () => null,
      (error: unknown) => error,
    );
    expect(badMonth).toBeInstanceOf(ApiError);
    if (badMonth instanceof ApiError) {
      expect(badMonth.message).toBe("month must be YYYY-MM");
      expect(badMonth.message).not.toBe("invalid_month");
    }
  });
});
