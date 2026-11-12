import type {
  Account,
  Category,
  CategorySpend,
  CurrencyCode,
  CurrencyTotals,
  Direction,
  ExpectationStatus,
  HomeCurrencyEstimate,
  ImportIdentity,
  IncomeExpectation,
  IncomePlan,
  PlanRecurrence,
  Transaction,
  TransactionKind,
  User,
} from "@mon22r/domain";

/**
 * HTTP contract for the mon22r server. Every call sends `Authorization: tma <raw init data>`.
 *
 * GET    /api/me                         -> { ready, user, onboardingStep, accounts, categories, defaultAccountId, version }
 * POST   /api/setup                      { homeCurrency, timeZone?, starterAccounts? } -> { user, accounts, onboardingStep: null }
 * PATCH  /api/settings                   { homeCurrency?, timeZone?, defaultAccountId? } -> { user, defaultAccountId }
 * GET    /api/month?month=YYYY-MM        -> { month, totalsByCurrency, categorySpend, expectations, plans, estimateInHomeCurrency, ... }
 * PATCH  /api/plans/:id                  { amountMinor?, currency?, active? } -> { plan }
 * PATCH  /api/expectations/:id           { status } -> { expectation }
 * GET    /api/transactions?month=YYYY-MM -> { transactions }
 * PATCH  /api/transactions/:id           { categoryId?, accountId? } -> { transaction }
 * POST   /api/transactions/categorize    { ids, categoryId } -> { updated }
 * DELETE /api/transactions/:id           -> { deleted: [ids] }
 * POST   /api/accounts                   { name, currency } -> 201 { account }
 * PATCH  /api/accounts/:id               { name?, archived? } -> { account, defaultAccountId }
 * POST   /api/categories                 { name } -> 201 { category }
 * PATCH  /api/categories/:id             { name } -> { category }
 * DELETE /api/categories/:id             -> { cleared }
 * Errors are { error, code }. `error` is a sentence that can be shown as is.
 *
 * Money stays in minor units. Currencies are not added together. A refund keeps a positive amountMinor.
 * Every answer is checked field by field before the interface uses it.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 500;
const UNREADABLE = "Не удалось прочитать ответ.";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type OnboardingStep = "currency" | "timezone" | "accounts";

export type Me = {
  readonly ready: boolean;
  readonly user: User | null;
  readonly onboardingStep: OnboardingStep | null;
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly defaultAccountId: string | null;
  readonly version: string;
};

export type MonthView = {
  readonly totalsByCurrency: readonly CurrencyTotals[];
  readonly categorySpend: readonly CategorySpend[];
  readonly expectations: readonly IncomeExpectation[];
  readonly plans: readonly IncomePlan[];
  readonly estimateInHomeCurrency: HomeCurrencyEstimate | null;
};

export type SetupInput = {
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly starterAccounts: boolean;
};

let initData = "";

export function setInitData(value: string): void {
  initData = value;
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Сессия истекла. Закройте приложение и откройте его из чата снова.";
    }
    const message = error.message.trim();
    if (message.length > 0 && message.length <= 180 && !message.includes("\n")) return message;
  }
  return fallback;
}

export async function getMe(): Promise<Me> {
  return readMe(await request("/me"));
}

export async function setup(input: SetupInput): Promise<User> {
  const row = asRecord(await send("POST", "/setup", input));
  const user = readUser(row.user);
  if (!user || row.onboardingStep !== null) throw new ApiError(200, UNREADABLE);
  return user;
}

export async function updateSettings(patch: {
  readonly homeCurrency?: string;
  readonly timeZone?: string;
  readonly defaultAccountId?: string | null;
}): Promise<{ readonly user: User; readonly defaultAccountId: string | null }> {
  const row = asRecord(await send("PATCH", "/settings", patch));
  return { user: required(readUser(row.user)), defaultAccountId: readNullableId(row.defaultAccountId) };
}

export async function getMonth(month: string): Promise<MonthView> {
  return readMonth(await request(`/month?month=${encodeURIComponent(month)}`));
}

export async function updatePlan(
  id: string,
  patch: { readonly amountMinor?: number; readonly currency?: string; readonly active?: boolean },
): Promise<IncomePlan> {
  const body = await send("PATCH", `/plans/${encodeURIComponent(id)}`, patch);
  return required(readPlan(asRecord(body).plan));
}

export async function updateExpectationStatus(id: string, status: ExpectationStatus): Promise<IncomeExpectation> {
  const body = await send("PATCH", `/expectations/${encodeURIComponent(id)}`, { status });
  return required(readExpectation(asRecord(body).expectation));
}

export async function getTransactions(month: string): Promise<readonly Transaction[]> {
  const body = await request(`/transactions?month=${encodeURIComponent(month)}`);
  return readRows(requireArray(asRecord(body), "transactions"), readTransaction);
}

export async function updateTransaction(
  id: string,
  patch: { readonly categoryId?: string | null; readonly accountId?: string },
): Promise<Transaction> {
  const body = await send("PATCH", `/transactions/${encodeURIComponent(id)}`, patch);
  return required(readTransaction(asRecord(body).transaction));
}

/** Sets or clears the category of many transactions. Returns how many rows changed. */
export async function categorizeTransactions(ids: readonly string[], categoryId: string | null): Promise<number> {
  const body = await send("POST", "/transactions/categorize", { ids, categoryId });
  return required(readInteger(asRecord(body).updated));
}

/** Returns the ids that were removed: both legs for a transfer, nothing when it was already gone. */
export async function deleteTransaction(id: string): Promise<readonly string[]> {
  const body = await send("DELETE", `/transactions/${encodeURIComponent(id)}`);
  return readRows(requireArray(asRecord(body), "deleted"), readId);
}

export async function createAccount(input: { readonly name: string; readonly currency: string }): Promise<Account> {
  const body = await send("POST", "/accounts", input);
  return required(readAccount(asRecord(body).account));
}

export async function updateAccount(
  id: string,
  patch: { readonly name?: string; readonly archived?: boolean },
): Promise<{ readonly account: Account; readonly defaultAccountId: string | null }> {
  const row = asRecord(await send("PATCH", `/accounts/${encodeURIComponent(id)}`, patch));
  return { account: required(readAccount(row.account)), defaultAccountId: readNullableId(row.defaultAccountId) };
}

export async function createCategory(name: string): Promise<Category> {
  const body = await send("POST", "/categories", { name });
  return required(readCategory(asRecord(body).category));
}

export async function renameCategory(id: string, name: string): Promise<Category> {
  const body = await send("PATCH", `/categories/${encodeURIComponent(id)}`, { name });
  return required(readCategory(asRecord(body).category));
}

export async function deleteCategory(id: string): Promise<void> {
  await send("DELETE", `/categories/${encodeURIComponent(id)}`);
}

function send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  return request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

/**
 * One API call with a time limit. A read that fails on the network is tried once more;
 * a write is not, because the first attempt may have reached the server.
 */
async function request(path: string, init?: { method?: string; body?: string }, attempt = 0): Promise<unknown> {
  const headers = new Headers({ Accept: "application/json", Authorization: `tma ${initData}` });
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers,
      cache: "no-store",
      signal: abort.signal,
    });
  } catch {
    const isRead = init?.method === undefined;
    if (isRead && attempt === 0 && !abort.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return request(path, init, 1);
    }
    throw new ApiError(0, abort.signal.aborted ? "Сервер не ответил. Попробуйте ещё раз." : "Нет соединения.");
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const body = text.trim() === "" ? null : parseJson(text, response.ok);
  if (!response.ok) {
    throw new ApiError(response.status, messageFromBody(body) ?? "Не удалось выполнить запрос.");
  }
  return body;
}

function parseJson(text: string, strict: boolean): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A proxy error page is not JSON; the status code already says what happened.
    if (!strict) return null;
    throw new ApiError(200, UNREADABLE);
  }
}

function messageFromBody(body: unknown): string | null {
  const sentence = asRecord(body).error;
  if (typeof sentence !== "string") return null;
  const message = sentence.trim();
  if (message.length === 0 || message.includes("\n")) return null;
  return message;
}

function readMe(body: unknown): Me {
  const row = asRecord(body);
  if (typeof row.ready !== "boolean") throw new ApiError(200, UNREADABLE);
  const user = row.user === null ? null : readUser(row.user);
  if (row.user !== null && user === null) throw new ApiError(200, UNREADABLE);
  if (row.ready && user === null) throw new ApiError(200, UNREADABLE);
  return {
    ready: row.ready,
    user,
    onboardingStep: readOnboardingStep(row.onboardingStep),
    accounts: readRows(requireArray(row, "accounts"), readAccount),
    categories: readRows(requireArray(row, "categories"), readCategory),
    defaultAccountId: readNullableId(row.defaultAccountId),
    version: typeof row.version === "string" ? row.version : "",
  };
}

function readMonth(body: unknown): MonthView {
  const row = asRecord(body);
  const month = asRecord(row.month);
  if (readInteger(month.year) === null || readInteger(month.month) === null) throw new ApiError(200, UNREADABLE);
  return {
    totalsByCurrency: readRows(requireArray(row, "totalsByCurrency"), readCurrencyTotals),
    categorySpend: readRows(requireArray(row, "categorySpend"), readCategorySpend),
    expectations: readRows(requireArray(row, "expectations"), readExpectation),
    plans: readRows(requireArray(row, "plans"), readPlan),
    estimateInHomeCurrency: readEstimate(row.estimateInHomeCurrency),
  };
}

function readPlan(value: unknown): IncomePlan | null {
  const row = asRecord(value);
  const id = readId(row.id);
  const name = readName(row.name);
  const amountMinor = readInteger(row.amountMinor);
  const currency = readCurrency(row.currency);
  const dayOfMonth = readDay(row.dayOfMonth);
  const recurrence = readRecurrence(row.recurrence);
  const startYear = readInteger(row.startYear);
  const startMonth = readInteger(row.startMonth);
  const remind = readBoolean(row.remind);
  const active = readBoolean(row.active);
  if (
    !id ||
    !name ||
    amountMinor === null ||
    amountMinor <= 0 ||
    !currency ||
    dayOfMonth === null ||
    !recurrence ||
    startYear === null ||
    startMonth === null ||
    startMonth < 1 ||
    startMonth > 12 ||
    remind === null ||
    active === null
  ) {
    return null;
  }
  if (!("accountId" in row)) return null;
  return {
    id,
    userId: readId(row.userId) ?? "",
    name,
    amountMinor,
    currency,
    dayOfMonth,
    accountId: readNullableId(row.accountId),
    recurrence,
    startYear,
    startMonth,
    remind,
    active,
  };
}

function readExpectation(value: unknown): IncomeExpectation | null {
  const row = asRecord(value);
  const id = readId(row.id);
  const name = readName(row.name);
  const expectedMinor = readInteger(row.expectedMinor);
  const receivedMinor = readInteger(row.receivedMinor);
  const currency = readCurrency(row.currency);
  const dayOfMonth = readDay(row.dayOfMonth);
  const status = readStatus(row.status);
  const year = readInteger(row.year);
  const month = readInteger(row.month);
  if (
    !id ||
    !name ||
    expectedMinor === null ||
    expectedMinor <= 0 ||
    receivedMinor === null ||
    receivedMinor < 0 ||
    !currency ||
    dayOfMonth === null ||
    !status ||
    year === null ||
    month === null ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }
  if (!("planId" in row) || !("accountId" in row) || !("matchedTransactionId" in row)) return null;
  return {
    id,
    userId: readId(row.userId) ?? "",
    planId: readNullableId(row.planId),
    year,
    month,
    name,
    expectedMinor,
    receivedMinor,
    currency,
    accountId: readNullableId(row.accountId),
    dayOfMonth,
    status,
    matchedTransactionId: readNullableId(row.matchedTransactionId),
  };
}

function readCurrencyTotals(value: unknown): CurrencyTotals | null {
  const row = asRecord(value);
  const currency = readCurrency(row.currency);
  const incomeMinor = readInteger(row.incomeMinor);
  const expenseMinor = readInteger(row.expenseMinor);
  if (!currency || incomeMinor === null || expenseMinor === null) return null;
  return { currency, incomeMinor, expenseMinor };
}

function readCategorySpend(value: unknown): CategorySpend | null {
  const row = asRecord(value);
  const currency = readCurrency(row.currency);
  const spentMinor = readInteger(row.spentMinor);
  if (!currency || spentMinor === null || !("categoryId" in row)) return null;
  return { categoryId: readNullableId(row.categoryId), currency, spentMinor };
}

function readEstimate(value: unknown): HomeCurrencyEstimate | null {
  if (value === null) return null;
  if (value === undefined) throw new ApiError(200, UNREADABLE);
  const estimate = asRecord(value);
  if (estimate.kind !== "estimate") throw new ApiError(200, UNREADABLE);
  const minor = readInteger(estimate.minor);
  const currency = readCurrency(estimate.currency);
  const asOf = readNullableText(estimate.asOf);
  const source = readNullableText(estimate.source);
  const usedConversion = readBoolean(estimate.usedConversion);
  if (minor === null || !currency || asOf === undefined || source === undefined || usedConversion === null) {
    throw new ApiError(200, UNREADABLE);
  }
  return { kind: "estimate", minor, currency, asOf, source, usedConversion };
}

function readTransaction(value: unknown): Transaction | null {
  const row = asRecord(value);
  const id = readId(row.id);
  const accountId = readId(row.accountId);
  const amountMinor = readInteger(row.amountMinor);
  const currency = readCurrency(row.currency);
  const kind = readKind(row.kind);
  const direction = readDirection(row.direction);
  const occurredAt = typeof row.occurredAt === "string" && row.occurredAt.length > 0 ? row.occurredAt : null;
  const description = typeof row.description === "string" ? row.description : null;
  const importIdentity = readImport(row.importIdentity);
  if (
    !id ||
    !accountId ||
    amountMinor === null ||
    amountMinor <= 0 ||
    !currency ||
    !kind ||
    !direction ||
    !occurredAt ||
    description === null ||
    importIdentity === undefined ||
    !("categoryId" in row)
  ) {
    return null;
  }
  return {
    id,
    userId: readId(row.userId) ?? "",
    accountId,
    categoryId: readNullableId(row.categoryId),
    amountMinor,
    currency,
    direction,
    kind,
    transferGroupId: readNullableId(row.transferGroupId),
    refundOfTransactionId: readNullableId(row.refundOfTransactionId),
    occurredAt,
    description,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : occurredAt,
    importIdentity,
  };
}

function readAccount(value: unknown): Account | null {
  const row = asRecord(value);
  const id = readId(row.id);
  const name = readName(row.name);
  const currency = readCurrency(row.currency);
  const archived = readBoolean(row.archived);
  if (!id || !name || !currency || archived === null) return null;
  return {
    id,
    userId: readId(row.userId) ?? "",
    currency,
    name,
    archived,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}

function readCategory(value: unknown): Category | null {
  const row = asRecord(value);
  const id = readId(row.id);
  const name = readName(row.name);
  if (!id || !name) return null;
  return {
    id,
    userId: readId(row.userId) ?? "",
    name,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}

function readUser(value: unknown): User | null {
  const row = asRecord(value);
  const id = readId(row.id);
  const homeCurrency = readCurrency(row.homeCurrency);
  const timeZone = typeof row.timeZone === "string" && row.timeZone.length > 0 ? row.timeZone : null;
  if (!id || !homeCurrency || !timeZone) return null;
  if (row.telegramId !== null && row.telegramId !== undefined && readInteger(row.telegramId) === null) return null;
  const telegramId = row.telegramId === null || row.telegramId === undefined ? null : readInteger(row.telegramId);
  return { id, telegramId, homeCurrency, timeZone, createdAt: typeof row.createdAt === "string" ? row.createdAt : "" };
}

function readRows<T>(items: readonly unknown[], read: (value: unknown) => T | null): readonly T[] {
  const rows: T[] = [];
  for (const item of items) {
    const row = read(item);
    if (row === null) throw new ApiError(200, UNREADABLE);
    rows.push(row);
  }
  return rows;
}

function required<T>(value: T | null): T {
  if (value === null) throw new ApiError(200, UNREADABLE);
  return value;
}

function requireArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) throw new ApiError(200, UNREADABLE);
  return value;
}

function readImport(value: unknown): ImportIdentity | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const row = asRecord(value);
  const source = readId(row.source);
  const externalKey = readId(row.externalKey);
  if (!source || !externalKey) return undefined;
  return { source, externalKey };
}

function readKind(value: unknown): TransactionKind | null {
  if (value === "expense" || value === "income" || value === "refund" || value === "transfer") return value;
  return null;
}

function readDirection(value: unknown): Direction | null {
  if (value === "inflow" || value === "outflow") return value;
  return null;
}

function readRecurrence(value: unknown): PlanRecurrence | null {
  if (value === "monthly" || value === "once") return value;
  return null;
}

function readStatus(value: unknown): ExpectationStatus | null {
  if (value === "expected" || value === "received" || value === "partial" || value === "skipped") return value;
  return null;
}

function readOnboardingStep(value: unknown): OnboardingStep | null {
  if (value === null) return null;
  if (value === "currency" || value === "timezone" || value === "accounts") return value;
  throw new ApiError(200, UNREADABLE);
}

function readCurrency(value: unknown): CurrencyCode | null {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) return null;
  return value;
}

function readDay(value: unknown): number | null {
  const day = readInteger(value);
  if (day === null || day < 1 || day > 31) return null;
  return day;
}

function readInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function readId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function readNullableId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return readId(value);
}

function readNullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length === 0 ? null : name;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
