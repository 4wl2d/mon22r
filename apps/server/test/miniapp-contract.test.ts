import { getUserByTelegramId, type Mon22rDb, replaceFxRate } from "@mon22r/db";
import { afterEach, describe, expect, it } from "vitest";

import {
  ApiError,
  categorizeTransactions,
  createAccount,
  createCategory,
  deleteCategory,
  deleteTransaction,
  errorText,
  getMe,
  getMonth,
  getTransactions,
  renameCategory,
  setInitData,
  setup,
  updateAccount,
  updateExpectationStatus,
  updatePlan,
  updateSettings,
  updateTransaction,
} from "../../miniapp/src/api.js";
import { applyPhrase } from "../src/capture.js";
import { createApp } from "../src/http.js";
import { authHeader, memoryDatabase, TEST_TOKEN } from "./helpers.js";

const OWNER = 42;
const now = new Date("2026-11-12T10:00:00.000Z");
let restoreFetch: (() => void) | null = null;

/** Points the Mini App's own client at an in-process server, the way the browser reaches the real one. */
function connect(db: Mon22rDb, telegramId: number = OWNER): { calls: string[] } {
  const app = createApp({
    db,
    botToken: TEST_TOKEN,
    allowed: new Set([OWNER]),
    miniAppDist: "/no/such/dist",
    now: () => now,
  });
  const calls: string[] = [];
  swapFetch(async (input, init) => {
    const url = new URL(String(input), "http://127.0.0.1");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return app.request(`${url.pathname}${url.search}`, {
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
  });
  setInitData(authHeader(telegramId).slice("tma ".length));
  return { calls };
}

function swapFetch(next: typeof fetch): void {
  const previous = globalThis.fetch;
  globalThis.fetch = next;
  restoreFetch ??= () => {
    globalThis.fetch = previous;
  };
}

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("the Mini App client against the real server", () => {
  it("sets the ledger up and manages accounts, the default account, and categories", async () => {
    const db = memoryDatabase();
    connect(db);
    const before = await getMe();
    expect(before).toMatchObject({
      ready: false,
      user: null,
      onboardingStep: "currency",
      accounts: [],
      defaultAccountId: null,
    });

    const user = await setup({ homeCurrency: "EUR", timeZone: "Europe/Belgrade", starterAccounts: false });
    expect(user).toMatchObject({ homeCurrency: "EUR", timeZone: "Europe/Belgrade" });
    const card = await createAccount({ name: "Карта", currency: "RSD" });
    const euro = await createAccount({ name: "Евро", currency: "EUR" });
    expect((await updateSettings({ defaultAccountId: card.id })).defaultAccountId).toBe(card.id);
    expect((await updateAccount(euro.id, { name: "Счёт EUR" })).account.name).toBe("Счёт EUR");
    // Archiving the default account reports that the default is gone.
    expect(await updateAccount(card.id, { archived: true })).toMatchObject({
      account: { archived: true },
      defaultAccountId: null,
    });
    expect((await updateSettings({ timeZone: "Europe/London" })).user.timeZone).toBe("Europe/London");

    const food = await createCategory("Еда");
    expect((await renameCategory(food.id, "Продукты")).name).toBe("Продукты");
    const me = await getMe();
    expect(me.ready).toBe(true);
    expect(me.categories.map((category) => category.name)).toEqual(["Продукты"]);
    expect(me.accounts.map((account) => `${account.name} ${account.currency} ${account.archived}`)).toEqual([
      "Карта RSD true",
      "Счёт EUR EUR false",
    ]);
    await deleteCategory(food.id);
    expect((await getMe()).categories).toEqual([]);
  });

  it("reads a month and its feed, then categorizes, moves, and deletes", async () => {
    const db = memoryDatabase();
    connect(db);
    await setup({ homeCurrency: "EUR", timeZone: "Europe/Belgrade", starterAccounts: false });
    const card = await createAccount({ name: "Карта", currency: "RSD" });
    const cash = await createAccount({ name: "Наличные", currency: "RSD" });
    await createAccount({ name: "Евро", currency: "EUR" });
    const food = await createCategory("Еда");
    const user = getUserByTelegramId(db, OWNER);
    if (user === null) throw new Error("user missing");
    for (const line of ["maxi 1200 rsd", "lidl 800 rsd", "+оплата 2500", "перевод 100 eur на карта 11720"]) {
      expect(applyPhrase(db, user, line, now).type).not.toBe("unparsed");
    }
    replaceFxRate(db, {
      baseCurrency: "EUR",
      quoteCurrency: "RSD",
      numerator: 11_720,
      denominator: 100,
      asOf: "2026-11-12",
      source: "er-api",
    });

    const feed = await getTransactions("2026-11");
    expect(feed.map((row) => row.kind).sort()).toEqual(["expense", "expense", "income", "transfer", "transfer"]);
    const expenses = feed.filter((row) => row.kind === "expense");
    expect(
      await categorizeTransactions(
        expenses.map((row) => row.id),
        food.id,
      ),
    ).toBe(2);
    const first = expenses[0];
    if (first === undefined) throw new Error("expense missing");
    expect((await updateTransaction(first.id, { accountId: cash.id })).accountId).toBe(cash.id);
    expect(first.accountId).toBe(card.id);

    const month = await getMonth("2026-11");
    expect(month.totalsByCurrency).toEqual([
      { currency: "EUR", incomeMinor: 250_000, expenseMinor: 0 },
      { currency: "RSD", incomeMinor: 0, expenseMinor: 200_000 },
    ]);
    expect(month.categorySpend).toEqual([{ categoryId: food.id, currency: "RSD", spentMinor: 200_000 }]);
    // 2 500,00 EUR in, 2 000,00 RSD out at 117.20: the transfer is in neither side.
    expect(month.estimateInHomeCurrency).toMatchObject({
      currency: "EUR",
      minor: 250_000 - 1706,
      usedConversion: true,
    });

    const transfer = feed.find((row) => row.kind === "transfer");
    if (transfer === undefined) throw new Error("transfer missing");
    expect(await deleteTransaction(transfer.id)).toHaveLength(2);
    expect(await deleteTransaction(transfer.id)).toEqual([]);
    expect(await getTransactions("2026-11")).toHaveLength(3);
  });

  it("shows expected income and lets a plan be changed and stopped", async () => {
    const db = memoryDatabase();
    connect(db);
    await setup({ homeCurrency: "RSD", timeZone: "Europe/Belgrade", starterAccounts: true });
    const user = getUserByTelegramId(db, OWNER);
    if (user === null) throw new Error("user missing");
    expect(applyPhrase(db, user, "план зп 180000 5", now).type).toBe("plan");

    const december = await getMonth("2026-12");
    expect(december.plans).toMatchObject([
      { name: "зп", amountMinor: 18_000_000, recurrence: "monthly", active: true },
    ]);
    expect(december.expectations).toMatchObject([{ name: "зп", status: "expected", dayOfMonth: 5 }]);
    const plan = december.plans[0];
    const line = december.expectations[0];
    if (plan === undefined || line === undefined) throw new Error("plan missing");

    expect((await updatePlan(plan.id, { amountMinor: 20_000_000, currency: "RSD" })).amountMinor).toBe(20_000_000);
    expect((await getMonth("2026-12")).expectations[0]?.expectedMinor).toBe(20_000_000);
    expect(await updateExpectationStatus(line.id, "received")).toMatchObject({
      status: "received",
      receivedMinor: 20_000_000,
    });
    expect((await updatePlan(plan.id, { active: false })).active).toBe(false);
    expect((await getMonth("2027-01")).expectations).toEqual([]);
    // December already has money against it, so it stays.
    expect((await getMonth("2026-12")).expectations).toHaveLength(1);
  });

  it("turns failures into sentences the screens can show", async () => {
    const db = memoryDatabase();
    connect(db, 7);
    const denied = await getMe().catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ApiError);
    expect(errorText(denied, "x")).toBe("Сессия истекла. Закройте приложение и откройте его из чата снова.");

    connect(db);
    await setup({ homeCurrency: "RSD", timeZone: "Europe/Belgrade", starterAccounts: false });
    await createCategory("Еда");
    const conflict = await createCategory("Еда").catch((error: unknown) => error);
    expect(errorText(conflict, "x")).toBe("Такое название уже есть.");
    const unknown = await createAccount({ name: "Счёт", currency: "ZZZ" }).catch((error: unknown) => error);
    expect(errorText(unknown, "x")).toBe("Валюта не распознана.");
    expect(errorText(new Error("stack trace"), "Не удалось.")).toBe("Не удалось.");
  });

  it("retries a failed read once, never a write, and rejects answers that do not fit the contract", async () => {
    let attempts = 0;
    swapFetch(async () => {
      attempts += 1;
      throw new TypeError("network down");
    });
    const offline = await getMonth("2026-11").catch((error: unknown) => error);
    expect(attempts).toBe(2);
    expect(errorText(offline, "x")).toBe("Нет соединения.");

    attempts = 0;
    const write = await createCategory("Еда").catch((error: unknown) => error);
    // The first attempt may have reached the server; sending it again could create a duplicate.
    expect(attempts).toBe(1);
    expect(errorText(write, "x")).toBe("Нет соединения.");

    swapFetch(async () => Response.json({ ready: "yes", accounts: [], categories: [] }));
    await expect(getMe()).rejects.toThrow("Не удалось прочитать ответ.");
    swapFetch(async () => Response.json({ transactions: [{ id: "t1", amountMinor: "12" }] }));
    await expect(getTransactions("2026-11")).rejects.toThrow("Не удалось прочитать ответ.");
    swapFetch(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    expect(errorText(await getMe().catch((error: unknown) => error), "x")).toBe("Не удалось выполнить запрос.");
  });
});
