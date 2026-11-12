// Local preview of the Mini App against a throwaway ledger. No bot, no Telegram, no real data.
// Usage: pnpm preview   (builds first), then open the printed address.
// The address carries launch data signed with a made-up token, the way Telegram would pass it.
import { resolve } from "node:path";

import { serve } from "@hono/node-server";
import {
  createAccount,
  createCategory,
  createIncomePlan,
  createUser,
  migrate,
  openDatabase,
  recordTransaction,
  recordTransfer,
  replaceFxRate,
  updateStoredUser,
} from "@mon22r/db";
import { sign } from "@tma.js/init-data-node";

import { createApp } from "../dist/http.js";
import { materializeApplicable } from "../dist/plans.js";

const token = "1000000:preview-token-opens-no-real-bot";
const telegramId = 4242;
const portFlag = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portFlag?.slice("--port=".length) ?? process.env.PORT ?? 4173);
const empty = process.argv.includes("--empty");
const fresh = process.argv.includes("--fresh");

const db = openDatabase(":memory:");
migrate(db);

if (!fresh) {
  const user = createUser(db, { telegramId, homeCurrency: "EUR", timeZone: "Europe/Belgrade" });
  const at = (offsetDays, hour = 12) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offsetDays);
    date.setUTCHours(hour, (offsetDays * 7) % 60, 0, 0);
    return date.toISOString();
  };
  const card = createAccount(db, user.id, { name: "Карта RSD", currency: "RSD", createdAt: at(200) });
  const cash = createAccount(db, user.id, { name: "Наличные", currency: "RSD", createdAt: at(199) });
  const euro = createAccount(db, user.id, { name: "Счёт EUR", currency: "EUR", createdAt: at(198) });
  const rub = createAccount(db, user.id, { name: "Рубли", currency: "RUB", createdAt: at(197) });
  createAccount(db, user.id, { name: "Старая карта", currency: "RSD", archived: true, createdAt: at(196) });
  updateStoredUser(db, user.id, { defaultAccountId: card.id });

  if (!empty) {
    const food = createCategory(db, user.id, { name: "Еда" });
    const cafe = createCategory(db, user.id, { name: "Кафе" });
    const transport = createCategory(db, user.id, { name: "Транспорт" });
    const home = createCategory(db, user.id, { name: "Дом" });
    const lines = [
      ["MAXI 123 BEOGRAD", 284_000, food.id],
      ["кофе", 35_000, cafe.id],
      ["LIDL NOVI BEOGRAD", 512_050, null],
      ["такси", 120_000, transport.id],
      ["аренда", 6_500_000, home.id],
      ["MAXI 77 ZEMUN", 199_900, null],
      ["обед", 145_000, cafe.id],
      ["BUS PLUS", 9_900, transport.id],
      ["аптека", 87_000, null],
      ["KUPOVINA DM DROGERIE MARKT 4411 BEOGRAD RS", 231_000, null],
    ];
    for (let day = 0; day < 75; day += 1) {
      const [description, amountMinor, categoryId] = lines[day % lines.length];
      if (description === "аренда" && day % 30 > 9) continue;
      recordTransaction(db, user.id, {
        accountId: day % 4 === 0 ? cash.id : card.id,
        kind: "expense",
        amountMinor,
        currency: "RSD",
        categoryId,
        occurredAt: at(day, 9 + (day % 10)),
        createdAt: at(day, 9 + (day % 10)),
        description,
        importIdentity: day % 3 === 0 ? { source: "preview-bank", externalKey: `line-${day}` } : null,
      });
    }
    for (const day of [3, 33, 63]) {
      recordTransaction(db, user.id, {
        accountId: euro.id,
        kind: "income",
        amountMinor: 250_000,
        currency: "EUR",
        occurredAt: at(day, 8),
        createdAt: at(day, 8),
        description: "оплата по договору",
      });
      recordTransfer(db, user.id, {
        fromAccountId: euro.id,
        toAccountId: card.id,
        from: { minor: 100_000, currency: "EUR" },
        to: { minor: 11_720_000, currency: "RSD" },
        occurredAt: at(day - 1, 10),
        createdAt: at(day - 1, 10),
        description: "Счёт EUR → Карта RSD",
      });
    }
    recordTransaction(db, user.id, {
      accountId: rub.id,
      kind: "expense",
      amountMinor: 1_250_000,
      currency: "RUB",
      occurredAt: at(5, 15),
      createdAt: at(5, 15),
      description: "подписка",
    });
    recordTransaction(db, user.id, {
      accountId: card.id,
      kind: "refund",
      amountMinor: 87_000,
      currency: "RSD",
      occurredAt: at(2, 16),
      createdAt: at(2, 16),
      description: "аптека",
    });
    const now = new Date();
    const month = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    createIncomePlan(db, user.id, {
      name: "оплата по договору",
      amountMinor: 250_000,
      currency: "EUR",
      dayOfMonth: 10,
      accountId: euro.id,
      recurrence: "monthly",
      startYear: month.year,
      startMonth: month.month,
    });
    materializeApplicable(db, user.id, month);
    const today = now.toISOString().slice(0, 10);
    replaceFxRate(db, {
      baseCurrency: "EUR",
      quoteCurrency: "RSD",
      numerator: 11_720,
      denominator: 100,
      asOf: today,
      source: "er-api",
    });
    replaceFxRate(db, {
      baseCurrency: "EUR",
      quoteCurrency: "RUB",
      numerator: 9_200,
      denominator: 100,
      asOf: today,
      source: "er-api",
    });
  }
}

const app = createApp({
  db,
  botToken: token,
  allowed: new Set([telegramId]),
  miniAppDist: resolve(import.meta.dirname, "../../miniapp/dist"),
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });

const initData = sign({ user: { id: telegramId, first_name: "Preview" } }, token, new Date());
const launch = new URLSearchParams({
  tgWebAppData: initData,
  tgWebAppVersion: "8.0",
  tgWebAppPlatform: "ios",
  tgWebAppThemeParams: "{}",
});
console.info(`Mini App preview: http://127.0.0.1:${port}/#${launch.toString()}`);
console.info("Variants: --empty (accounts only), --fresh (before setup). The launch data stays valid for 24 hours.");
