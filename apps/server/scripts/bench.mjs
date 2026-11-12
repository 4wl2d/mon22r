// Server-side timings on a synthetic ledger of representative size.
// Usage: pnpm --filter @mon22r/server build && node apps/server/scripts/bench.mjs [transactions]
import { performance } from "node:perf_hooks";
import { createAccount, createCategory, createUser, migrate, openDatabase, recordTransaction } from "@mon22r/db";
import { sign } from "@tma.js/init-data-node";
import { applyPhrase } from "../dist/capture.js";
import { createApp } from "../dist/http.js";

const total = Number(process.argv[2] ?? 10_000);
const token = "1000000:bench-token-not-a-real-secret-0000000000";
const telegramId = 4242;
const now = new Date("2026-11-12T10:00:00.000Z");

const db = openDatabase(":memory:");
migrate(db);
const user = createUser(db, { telegramId, homeCurrency: "EUR", timeZone: "Europe/Belgrade" });
const accounts = [
  ["Card", "RSD"],
  ["Cash", "RSD"],
  ["Business", "RSD"],
  ["Euro", "EUR"],
  ["Roubles", "RUB"],
].map(([name, currency], index) =>
  createAccount(db, user.id, { name, currency, createdAt: new Date(now.getTime() - 1e9 + index).toISOString() }),
);
const categories = ["food", "cafe", "transport", "rent", "health", "fun", "gifts", "tools"].map((name) =>
  createCategory(db, user.id, { name }),
);
const notes = Array.from({ length: 400 }, (_, index) => `shop ${index}`);

const seed = db.sqlite.transaction(() => {
  const span = 5 * 365 * 86_400_000;
  for (let index = 0; index < total; index += 1) {
    const account = accounts[index % accounts.length];
    const at = new Date(now.getTime() - Math.floor((index / total) * span)).toISOString();
    recordTransaction(db, user.id, {
      accountId: account.id,
      kind: index % 11 === 0 ? "income" : "expense",
      amountMinor: 1000 + (index % 9000),
      currency: account.currency,
      categoryId: index % 3 === 0 ? null : categories[index % categories.length].id,
      occurredAt: at,
      createdAt: at,
      description: notes[index % notes.length],
    });
  }
});
seed();

const app = createApp({
  db,
  botToken: token,
  allowed: new Set([telegramId]),
  miniAppDist: "/nonexistent",
  now: () => now,
});
const header = `tma ${sign({ user: { id: telegramId, first_name: "Bench" } }, token, new Date())}`;

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function time(label, runs, action) {
  const samples = [];
  let bytes = 0;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const result = await action(index);
    samples.push(performance.now() - started);
    if (typeof result === "number") bytes = result;
  }
  const size = bytes > 0 ? `  ${(bytes / 1024).toFixed(1)} kB` : "";
  console.info(`${label.padEnd(34)} median ${median(samples).toFixed(2).padStart(7)} ms${size}`);
}

async function get(path) {
  const response = await app.request(path, { headers: { authorization: header } });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${body.slice(0, 120)}`);
  return body.length;
}

console.info(`ledger: ${total} transactions, ${accounts.length} accounts, ${categories.length} categories`);
await time("chat capture (shop N 350 rsd)", 200, (index) => {
  applyPhrase(db, user, `shop ${index % 400} 350 rsd`, now);
});
await time("GET /api/me", 200, () => get("/api/me"));
await time("GET /api/month", 200, () => get("/api/month?month=2026-11"));
await time("GET /api/transactions (month)", 200, () => get("/api/transactions?month=2026-11"));
