import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase, type Mon22rDb } from "@mon22r/db";
import { sign } from "@tma.js/init-data-node";

import { createApp } from "../src/http.js";

const open: Mon22rDb[] = [];
const token = "123456:TESTTOKEN";

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

function header(id: number, botToken = token): string {
  const raw = sign({ user: { id, first_name: "A" } }, botToken, new Date());
  return `tma ${raw}`;
}

describe("mini app auth", () => {
  it("rejects other telegram accounts and keeps starter accounts private", async () => {
    const db = database();
    const app = createApp({
      db,
      botToken: token,
      allowed: new Set([42, 99]),
      miniAppDist: "/no/such/mon22r-dist",
    });
    const stranger = await app.request("/api/me", { headers: { authorization: header(7) } });
    expect(stranger.status).toBe(401);
    const missing = await app.request("/api/month?month=2026-11", { headers: { authorization: header(42) } });
    expect(missing.status).toBe(409);

    const setup = await app.request("/api/setup", {
      method: "POST",
      headers: { authorization: header(42), "content-type": "application/json" },
      body: JSON.stringify({ homeCurrency: "RSD", timeZone: "Europe/Belgrade", starterAccounts: true }),
    });
    expect(setup.status).toBe(200);
    const me = await app.request("/api/me", { headers: { authorization: header(42) } });
    const body = (await me.json()) as { onboardingStep: null; accounts: { name: string; currency: string }[] };
    expect(body.onboardingStep).toBeNull();
    expect(body.accounts.map((account) => `${account.name} ${account.currency}`)).toEqual([
      "Поштанска RSD",
      "Рубли RUB",
      "UK GBP",
    ]);

    const other = await app.request("/api/setup", {
      method: "POST",
      headers: { authorization: header(99), "content-type": "application/json" },
      body: JSON.stringify({ homeCurrency: "GBP", timeZone: "Europe/London", starterAccounts: false }),
    });
    expect(other.status).toBe(200);
    const otherAccounts = await app.request("/api/accounts", { headers: { authorization: header(99) } });
    expect(await otherAccounts.json()).toEqual({ accounts: [] });
    const tampered = header(42).replace("hash=", "hash=dead");
    const bad = await app.request("/api/me", { headers: { authorization: tampered } });
    expect(bad.status).toBe(401);
  });
});