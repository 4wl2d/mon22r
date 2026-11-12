import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import {
  correctTransaction,
  createAccount,
  createCategory,
  createIncomePlan,
  createUser,
  deleteLatestTransaction,
  getUserByTelegramId,
  listAccounts,
  listCategories,
  listIncomeExpectations,
  listIncomePlans,
  listTransactions,
  materializePlanExpectation,
  readUserFlags,
  recordTransaction,
  recordTransfer,
  updateAccount,
  updateIncomePlan,
  updateStoredUser,
  type Mon22rDb,
} from "@mon22r/db";
import {
  assertCalendarMonth,
  EXPECTATION_STATUSES,
  expectationFromPlan,
  LedgerError,
  monthRange,
  type CalendarMonth,
  type ExpectationStatus,
  type PlanRecurrence,
  type User,
} from "@mon22r/domain";
import type { PreviewRow } from "@mon22r/importers";
import { Hono, type MiddlewareHandler } from "hono";

import { AccessError, telegramUserId } from "./auth.js";
import { buildMonthView } from "./month-view.js";
import { commitStoredPreview, previewUpload, type UploadResult } from "./imports.js";
import { copyPlans, materializeApplicable, refreshOpenExpectations, setExpectationStatus } from "./plans.js";
import { createStarterAccounts } from "./starter.js";

type AppVars = { telegramId: number };

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
}): Hono<{ Variables: AppVars }> {
  const { db } = input;
  const now = input.now ?? (() => new Date());
  const dist = input.miniAppDist ?? resolve(process.cwd(), "apps/miniapp/dist");
  const app = new Hono<{ Variables: AppVars }>();
  let files: MiddlewareHandler<{ Variables: AppVars }> | null = null;

  app.onError((error, c) => {
    if (error instanceof AccessError) return c.json({ error: error.message, code: "unauthorized" }, 401);
    if (error instanceof OnboardingRequired) return c.json({ error: error.message, code: "onboarding_required" }, 409);
    if (error instanceof LedgerError) return c.json({ error: error.message, code: error.code }, ledgerStatus(error.code));
    console.error(error);
    return c.json({ error: "Ошибка сервера.", code: "internal" }, 500);
  });

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
    });
  });

  app.post("/api/setup", async (c) => {
    const body = await readBody(c);
    const homeCurrency = readString(body, "homeCurrency");
    const timeZone = readOptionalString(body, "timeZone") ?? "Europe/Belgrade";
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

  app.get("/api/month", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json(buildMonthView(db, user, readMonthQuery(c.req.query("month"))));
  });

  app.get("/api/plans", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const month = readMonthQuery(c.req.query("month"));
    materializeApplicable(db, user.id, month);
    const plans = listIncomePlans(db, user.id).filter(
      (plan) => plan.active && expectationFromPlan(plan, month, "draft") !== null,
    );
    return c.json({
      month,
      plans,
      expectations: listIncomeExpectations(db, user.id, month),
    });
  });

  app.post("/api/plans/copy", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const to = readMonthValue(body, "toMonth");
    const expectations = copyPlans(db, user.id, readMonthValue(body, "fromMonth"), to);
    return c.json({ month: to, expectations });
  });

  app.post("/api/plans", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const plan = createIncomePlan(db, user.id, {
      name: readText(body, "name"),
      amountMinor: readMinor(body, "amountMinor"),
      currency: readString(body, "currency"),
      dayOfMonth: readDay(body, "dayOfMonth"),
      accountId: readOptionalNullable(body, "accountId") ?? null,
      recurrence: readRecurrence(body),
      startYear: readInteger(body, "startYear"),
      startMonth: readInteger(body, "startMonth"),
      remind: readOptionalBoolean(body, "remind") ?? false,
      active: readOptionalBoolean(body, "active") ?? true,
    });
    const month = { year: plan.startYear, month: plan.startMonth };
    const expectation = expectationFromPlan(plan, month, "draft")
      ? materializePlanExpectation(db, user.id, plan.id, month)
      : null;
    return c.json({ plan, expectation }, 201);
  });

  app.patch("/api/plans/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const patch: {
      name?: string;
      amountMinor?: number;
      currency?: string;
      dayOfMonth?: number;
      accountId?: string | null;
      remind?: boolean;
      active?: boolean;
    } = {};
    if (Object.hasOwn(body, "name")) patch.name = readText(body, "name");
    if (Object.hasOwn(body, "amountMinor")) patch.amountMinor = readMinor(body, "amountMinor");
    if (Object.hasOwn(body, "currency")) patch.currency = readString(body, "currency");
    if (Object.hasOwn(body, "dayOfMonth")) patch.dayOfMonth = readDay(body, "dayOfMonth");
    if (Object.hasOwn(body, "accountId")) patch.accountId = readNullableString(body, "accountId");
    if (Object.hasOwn(body, "remind")) patch.remind = readBoolean(body, "remind");
    if (Object.hasOwn(body, "active")) patch.active = readBoolean(body, "active");
    if (Object.keys(patch).length === 0) throw new LedgerError("invalid_posting", "Nothing to update");
    const plan = updateIncomePlan(db, user.id, requiredParam(c.req.param("id")), patch);
    refreshOpenExpectations(db, user.id, plan);
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

  app.post("/api/transactions", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const kind = readString(body, "kind");
    const occurredAt = readString(body, "occurredAt");
    const description = readOptionalText(body, "description") ?? "";
    const createdAt = now().toISOString();
    if (kind === "transfer") {
      const currency = readString(body, "currency");
      const amountMinor = readMinor(body, "amountMinor");
      const transactions = recordTransfer(db, user.id, {
        fromAccountId: readString(body, "fromAccountId"),
        toAccountId: readString(body, "toAccountId"),
        from: { minor: amountMinor, currency },
        to: {
          minor: Object.hasOwn(body, "toAmountMinor") ? readMinor(body, "toAmountMinor") : amountMinor,
          currency: readOptionalString(body, "toCurrency") ?? currency,
        },
        occurredAt,
        description,
        createdAt,
      });
      return c.json({ transactions }, 201);
    }
    if (kind !== "expense" && kind !== "income" && kind !== "refund") {
      throw new LedgerError("invalid_posting", "kind must be expense, income, refund, or transfer");
    }
    const recorded = recordTransaction(db, user.id, {
      accountId: readString(body, "accountId"),
      kind,
      amountMinor: readMinor(body, "amountMinor"),
      currency: readString(body, "currency"),
      categoryId: readOptionalNullable(body, "categoryId"),
      refundOfTransactionId: kind === "refund" ? (readOptionalNullable(body, "refundOfTransactionId") ?? null) : undefined,
      occurredAt,
      description,
      createdAt,
    });
    return c.json({ transactions: [recorded.transaction] }, 201);
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

  app.post("/api/undo", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json({ deleted: deleteLatestTransaction(db, user.id) });
  });

  app.get("/api/accounts", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json({ accounts: listAccounts(db, user.id) });
  });

  app.post("/api/accounts", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const account = createAccount(db, user.id, { name: readText(body, "name"), currency: readString(body, "currency") });
    return c.json({ account }, 201);
  });

  app.patch("/api/accounts/:id", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const patch: { name?: string; archived?: boolean } = {};
    if (Object.hasOwn(body, "name")) patch.name = readText(body, "name");
    if (Object.hasOwn(body, "archived")) patch.archived = readBoolean(body, "archived");
    const account = updateAccount(db, user.id, requiredParam(c.req.param("id")), patch);
    return c.json({ account });
  });

  app.get("/api/categories", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json({ categories: listCategories(db, user.id) });
  });

  app.post("/api/categories", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const body = await readBody(c);
    const category = createCategory(db, user.id, { name: readText(body, "name") });
    return c.json({ category }, 201);
  });

  app.post("/api/imports/preview", async (c) => {
    const user = requireUser(db, c.get("telegramId"));
    const request = await readImportRequest(c);
    if (request.csv.length > 1_500_000) throw new LedgerError("invalid_posting", "File is too large");
    return c.json(uploadJson(previewUpload(db, user, request.csv, request)));
  });

  app.post("/api/imports/:id/commit", (c) => {
    const user = requireUser(db, c.get("telegramId"));
    return c.json(commitStoredPreview(db, user, requiredParam(c.req.param("id"))));
  });

  app.use("/*", async (c, next) => {
    if (c.req.path.startsWith("/api") || !existsSync(dist)) return next();
    files ??= serveStatic({ root: dist }) as MiddlewareHandler<{ Variables: AppVars }>;
    return files(c, next);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api")) return c.json({ error: "Not found", code: "not_found" }, 404);
    const index = resolve(dist, "index.html");
    if (c.req.method === "GET" && existsSync(index)) return c.html(readFileSync(index, "utf8"));
    return c.text("Not found", 404);
  });

  return app;
}

function requireUser(db: Mon22rDb, telegramId: number): User {
  const user = getUserByTelegramId(db, telegramId);
  if (user === null) throw new OnboardingRequired();
  return user;
}

function uploadJson(result: UploadResult): Record<string, unknown> {
  switch (result.type) {
    case "empty":
      return { status: "empty" };
    case "mapping_required":
      return { status: "mapping_required", fingerprint: result.fingerprint, headers: result.headers };
    case "mixed_currency":
      return { status: "mixed_currency" };
    case "no_account":
      return { status: "no_account", currency: result.currency };
    case "currency_mismatch":
      return {
        status: "currency_mismatch",
        accountName: result.accountName,
        accountCurrency: result.accountCurrency,
        fileCurrency: result.fileCurrency,
      };
    case "counts":
      return { status: "preview", id: null, source: result.source, counts: result.counts, rows: result.rows.map(publicRow) };
    case "choose_account":
      return {
        status: "account_required",
        id: result.previewId,
        accounts: result.accounts,
        counts: result.counts,
        rows: result.rows.map(publicRow),
      };
    case "ready":
      return {
        status: "preview",
        id: result.previewId,
        source: result.source,
        accountId: result.account.id,
        counts: result.counts,
        rows: result.rows.map(publicRow),
      };
  }
}

function publicRow(row: PreviewRow): {
  status: PreviewRow["status"];
  reason: PreviewRow["reason"];
  externalKey: string | null;
  bookedAt: string | null;
  amountMinor: number | null;
  currency: string | null;
  direction: "inflow" | "outflow" | null;
  description: string | null;
} {
  return {
    status: row.status,
    reason: row.reason,
    externalKey: row.line?.externalKey ?? null,
    bookedAt: row.line?.bookedAt ?? null,
    amountMinor: row.line?.amountMinor ?? null,
    currency: row.line?.currency ?? null,
    direction: row.line?.direction ?? null,
    description: row.line?.description ?? null,
  };
}

function ledgerStatus(code: string): 400 | 404 | 409 {
  if (code === "not_found" || code === "account_not_found" || code === "category_not_found") return 404;
  if (code === "conflict") return 409;
  return 400;
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    if (!isRecord(value)) throw new LedgerError("invalid_posting", "JSON body is required");
    return value;
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("invalid_posting", "JSON body is required");
  }
}

async function readImportRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    parseBody: () => Promise<Record<string, unknown>>;
  };
}): Promise<{ csv: string; accountId?: string; profileName?: string; mapping?: unknown }> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await readBody(c);
    return {
      csv: readCsv(body),
      accountId: readOptionalString(body, "accountId"),
      profileName: readOptionalText(body, "profileName"),
      mapping: Object.hasOwn(body, "mapping") ? body.mapping : undefined,
    };
  }
  if (type.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body.file;
    const csvField = body.csv;
    let csv = "";
    if (typeof csvField === "string") csv = csvField;
    else if (isTextFile(file)) csv = await file.text();
    else throw new LedgerError("invalid_posting", "CSV file is required");
    const mappingRaw = typeof body.mapping === "string" ? body.mapping : undefined;
    return {
      csv,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      profileName: typeof body.profileName === "string" ? body.profileName : undefined,
      mapping: mappingRaw === undefined ? undefined : (JSON.parse(mappingRaw) as unknown),
    };
  }
  if (type.includes("text/csv") || type.includes("text/plain")) {
    const mappingHeader = c.req.header("x-mapping");
    return {
      csv: await c.req.text(),
      accountId: c.req.header("x-account-id"),
      profileName: c.req.header("x-profile-name"),
      mapping: mappingHeader === undefined ? undefined : (JSON.parse(mappingHeader) as unknown),
    };
  }
  throw new LedgerError("invalid_posting", "JSON or CSV body is required");
}

function readMonthQuery(value: string | undefined): CalendarMonth {
  return parseMonth(value, "month must be YYYY-MM");
}

function readMonthValue(body: Record<string, unknown>, key: string): CalendarMonth {
  return parseMonth(readString(body, key), `${key} must be YYYY-MM`);
}

function parseMonth(value: string | undefined, message: string): CalendarMonth {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  const year = match?.[1];
  const month = match?.[2];
  if (year === undefined || month === undefined) throw new LedgerError("invalid_month", message);
  return assertCalendarMonth({ year: Number(year), month: Number(month) });
}

function readRecurrence(body: Record<string, unknown>): PlanRecurrence {
  const value = readString(body, "recurrence");
  if (value === "monthly" || value === "once") return value;
  throw new LedgerError("invalid_plan", "recurrence must be monthly or once");
}

function readStatus(body: Record<string, unknown>): ExpectationStatus {
  const value = readString(body, "status");
  if (EXPECTATION_STATUSES.includes(value as ExpectationStatus)) return value as ExpectationStatus;
  throw new LedgerError("invalid_plan", "status must be expected, received, partial, or skipped");
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "" || value.trim() !== value) {
    throw new LedgerError("invalid_posting", `${key} is required`);
  }
  return value;
}

function readText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new LedgerError("invalid_posting", `${key} is required`);
  return value.trim();
}

function readOptionalText(body: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(body, key) || body[key] === undefined || body[key] === null) return undefined;
  return readText(body, key);
}

function readCsv(body: Record<string, unknown>): string {
  const value = body.csv;
  if (typeof value !== "string" || value.trim().length === 0) throw new LedgerError("invalid_posting", "csv is required");
  return value;
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(body, key) || body[key] === undefined || body[key] === null) return undefined;
  return readString(body, key);
}

function readNullableString(body: Record<string, unknown>, key: string): string | null {
  if (body[key] === null) return null;
  return readString(body, key);
}

function readOptionalNullable(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  return readNullableString(body, key);
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
  if (value === undefined || value.length === 0) throw new LedgerError("invalid_posting", "Id is required");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextFile(value: unknown): value is { text: () => Promise<string> } {
  if (typeof value !== "object" || value === null || !("text" in value)) return false;
  return typeof value.text === "function";
}
