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
 * HTTP contract for the mon22r server.
 *
 * Authorization: `tma <raw init data>`.
 * GET /api/me -> { ready, telegramId, user, onboardingStep, accounts, categories }
 *   ready is true only after onboarding. onboardingStep is currency, timezone, accounts, or null.
 *   user may already exist while ready is false.
 * POST /api/setup { homeCurrency, timeZone?, starterAccounts? } -> { user, accounts, onboardingStep: null }
 * GET /api/month?month=YYYY-MM -> { month: { year, month }, homeCurrency, timeZone, totalsByCurrency, categorySpend, expectations, estimateInHomeCurrency }
 * GET /api/plans?month=YYYY-MM -> { month, plans, expectations }
 * PATCH /api/plans/:id { amountMinor, currency } -> { plan }
 * POST /api/plans/copy { fromMonth, toMonth } -> { month, expectations }
 * PATCH /api/expectations/:id { status } -> { expectation }
 * GET /api/transactions?month=YYYY-MM -> { transactions }
 * PATCH /api/transactions/:id { categoryId?, accountId? } -> { transaction }
 * GET /api/accounts -> { accounts }; POST -> 201 { account }; PATCH -> { account }
 * GET /api/categories -> { categories }; POST -> 201 { category }
 * Errors are { error, code }. `error` is a sentence. `code` is not shown.
 *
 * Money stays in minor units. Currencies are not added together. A refund keeps a positive amountMinor.
 */

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
  readonly telegramId: number | null;
  readonly user: User | null;
  readonly onboardingStep: OnboardingStep | null;
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
};

export type MonthView = {
  readonly totalsByCurrency: readonly CurrencyTotals[];
  readonly categorySpend: readonly CategorySpend[];
  readonly estimateInHomeCurrency: HomeCurrencyEstimate | null;
};

export type PlanRow = {
  readonly plan: IncomePlan | null;
  readonly expectation: IncomeExpectation | null;
};

export type SetupInput = {
  readonly homeCurrency: string;
  readonly timeZone: string;
  readonly starterAccounts: boolean;
};

export type NewPlan = {
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly dayOfMonth: number;
  readonly accountId: string | null;
  readonly recurrence: PlanRecurrence;
  readonly startYear: number;
  readonly startMonth: number;
};

let initData = "";

export function setInitData(value: string): void {
  initData = value;
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "Нет доступа.";
    const message = error.message.trim();
    if (message.length > 0 && message.length <= 180 && !message.includes("\n")) return message;
  }
  return fallback;
}

export async function getMe(): Promise<Me> {
  return readMe(await request("/me"));
}

export async function setup(input: SetupInput): Promise<User> {
  const body = await request("/setup", {
    method: "POST",
    body: JSON.stringify({
      homeCurrency: input.homeCurrency,
      timeZone: input.timeZone,
      starterAccounts: input.starterAccounts,
    }),
  });
  const row = asRecord(body);
  const user = readUser(row.user);
  if (!user || row.onboardingStep !== null) throw new ApiError(200, "Не удалось прочитать ответ.");
  return user;
}

export async function getMonth(month: string): Promise<MonthView> {
  return readMonth(await request(`/month?month=${encodeURIComponent(month)}`));
}

export async function getPlans(month: string): Promise<readonly PlanRow[]> {
  return readPlans(await request(`/plans?month=${encodeURIComponent(month)}`));
}

export async function createPlan(input: NewPlan): Promise<IncomePlan> {
  const body = await request("/plans", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return readRequired(readPlan(asRecord(body).plan), "Не удалось прочитать ответ.");
}

export async function updatePlanAmount(id: string, amountMinor: number, currency: string): Promise<IncomePlan> {
  const body = await request(`/plans/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ amountMinor, currency }),
  });
  return readRequired(readPlan(asRecord(body).plan), "Не удалось прочитать ответ.");
}

export async function copyPlans(fromMonth: string, toMonth: string): Promise<void> {
  const body = await request("/plans/copy", {
    method: "POST",
    body: JSON.stringify({ fromMonth, toMonth }),
  });
  const row = asRecord(body);
  requireArray(row, "expectations");
  const month = asRecord(row.month);
  if (readInteger(month.year) === null || readInteger(month.month) === null) {
    throw new ApiError(200, "Не удалось прочитать ответ.");
  }
}

export async function updateExpectationStatus(id: string, status: ExpectationStatus): Promise<IncomeExpectation> {
  const body = await request(`/expectations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  return readRequired(readExpectation(asRecord(body).expectation), "Не удалось прочитать ответ.");
}

export async function getTransactions(month: string): Promise<readonly Transaction[]> {
  const body = await request(`/transactions?month=${encodeURIComponent(month)}`);
  return readList(body, "transactions", readTransaction);
}

export async function updateTransaction(
  id: string,
  patch: { readonly categoryId?: string | null; readonly accountId?: string },
): Promise<Transaction> {
  const body = await request(`/transactions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return readRequired(readTransaction(asRecord(body).transaction), "Не удалось прочитать ответ.");
}

export async function getAccounts(): Promise<readonly Account[]> {
  const body = await request("/accounts");
  return readList(body, "accounts", readAccount);
}

export async function createAccount(input: { readonly name: string; readonly currency: string }): Promise<Account> {
  const body = await request("/accounts", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return readRequired(readAccount(asRecord(body).account), "Не удалось прочитать ответ.");
}

export async function updateAccount(
  id: string,
  patch: { readonly name?: string; readonly archived?: boolean },
): Promise<Account> {
  const body = await request(`/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return readRequired(readAccount(asRecord(body).account), "Не удалось прочитать ответ.");
}

export async function getCategories(): Promise<readonly Category[]> {
  const body = await request("/categories");
  return readList(body, "categories", readCategory);
}

export async function createCategory(name: string): Promise<Category> {
  const body = await request("/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return readRequired(readCategory(asRecord(body).category), "Не удалось прочитать ответ.");
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `tma ${initData}`);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers,
      cache: "no-store",
    } as RequestInit);
  } catch {
    throw new ApiError(0, "Нет соединения.");
  }
  const text = await response.text();
  const body = text.trim() === "" ? null : parseJson(text);
  if (!response.ok) {
    throw new ApiError(response.status, messageFromBody(body) ?? "Не удалось выполнить запрос.");
  }
  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(200, "Не удалось прочитать ответ.");
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
  if (typeof row.ready !== "boolean") throw new ApiError(200, "Не удалось прочитать ответ.");
  const user = row.user === null ? null : readUser(row.user);
  if (row.user !== null && user === null) throw new ApiError(200, "Не удалось прочитать ответ.");
  if (row.ready && user === null) throw new ApiError(200, "Не удалось прочитать ответ.");
  const onboardingStep = readOnboardingStep(row.onboardingStep);
  return {
    ready: row.ready,
    telegramId: readTelegramId(row.telegramId),
    user,
    onboardingStep,
    accounts: readRows(requireArray(row, "accounts"), readAccount),
    categories: readRows(requireArray(row, "categories"), readCategory),
  };
}

function readMonth(body: unknown): MonthView {
  const row = asRecord(body);
  const month = asRecord(row.month);
  if (readInteger(month.year) === null || readInteger(month.month) === null) {
    throw new ApiError(200, "Не удалось прочитать ответ.");
  }
  if (readCurrency(row.homeCurrency) === null) throw new ApiError(200, "Не удалось прочитать ответ.");
  if (typeof row.timeZone !== "string" || row.timeZone.length === 0) {
    throw new ApiError(200, "Не удалось прочитать ответ.");
  }
  requireArray(row, "expectations");
  return {
    totalsByCurrency: readRows(requireArray(row, "totalsByCurrency"), readCurrencyTotals),
    categorySpend: readRows(requireArray(row, "categorySpend"), readCategorySpend),
    estimateInHomeCurrency: readEstimate(row.estimateInHomeCurrency),
  };
}

function readPlans(body: unknown): readonly PlanRow[] {
  const row = asRecord(body);
  const month = asRecord(row.month);
  if (readInteger(month.year) === null || readInteger(month.month) === null) {
    throw new ApiError(200, "Не удалось прочитать ответ.");
  }
  const plans = readRows(requireArray(row, "plans"), readPlan);
  const expectations = readRows(requireArray(row, "expectations"), readExpectation);
  const byPlan = new Map<string, IncomeExpectation>();
  for (const expectation of expectations) {
    if (expectation.planId) byPlan.set(expectation.planId, expectation);
  }
  const matched = new Set<string>();
  const rows: PlanRow[] = [];
  for (const plan of plans) {
    const expectation = byPlan.get(plan.id) ?? null;
    if (expectation) matched.add(expectation.id);
    rows.push({ plan, expectation });
  }
  for (const expectation of expectations) {
    if (matched.has(expectation.id)) continue;
    if (expectation.planId !== null && plans.some((plan) => plan.id === expectation.planId)) continue;
    rows.push({ plan: null, expectation });
  }
  return rows.sort(comparePlans);
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
  return {
    categoryId: readNullableId(row.categoryId),
    currency,
    spentMinor,
  };
}

function readEstimate(value: unknown): HomeCurrencyEstimate | null {
  if (value === null) return null;
  if (value === undefined) throw new ApiError(200, "Не удалось прочитать ответ.");
  const estimate = asRecord(value);
  if (estimate.kind !== "estimate") throw new ApiError(200, "Не удалось прочитать ответ.");
  const minor = readInteger(estimate.minor);
  const currency = readCurrency(estimate.currency);
  const asOf = readNullableText(estimate.asOf);
  const source = readNullableText(estimate.source);
  const usedConversion = readBoolean(estimate.usedConversion);
  if (minor === null || !currency || asOf === undefined || source === undefined || usedConversion === null) {
    throw new ApiError(200, "Не удалось прочитать ответ.");
  }
  return {
    kind: "estimate",
    minor,
    currency,
    asOf,
    source,
    usedConversion,
  };
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
  return {
    id,
    telegramId,
    homeCurrency,
    timeZone,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}

function readList<T>(body: unknown, key: string, read: (value: unknown) => T | null): readonly T[] {
  return readRows(requireArray(asRecord(body), key), read);
}

function readRows<T>(items: readonly unknown[], read: (value: unknown) => T | null): readonly T[] {
  const rows: T[] = [];
  for (const item of items) {
    const row = read(item);
    if (!row) throw new ApiError(200, "Не удалось прочитать ответ.");
    rows.push(row);
  }
  return rows;
}

function readRequired<T>(value: T | null, message: string): T {
  if (value === null) throw new ApiError(200, message);
  return value;
}

function requireArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) throw new ApiError(200, "Не удалось прочитать ответ.");
  return value;
}

function comparePlans(left: PlanRow, right: PlanRow): number {
  const day = planDay(left) - planDay(right);
  if (day !== 0) return day;
  return planName(left).localeCompare(planName(right), "ru");
}

function planDay(row: PlanRow): number {
  return row.plan?.dayOfMonth ?? row.expectation?.dayOfMonth ?? 0;
}

function planName(row: PlanRow): string {
  return row.plan?.name ?? row.expectation?.name ?? "";
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
  throw new ApiError(200, "Не удалось прочитать ответ.");
}

function readTelegramId(value: unknown): number | null {
  if (value === null) return null;
  const id = readInteger(value);
  if (id === null) throw new ApiError(200, "Не удалось прочитать ответ.");
  return id;
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
