import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createIncomePlan,
  getUserByTelegramId,
  listIncomeExpectations,
  listTransactions,
  type Mon22rDb,
  readUserFlags,
  recordTransaction,
  recordTransfer,
} from "@mon22r/db";
import { describe, expect, it } from "vitest";

import { applyPhrase } from "../src/capture.js";
import { createRuntime } from "../src/health.js";
import { createApp } from "../src/http.js";
import { authHeader, memoryDatabase, recordingLogger, scratchDirectory, TEST_TOKEN } from "./helpers.js";

const OWNER = 42;
const OTHER = 99;
const now = new Date("2026-11-12T10:00:00.000Z");

function client(db: Mon22rDb, options?: { dist?: string; runtime?: ReturnType<typeof createRuntime> }) {
  const logger = recordingLogger();
  const app = createApp({
    db,
    botToken: TEST_TOKEN,
    allowed: new Set([OWNER, OTHER]),
    miniAppDist: options?.dist ?? "/no/such/mon22r-dist",
    now: () => now,
    log: logger.log,
    runtime: options?.runtime,
  });
  const call = async (method: string, path: string, body?: unknown, as: number | null = OWNER) => {
    const headers: Record<string, string> = {};
    if (as !== null) headers.authorization = authHeader(as);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const textBody = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(textBody);
    } catch {
      json = textBody;
    }
    return { status: response.status, json: json as Record<string, unknown>, headers: response.headers };
  };
  return { app, call, lines: logger.lines };
}

async function ready(db: Mon22rDb, as = OWNER) {
  const api = client(db);
  const setup = await api.call(
    "POST",
    "/api/setup",
    { homeCurrency: "RSD", timeZone: "Europe/Belgrade", starterAccounts: true },
    as,
  );
  expect(setup.status).toBe(200);
  const user = getUserByTelegramId(db, as);
  if (user === null) throw new Error("setup did not create the user");
  return { api, user };
}

describe("access", () => {
  it("accepts only launch data signed by this bot for an allowed, current user", async () => {
    const db = memoryDatabase();
    const { call, app } = client(db);
    expect((await call("GET", "/api/me", undefined, null)).status).toBe(401);
    expect((await call("GET", "/api/me", undefined, 7)).status).toBe(401);
    const tampered = await app.request("/api/me", {
      headers: { authorization: authHeader(OWNER).replace("hash=", "hash=dead") },
    });
    expect(tampered.status).toBe(401);
    const foreign = await app.request("/api/me", {
      headers: { authorization: authHeader(OWNER, "999:another-bot-token") },
    });
    expect(foreign.status).toBe(401);
    const stale = await app.request("/api/me", {
      headers: { authorization: authHeader(OWNER, TEST_TOKEN, new Date(Date.now() - 25 * 3_600_000)) },
    });
    expect(stale.status).toBe(401);
    expect(await tampered.json()).toEqual({ error: "Нет доступа.", code: "unauthorized" });

    const fresh = await call("GET", "/api/me");
    expect(fresh.status).toBe(200);
    expect(fresh.json).toMatchObject({ ready: false, onboardingStep: "currency", user: null, defaultAccountId: null });
    expect((await call("GET", "/api/month?month=2026-11")).status).toBe(409);
  });

  it("keeps each user's ledger private", async () => {
    const db = memoryDatabase();
    const { api, user } = await ready(db);
    await ready(db, OTHER);
    const saved = applyPhrase(db, user, "кофе 350", now);
    if (saved.type !== "saved") throw new Error("expected a saved entry");
    const id = saved.transaction.id;

    expect((await api.call("GET", "/api/transactions?month=2026-11", undefined, OTHER)).json).toEqual({
      transactions: [],
    });
    expect((await api.call("PATCH", `/api/transactions/${id}`, { categoryId: null }, OTHER)).status).toBe(404);
    expect((await api.call("DELETE", `/api/transactions/${id}`, undefined, OTHER)).json).toEqual({ deleted: [] });
    expect(
      (await api.call("POST", "/api/transactions/categorize", { ids: [id], categoryId: null }, OTHER)).json,
    ).toEqual({ updated: 0 });
    const account = saved.account.id;
    expect((await api.call("PATCH", `/api/accounts/${account}`, { archived: true }, OTHER)).status).toBe(404);
    expect((await api.call("PATCH", "/api/settings", { defaultAccountId: account }, OTHER)).status).toBe(404);
    expect(listTransactions(db, user.id)).toHaveLength(1);
  });
});

describe("requests", () => {
  it("rejects malformed, oversized, and invalid input with a clear answer", async () => {
    const db = memoryDatabase();
    const { api } = await ready(db);
    expect((await api.call("POST", "/api/accounts", "{not json")).status).toBe(400);
    expect((await api.call("POST", "/api/accounts", "[]")).status).toBe(400);
    const huge = await api.call("POST", "/api/categories", { name: "x".repeat(300_000) });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "Слишком большой запрос.", code: "too_large" });
    expect((await api.call("POST", "/api/accounts", { name: "Счёт", currency: "ZZZ" })).json).toEqual({
      error: "Валюта не распознана.",
      code: "invalid_currency",
    });
    expect((await api.call("POST", "/api/accounts", { name: "  ", currency: "RSD" })).status).toBe(400);
    expect((await api.call("GET", "/api/month?month=2026-13")).status).toBe(400);
    expect((await api.call("POST", "/api/transactions/categorize", { ids: [], categoryId: null })).status).toBe(400);
    expect((await api.call("PATCH", "/api/settings", {})).status).toBe(400);
    expect((await api.call("PATCH", "/api/settings", { timeZone: "Mars/Olympus" })).json.code).toBe(
      "invalid_time_zone",
    );
    expect((await api.call("GET", "/api/nothing")).status).toBe(404);
    // Every request is logged with its route, never with its body.
    const logged = api.lines.filter((line) => line.message === "request");
    expect(logged.length).toBeGreaterThan(5);
    expect(JSON.stringify(api.lines)).not.toContain("Счёт");
  });

  it("manages accounts, the default account, and categories", async () => {
    const db = memoryDatabase();
    const { api, user } = await ready(db);
    const created = await api.call("POST", "/api/accounts", { name: " Наличные ", currency: "RSD" });
    expect(created.status).toBe(201);
    const cash = created.json.account as { id: string; name: string };
    expect(cash.name).toBe("Наличные");

    const chosen = await api.call("PATCH", "/api/settings", { defaultAccountId: cash.id });
    expect(chosen.json).toMatchObject({ defaultAccountId: cash.id });
    expect((await api.call("GET", "/api/me")).json).toMatchObject({ ready: true, defaultAccountId: cash.id });
    const archived = await api.call("PATCH", `/api/accounts/${cash.id}`, { archived: true });
    expect(archived.json).toMatchObject({ account: { archived: true }, defaultAccountId: null });
    expect(readUserFlags(db, user.id)?.defaultAccountId).toBeNull();

    const food = (await api.call("POST", "/api/categories", { name: "Еда" })).json.category as { id: string };
    expect((await api.call("POST", "/api/categories", { name: "Еда" })).status).toBe(409);
    expect((await api.call("PATCH", `/api/categories/${food.id}`, { name: "Продукты" })).json).toMatchObject({
      category: { name: "Продукты" },
    });
    const entry = applyPhrase(db, user, "хлеб 120 #Продукты", now);
    if (entry.type !== "saved") throw new Error("expected a saved entry");
    expect((await api.call("DELETE", `/api/categories/${food.id}`)).json).toEqual({ cleared: 1 });
    expect(listTransactions(db, user.id)[0]?.categoryId).toBeNull();
  });

  it("categorizes in bulk, corrects, and deletes transactions, transfers included", async () => {
    const db = memoryDatabase();
    const { api, user } = await ready(db);
    const food = (await api.call("POST", "/api/categories", { name: "Еда" })).json.category as { id: string };
    const ids: string[] = [];
    for (const line of ["maxi 1200", "maxi 800", "lidl 500"]) {
      const saved = applyPhrase(db, user, line, now);
      if (saved.type === "saved") ids.push(saved.transaction.id);
    }
    expect((await api.call("POST", "/api/transactions/categorize", { ids, categoryId: food.id })).json).toEqual({
      updated: 3,
    });
    const month = await api.call("GET", "/api/month?month=2026-11");
    expect(month.json.categorySpend).toEqual([{ categoryId: food.id, currency: "RSD", spentMinor: 250_000 }]);

    const first = ids[0] ?? "";
    expect((await api.call("PATCH", `/api/transactions/${first}`, { categoryId: null })).json).toMatchObject({
      transaction: { id: first, categoryId: null },
    });
    expect((await api.call("DELETE", `/api/transactions/${first}`)).json).toEqual({ deleted: [first] });
    expect((await api.call("DELETE", `/api/transactions/${first}`)).json).toEqual({ deleted: [] });

    const accounts = (await api.call("GET", "/api/me")).json.accounts as { id: string; currency: string }[];
    const rsd = accounts.filter((account) => account.currency === "RSD");
    const cash = (await api.call("POST", "/api/accounts", { name: "Наличные", currency: "RSD" })).json.account as {
      id: string;
    };
    const [outflow, inflow] = recordTransfer(db, user.id, {
      fromAccountId: rsd[0]?.id ?? "",
      toAccountId: cash.id,
      from: { minor: 100, currency: "RSD" },
      to: { minor: 100, currency: "RSD" },
      occurredAt: now.toISOString(),
    });
    const removed = (await api.call("DELETE", `/api/transactions/${inflow.id}`)).json.deleted as string[];
    expect([...removed].sort()).toEqual([outflow.id, inflow.id].sort());
    expect(listTransactions(db, user.id)).toHaveLength(2);
  });

  it("shows the month's income lines and lets a plan be changed or stopped", async () => {
    const db = memoryDatabase();
    const { api, user } = await ready(db);
    const account = ((await api.call("GET", "/api/me")).json.accounts as { id: string }[])[0]?.id ?? "";
    const plan = createIncomePlan(db, user.id, {
      name: "зп",
      amountMinor: 18_000_000,
      currency: "RSD",
      dayOfMonth: 5,
      accountId: account,
      recurrence: "monthly",
      startYear: 2026,
      startMonth: 11,
    });
    recordTransaction(db, user.id, {
      accountId: account,
      kind: "income",
      amountMinor: 18_000_000,
      currency: "RSD",
      occurredAt: now.toISOString(),
    });

    const november = await api.call("GET", "/api/month?month=2026-11");
    expect(november.json).toMatchObject({
      month: { year: 2026, month: 11 },
      homeCurrency: "RSD",
      totalsByCurrency: [{ currency: "RSD", incomeMinor: 18_000_000, expenseMinor: 0 }],
      plans: [{ id: plan.id }],
      expectations: [{ planId: plan.id, status: "expected", expectedMinor: 18_000_000 }],
    });
    const line = (november.json.expectations as { id: string }[])[0]?.id ?? "";
    expect((await api.call("PATCH", `/api/expectations/${line}`, { status: "received" })).json).toMatchObject({
      expectation: { status: "received", receivedMinor: 18_000_000 },
    });
    expect((await api.call("PATCH", `/api/plans/${plan.id}`, { amountMinor: 20_000_000 })).json).toMatchObject({
      plan: { amountMinor: 20_000_000 },
    });
    // December follows the new amount; November, already received, keeps what happened.
    const december = await api.call("GET", "/api/month?month=2026-12");
    expect(december.json.expectations).toMatchObject([{ expectedMinor: 20_000_000, status: "expected" }]);
    expect((await api.call("GET", "/api/month?month=2026-11")).json.expectations).toMatchObject([
      { expectedMinor: 18_000_000 },
    ]);

    const stopped = await api.call("PATCH", `/api/plans/${plan.id}`, { active: false });
    expect(stopped.json).toMatchObject({ plan: { active: false } });
    expect((await api.call("GET", "/api/month?month=2026-12")).json).toMatchObject({ plans: [], expectations: [] });
    expect(listIncomeExpectations(db, user.id, { year: 2026, month: 11 })).toHaveLength(1);
    expect((await api.call("PATCH", `/api/plans/${plan.id}`, {})).status).toBe(400);
  });
});

describe("health and static files", () => {
  it("reports health without credentials and turns unhealthy when polling stalls", async () => {
    const db = memoryDatabase();
    const runtime = createRuntime("abc1234", () => now.getTime());
    const { call } = client(db, { runtime });
    const starting = await call("GET", "/healthz", undefined, null);
    expect(starting.status).toBe(200);
    expect(starting.json).toEqual({
      ok: true,
      version: "abc1234",
      uptimeSeconds: 0,
      database: "ok",
      polling: "starting",
      lastBackupAt: null,
    });
    runtime.lastPollAt = now.getTime() - 10 * 60_000;
    const stalled = await call("GET", "/healthz", undefined, null);
    expect(stalled.status).toBe(503);
    expect(stalled.json).toMatchObject({ ok: false, polling: "stale" });
  });

  it("serves the Mini App with long caching for hashed assets only, and security headers on everything", async () => {
    const dist = scratchDirectory();
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>mon22r</title>");
    writeFileSync(join(dist, "assets", "index-abc123.js"), "console.info('ok')");
    const { call } = client(memoryDatabase(), { dist });

    const page = await call("GET", "/", undefined, null);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    );
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(page.headers.get("x-frame-options")).toBeNull();

    const asset = await call("GET", "/assets/index-abc123.js", undefined, null);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // An old page asking for a removed bundle must get a 404, not HTML cached as script for a year.
    const gone = await call("GET", "/assets/index-old999.js", undefined, null);
    expect(gone.status).toBe(404);
    expect((await call("GET", "/feed", undefined, null)).json).toContain("<title>mon22r</title>");
    expect((await call("GET", "/../package.json", undefined, null)).json).not.toContain("workspace");
    const api = await call("GET", "/api/me");
    expect(api.headers.get("cache-control")).toBe("no-store");
  });
});
