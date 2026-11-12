import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import {
  categorizeTransactions,
  correctTransaction,
  createAccount,
  createCategory,
  createUser,
  deleteCategory,
  deleteTransaction,
  getUserByTelegramId,
  listAccounts,
  listCategories,
  listTransactions,
  type Mon22rDb,
  readUserFlags,
  renameCategory,
  updateAccount,
  updateIncomePlan,
  updateStoredUser,
} from "@mon22r/db";
import {
  assertCalendarMonth,
  type CalendarMonth,
  DEFAULT_TIME_ZONE,
  EXPECTATION_STATUSES,
  type ExpectationStatus,
  isKnownCurrency,
  LedgerError,
  monthContaining,
  monthRange,
  type User,
} from "@mon22r/domain";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import { AccessError, telegramUserId } from "./auth.js";
import { createRuntime, type Runtime, readHealth } from "./health.js";
import { errorFields, type Logger, silentLogger } from "./log.js";
import { buildMonthView } from "./month-view.js";
import { refreshOpenExpectations, setExpectationStatus, stopPlan } from "./plans.js";
import { createStarterAccounts } from "./starter.js";

type AppVars = { telegramId: number };
type AppContext = Context<{ Variables: AppVars }>;

const BODY_LIMIT_BYTES = 256 * 1024;
const BULK_LIMIT = 1000;

class OnboardingRequired extends Error {
  constructor() {
    super("Сначала домашняя валюта и часовой пояс.");
    this.name = "OnboardingRequired";
  }
}

export function createApp(input: {
  readonly db: Mon22rDb;
  readonly botToken: string;
  readonly allowed: ReadonlySet<number>;
  readonly miniAppDist?: string;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly runtime?: Runtime;
}): Hono<{ Variables: AppVars }> {
  const { db } = input;
  const now = input.now ?? (() => new Date());
  const log = input.log ?? silentLogger;
  const runtime = input.runtime ?? Object.assign(createRuntime("dev"), { pollingExpected: false });
  const dist = input.miniAppDist ?? resolve(process.cwd(), "apps/miniapp/dist");
  const app = new Hono<{ Variables: AppVars }>();
  let files: MiddlewareHandler<{ Variables: AppVars }> | null = null;
  let indexHtml: string | null = null;

  app.onError((error, c) => {
    if (error instanceof AccessError) return c.json({ error: error.message, code: "unauthorized" }, 401);
    if (error instanceof OnboardingRequired) return c.json({ error: error.message, code: "onboarding_required" }, 409);
    if (error instanceof LedgerError) {
      return c.json({ error: ledgerMessage(error), code: error.code }, ledgerStatus(error.code));
    }
    if (error instanceof HTTPException) {
      const status = error.status;
      const message = status === 413 ? "Слишком большой запрос." : "Запрос не выполнен.";
      return c.json({ error: message, code: status === 413 ? "too_large" : "bad_request" }, status);
    }
    log.error("request failed", { method: c.req.method, path: c.req.path, ...errorFields(error) });
    return c.json({ error: "Ошибка сервера.", code: "internal" }, 500);
  });

  // The Mini App runs inside Telegram's web clients in a frame, and in native clients in a web view.
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'self'", "https://web.telegram.org", "https://*.telegram.org"],
      },
      xFrameOptions: false,
      referrerPolicy: "no-referrer",
      strictTransportSecurity: "max-age=31536000",
      crossOriginResourcePolicy: "same-origin",
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.get("/healthz", (c) => {
    const report = readHealth(db, runtime, now().getTime());
    c.header("Cache-Control", "no-store");
    return c.json(report, report.ok ? 200 : 503);
  });

  app.use("/api/*", async (c, next) => {
    const started = performance.now();
    c.header("Cache-Control", "no-store");
    try {
      await next();
    } finally {
      log.info("request", {
        method: c.req.method,
        path: c.req.routePath,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      });
    }
  });

  app.use("/api/*", bodyLimit({ maxSize: BODY_LIMIT_BYTES }));

  app.use("/api/*", async (c, next) => {
    c.set("telegramId", telegramUserId(c.req.header("authorization"), input.botToken, input.allowed));
    await next();
  });

  app.get("/api/me", (c) => {
    const telegramId = c.get("telegramId");
    const user = getUserByTelegramId(db, telegramId);
    if (user === null) {
      return c.json({
        ready: false,
        telegramId,
        user: null,
        onboardingStep: "currency",
        accounts: [],
        categories: [],
        defaultAccountId: null,
        version: runtime.version,
      });
    }
    const flags = readUserFlags(db, user.id);
    const onboardingStep = flags?.onboardingStep ?? null;
    return c.json({
      ready: onboardingStep === null,
      telegramId,
      user,
      onboardingStep,
      accounts: listAccounts(db, user.id),
      categories: listCategories(db, user.id),
      defaultAccountId: flags?.defaultAccountId ?? null,
      version: runtime.version,
    });
  });

  app.post("/api/setup", async (c) => {
    const body = await readBody(c);
    const homeCurrency = readCurrency(body, "homeCurrency");
    const timeZone = readOptionalString(body, "timeZone") ?? DEFAULT_TIME_ZONE;
    const starterAccounts = readOptionalBoolean(body, "starterAccounts") ?? false;
    const telegramId = c.get("telegramId");
    let user = getUserByTelegramId(db, telegramId);
    if (user === null) {
      try {
        user = createUser(db, { telegramId, homeCurrency, timeZone });
      } catch (error) {
        if (!(error instanceof LedgerError) || error.code !== "conflict") throw error;
        user = getUserByTelegramId(db, telegramId);
        if (user === null) throw error;
      }
    }
    user = updateStoredUser(db, user.id, { homeCurrency, timeZone, onboardingStep: null });
    if (starterAccounts) createStarterAccounts(db, user.id);
    return c.json({ user, accounts: listAccounts(db, user.id), onboardingStep: null });
  });

  app.patch("/api/settings", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const patch: { homeCurrency?: string; timeZone?: string; defaultAccountId?: string | null } = {};
    if (Object.hasOwn(body, "homeCurrency")) patch.homeCurrency = readCurrency(body, "homeCurrency");
    if (Object.hasOwn(body, "timeZone")) patch.timeZone = readString(body, "timeZone");
    if (Object.hasOwn(body, "defaultAccountId")) patch.defaultAccountId = readNullableString(body, "defaultAccountId");
    if (Object.keys(patch).length === 0) throw new LedgerError("invalid_posting", "Nothing to update");
    const updated = updateStoredUser(db, user.id, patch);
    return c.json({ user: updated, defaultAccountId: readUserFlags(db, user.id)?.defaultAccountId ?? null });
  });

  app.get("/api/month", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json(buildMonthView(db, user, readMonthQuery(c.req.query("month"))));
  });

  app.patch("/api/plans/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const id = requiredParam(c.req.param("id"));
    const patch: {
      name?: string;
      amountMinor?: number;
      currency?: string;
      dayOfMonth?: number;
      accountId?: string | null;
      remind?: boolean;
    } = {};
    if (Object.hasOwn(body, "name")) patch.name = readText(body, "name");
    if (Object.hasOwn(body, "amountMinor")) patch.amountMinor = readMinor(body, "amountMinor");
    if (Object.hasOwn(body, "currency")) patch.currency = readCurrency(body, "currency");
    if (Object.hasOwn(body, "dayOfMonth")) patch.dayOfMonth = readDay(body, "dayOfMonth");
    if (Object.hasOwn(body, "accountId")) patch.accountId = readNullableString(body, "accountId");
    if (Object.hasOwn(body, "remind")) patch.remind = readBoolean(body, "remind");
    const active = Object.hasOwn(body, "active") ? readBoolean(body, "active") : undefined;
    if (Object.keys(patch).length === 0 && active === undefined) {
      throw new LedgerError("invalid_posting", "Nothing to update");
    }
    let plan = Object.keys(patch).length === 0 ? null : updateIncomePlan(db, user.id, id, patch);
    if (active === false) plan = stopPlan(db, user.id, id, monthContaining(now(), user.timeZone));
    else if (active === true) plan = updateIncomePlan(db, user.id, id, { active: true });
    if (plan === null) throw new LedgerError("invalid_posting", "Nothing to update");
    if (plan.active) refreshOpenExpectations(db, user.id, plan);
    return c.json({ plan });
  });

  app.patch("/api/expectations/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const expectation = setExpectationStatus(db, user.id, requiredParam(c.req.param("id")), readStatus(body));
    return c.json({ expectation });
  });

  app.get("/api/transactions", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const range = monthRange(readMonthQuery(c.req.query("month")), user.timeZone);
    return c.json({
      transactions: listTransactions(db, user.id, {
        fromInclusive: range.startInclusive.toISOString(),
        toExclusive: range.endExclusive.toISOString(),
      }),
    });
  });

  app.post("/api/transactions/categorize", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const ids = readIds(body, "ids");
    const updated = categorizeTransactions(db, user.id, ids, readNullableString(body, "categoryId"));
    return c.json({ updated });
  });

  app.patch("/api/transactions/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const patch: { categoryId?: string | null; accountId?: string } = {};
    if (Object.hasOwn(body, "categoryId")) patch.categoryId = readNullableString(body, "categoryId");
    if (Object.hasOwn(body, "accountId")) patch.accountId = readString(body, "accountId");
    const transaction = correctTransaction(db, user.id, requiredParam(c.req.param("id")), patch);
    return c.json({ transaction });
  });

  app.delete("/api/transactions/:id", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const deleted = deleteTransaction(db, user.id, requiredParam(c.req.param("id")));
    // Deleting twice is not an error: the row is gone either way.
    return c.json({ deleted: deleted.map((transaction) => transaction.id) });
  });

  app.post("/api/accounts", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const account = createAccount(db, user.id, {
      name: readText(body, "name"),
      currency: readCurrency(body, "currency"),
      createdAt: now().toISOString(),
    });
    return c.json({ account }, 201);
  });

  app.patch("/api/accounts/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const patch: { name?: string; archived?: boolean } = {};
    if (Object.hasOwn(body, "name")) patch.name = readText(body, "name");
    if (Object.hasOwn(body, "archived")) patch.archived = readBoolean(body, "archived");
    const account = updateAccount(db, user.id, requiredParam(c.req.param("id")), patch);
    return c.json({ account, defaultAccountId: readUserFlags(db, user.id)?.defaultAccountId ?? null });
  });

  app.post("/api/categories", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const category = createCategory(db, user.id, { name: readText(body, "name"), createdAt: now().toISOString() });
    return c.json({ category }, 201);
  });

  app.patch("/api/categories/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const category = renameCategory(db, user.id, requiredParam(c.req.param("id")), readText(body, "name"));
    return c.json({ category });
  });

  app.delete("/api/categories/:id", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json(deleteCategory(db, user.id, requiredParam(c.req.param("id"))));
  });

  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api") || c.req.path === "/healthz" || c.res.status !== 200) return;
    // Vite puts a content hash in every file name under assets/, so those never change. The page itself must
    // be revalidated, or a new release would not be picked up.
    const immutable = c.req.path.startsWith("/assets/");
    c.res.headers.set("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  });

  app.use("/*", async (c, next) => {
    if (c.req.path.startsWith("/api") || !existsSync(dist)) return next();
    files ??= serveStatic({ root: dist }) as MiddlewareHandler<{ Variables: AppVars }>;
    return files(c, next);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api")) return c.json({ error: "Not found", code: "not_found" }, 404);
    // A missing hashed asset must be a 404, not the page: otherwise a stale client caches HTML as script.
    if (c.req.method !== "GET" || c.req.path.startsWith("/assets/")) return c.text("Not found", 404);
    const index = resolve(dist, "index.html");
    if (indexHtml === null && existsSync(index)) indexHtml = readFileSync(index, "utf8");
    if (indexHtml === null) return c.text("Not found", 404);
    return c.html(indexHtml);
  });

  return app;
}

function requireUser(db: Mon22rDb, telegramId: number): User {
  const user = getUserByTelegramId(db, telegramId);
  if (user === null) throw new OnboardingRequired();
  return user;
}

function ledgerStatus(code: string): 400 | 404 | 409 {
  if (code === "not_found" || code === "account_not_found" || code === "category_not_found") return 404;
  if (code === "conflict") return 409;
  return 400;
}

/** A sentence the Mini App can show as is. Internal wording stays in the code. */
function ledgerMessage(error: LedgerError): string {
  switch (error.code) {
    case "not_found":
      return "Запись не найдена. Возможно, она уже удалена.";
    case "account_not_found":
      return "Счёт не найден.";
    case "category_not_found":
      return "Категория не найдена.";
    case "conflict":
      return "Такое название уже есть.";
    case "currency_mismatch":
      return "Валюта счёта не совпадает с валютой записи.";
    case "invalid_currency":
      return "Валюта не распознана.";
    case "invalid_time_zone":
      return "Часовой пояс не распознан.";
    case "invalid_amount":
      return "Сумма не распознана.";
    case "invalid_month":
      return "Месяц указан неверно.";
    default:
      return "Запрос не выполнен: проверьте поля.";
  }
}

async function readBody(c: AppContext): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new LedgerError("invalid_posting", "JSON body is required");
  }
  if (!isRecord(value)) throw new LedgerError("invalid_posting", "JSON body is required");
  return value;
}

function readMonthQuery(value: string | undefined): CalendarMonth {
  return parseMonth(value, "month must be YYYY-MM");
}

function parseMonth(value: string | undefined, message: string): CalendarMonth {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  const year = match?.[1];
  const month = match?.[2];
  if (year === undefined || month === undefined) throw new LedgerError("invalid_month", message);
  return assertCalendarMonth({ year: Number(year), month: Number(month) });
}

function readStatus(body: Record<string, unknown>): ExpectationStatus {
  const value = readString(body, "status");
  if (EXPECTATION_STATUSES.includes(value as ExpectationStatus)) return value as ExpectationStatus;
  throw new LedgerError("invalid_plan", "status must be expected, received, partial, or skipped");
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "" || value.trim() !== value || value.length > 200) {
    throw new LedgerError("invalid_posting", `${key} is required`);
  }
  return value;
}

/** An ISO 4217 code the runtime knows, so a typo cannot become an account currency. */
function readCurrency(body: Record<string, unknown>, key: string): string {
  const value = readString(body, key);
  if (!/^[A-Z]{3}$/.test(value) || !isKnownCurrency(value)) {
    throw new LedgerError("invalid_currency", `${key} must be an ISO 4217 code`);
  }
  return value;
}

function readText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 80) {
    throw new LedgerError("invalid_posting", `${key} is required`);
  }
  return value.trim();
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(body, key) || body[key] === undefined || body[key] === null) return undefined;
  return readString(body, key);
}

function readNullableString(body: Record<string, unknown>, key: string): string | null {
  if (body[key] === null) return null;
  return readString(body, key);
}

function readIds(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > BULK_LIMIT) {
    throw new LedgerError("invalid_posting", `${key} must list 1 to ${BULK_LIMIT} ids`);
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 64) {
      throw new LedgerError("invalid_posting", `${key} must list ids`);
    }
    ids.push(item);
  }
  return ids;
}

function readMinor(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new LedgerError("invalid_amount", `${key} must be a positive integer`);
  }
  return value;
}

function readInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LedgerError("invalid_posting", `${key} must be an integer`);
  }
  return value;
}

function readDay(body: Record<string, unknown>, key: string): number {
  const value = readInteger(body, key);
  if (value < 1 || value > 31) throw new LedgerError("invalid_plan", `${key} must be from 1 to 31`);
  return value;
}

function readBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new LedgerError("invalid_posting", `${key} must be a boolean`);
  return value;
}

function readOptionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(body, key) || body[key] === undefined) return undefined;
  return readBoolean(body, key);
}

function requiredParam(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 64) {
    throw new LedgerError("invalid_posting", "Id is required");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
