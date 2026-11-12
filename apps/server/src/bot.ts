import {
  claimUpdate,
  correctTransaction,
  createUser,
  deleteLatestTransaction,
  deleteTransaction,
  getIncomeExpectation,
  getTransaction,
  getUserByTelegramId,
  isUpdateHandled,
  listAccounts,
  listCategories,
  type Mon22rDb,
  readUserFlags,
  updateIncomeExpectation,
  updateStoredUser,
} from "@mon22r/db";
import {
  DEFAULT_TIME_ZONE,
  LedgerError,
  matchInflowToExpectation,
  monthContaining,
  type Transaction,
  type User,
} from "@mon22r/domain";
import { Bot, type Context, GrammyError, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import { callbackData, readCallback } from "./callbacks.js";
import { applyPhrase, type CaptureResult } from "./capture.js";
import { buttons, monthLabel, text } from "./copy.js";
import { viewEntry } from "./entry-view.js";
import { formatEntry, formatMinor, formatTransfer } from "./format.js";
import type { Runtime } from "./health.js";
import {
  assignPreviewAccount,
  commitStoredPreview,
  previewUpload,
  savePendingProfile,
  type UploadResult,
} from "./imports.js";
import { errorFields, type Logger, silentLogger } from "./log.js";
import { monthSummary } from "./month-summary.js";
import { awaitingStep, decideOnboarding, type OnboardingStep } from "./onboarding.js";
import { boundedRetry } from "./retry.js";
import { createStarterAccounts } from "./starter.js";

const FILE_LIMIT = 1_500_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Longer than a 30-second long poll, far shorter than the library's default of 500 seconds. */
const API_TIMEOUT_SECONDS = 50;

type Session = { readonly user: User | null; readonly step: OnboardingStep };
type Markup = { readonly reply_markup: InlineKeyboard } | undefined;

export function createBot(input: {
  readonly token: string;
  readonly db: Mon22rDb;
  readonly allowed: ReadonlySet<number>;
  readonly miniAppUrl?: string;
  readonly now?: () => Date;
  readonly downloadFile?: (filePath: string) => Promise<Uint8Array>;
  readonly log?: Logger;
  readonly runtime?: Runtime;
  /** Alternative Bot API root: a local Bot API server, or a stub in tests. */
  readonly apiRoot?: string;
  /** Skips the `getMe` call at start. Tests pass it. */
  readonly botInfo?: UserFromGetMe;
}): Bot {
  const { db } = input;
  const log = input.log ?? silentLogger;
  const appMarkup = appReplyMarkup(input.miniAppUrl);
  const bot = new Bot(input.token, {
    client: {
      timeoutSeconds: API_TIMEOUT_SECONDS,
      ...(input.apiRoot === undefined ? {} : { apiRoot: input.apiRoot }),
    },
    ...(input.botInfo === undefined ? {} : { botInfo: input.botInfo }),
  });
  const now = input.now ?? (() => new Date());
  const apiRoot = input.apiRoot ?? "https://api.telegram.org";
  const download = input.downloadFile ?? ((filePath: string) => downloadTelegramFile(apiRoot, input.token, filePath));

  // Dropped connections, 5xx answers, and short flood limits get a few quick retries, then the handler sees the error.
  bot.api.config.use(boundedRetry());
  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === "getUpdates" && input.runtime !== undefined) input.runtime.lastPollAt = Date.now();
    return result;
  });

  bot.catch((failure) => {
    log.error("bot update failed", { updateId: failure.ctx.update.update_id, ...errorFields(failure.error) });
  });

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id === undefined || !input.allowed.has(id)) {
      log.warn("bot access denied", { updateId: ctx.update.update_id, chatType: ctx.chat?.type });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: text.denied });
      else if (ctx.chat?.type === "private") await ctx.reply(text.denied);
      return;
    }
    if (ctx.chat?.type !== undefined && ctx.chat.type !== "private") return;
    await next();
  });

  bot.on("callback_query:data", async (ctx) => {
    let toast: string | undefined;
    try {
      toast = await handleCallback(ctx, ctx.callbackQuery.data);
    } catch (error) {
      log.error("callback failed", { updateId: ctx.update.update_id, ...errorFields(error) });
      // The button may already have changed the entry before the redraw failed, so this cannot claim otherwise.
      toast = text.failedAction;
    } finally {
      await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast }).catch(() => undefined);
    }
  });

  async function handleCallback(ctx: Context, data: string): Promise<string | undefined> {
    const from = ctx.from;
    if (from === undefined) return undefined;
    const session = loadSession(db, from.id);
    const parsed = readCallback(data);
    const user = session.user;
    if (parsed === null || user === null) {
      if (session.step !== "ready") await prompt(ctx, session.step);
      return undefined;
    }
    const [first, second] = parsed.ids;
    switch (parsed.prefix) {
      case "z":
        if (session.step !== "timezone") return undefined;
        updateStoredUser(db, user.id, { timeZone: DEFAULT_TIME_ZONE, onboardingStep: "accounts" });
        await ctx.reply(text.askAccounts, { reply_markup: accountsKeyboard() });
        return undefined;
      case "y":
      case "n":
        if (session.step !== "accounts") return undefined;
        await finishAccounts(db, user.id, parsed.prefix === "y", ctx, appMarkup);
        return undefined;
      case "u": {
        const deleted = first === undefined ? [] : deleteTransaction(db, user.id, first);
        const reply = deleted.length === 0 ? text.alreadyUndone : text.undone(describeDeleted(db, user.id, deleted));
        await redraw(ctx, reply, undefined);
        return undefined;
      }
      case "c": {
        if (first === undefined || second === undefined) return undefined;
        const transaction = correctOrNull(db, user.id, first, { categoryId: second });
        if (transaction === null) return text.alreadyUndone;
        const view = viewEntry(db, user.id, transaction);
        await redraw(ctx, view.text, view.keyboard);
        return undefined;
      }
      case "a": {
        if (first === undefined || second === undefined) return undefined;
        const transaction = correctOrNull(db, user.id, first, { accountId: second });
        if (transaction === null) return text.alreadyUndone;
        const view = viewEntry(db, user.id, transaction);
        await redraw(ctx, view.text, view.keyboard);
        const account = listAccounts(db, user.id).find((item) => item.id === transaction.accountId);
        return account === undefined ? undefined : text.movedTo(account.name);
      }
      case "m": {
        const toast = closeOffer(db, user.id, first, second);
        const transaction = first === undefined ? null : getTransaction(db, user.id, first);
        if (transaction !== null) {
          const view = viewEntry(db, user.id, transaction);
          await redraw(ctx, view.text, view.keyboard);
        }
        return toast;
      }
      case "i":
        if (first !== undefined) await commitImport(db, user, first, ctx);
        return undefined;
      case "b":
        if (first !== undefined && second !== undefined) {
          await replyImport(ctx, assignPreviewAccount(db, user, first, second));
        }
        return undefined;
      default:
        if (session.step !== "ready") await prompt(ctx, session.step);
        return undefined;
    }
  }

  bot.on("message:document", async (ctx) => {
    const session = loadSession(db, ctx.from.id);
    if (session.step !== "ready" || session.user === null) {
      await ctx.reply(text.setupFirst);
      return;
    }
    const document = ctx.message.document;
    if ((document.file_size ?? 0) > FILE_LIMIT) {
      await ctx.reply(text.fileTooBig);
      return;
    }
    try {
      const remote = await ctx.getFile();
      if (remote.file_path === undefined) {
        await ctx.reply(text.fileUnreadable);
        return;
      }
      const bytes = await download(remote.file_path);
      if (bytes.byteLength > FILE_LIMIT) {
        await ctx.reply(text.fileTooBig);
        return;
      }
      if (!isCsvDocument(document.file_name, document.mime_type, bytes)) {
        await ctx.reply(text.needCsv);
        return;
      }
      const csv = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      await replyImport(ctx, previewUpload(db, session.user, csv));
    } catch (error) {
      log.error("import upload failed", { updateId: ctx.update.update_id, ...errorFields(error) });
      await ctx.reply(text.fileUnreadable);
    }
  });

  bot.on("message:text", async (ctx) => {
    const message = ctx.message.text;
    const session = loadSession(db, ctx.from.id);
    try {
      await handleText(ctx, session, message);
    } catch (error) {
      // A rule violation the parser let through is the user's to fix; anything else is ours.
      if (error instanceof LedgerError) {
        log.warn("text rejected", { updateId: ctx.update.update_id, code: error.code });
        await ctx.reply(text.unparsed);
        return;
      }
      log.error("text failed", { updateId: ctx.update.update_id, ...errorFields(error) });
      await ctx.reply(text.failed);
    }
  });

  async function handleText(ctx: Context, session: Session, message: string): Promise<void> {
    const telegramId = ctx.from?.id;
    if (telegramId === undefined) return;
    const command = commandName(message);
    if (command === "start" || command === "help") {
      if (session.step === "ready") await ctx.reply(text.help, appMarkup);
      else await prompt(ctx, session.step);
      return;
    }
    if (command === "undo" || command === "month") {
      if (session.step !== "ready" || session.user === null) {
        await prompt(ctx, session.step);
        return;
      }
      if (command === "month") {
        const month = monthContaining(now(), session.user.timeZone);
        await ctx.reply(monthSummary(db, session.user, month), appMarkup);
        return;
      }
      const undo = undoLatest(db, session.user.id, ctx.update.update_id, now());
      if (undo.type === "undone") await confirmWrite(ctx, () => ({ text: text.undone(undo.line) }));
      else await ctx.reply(undo.type === "replayed" ? text.replayed : text.nothingToUndo);
      return;
    }
    if (session.step === "currency") {
      const decision = decideOnboarding("currency", message);
      if (decision.type !== "save-currency") {
        await ctx.reply(text.invalidCurrency);
        return;
      }
      await saveCurrency(db, telegramId, decision.homeCurrency, ctx);
      return;
    }
    if (session.user === null) {
      await prompt(ctx, "currency");
      return;
    }
    if (session.step === "timezone") {
      const decision = decideOnboarding("timezone", message);
      if (decision.type !== "save-timezone") {
        await ctx.reply(text.invalidTimeZone, { reply_markup: timezoneKeyboard() });
        return;
      }
      updateStoredUser(db, session.user.id, { timeZone: decision.timeZone, onboardingStep: "accounts" });
      await ctx.reply(text.askAccounts, { reply_markup: accountsKeyboard() });
      return;
    }
    if (session.step === "accounts") {
      const decision = decideOnboarding("accounts", message);
      if (decision.type !== "finish") {
        await ctx.reply(text.needYesOrNo, { reply_markup: accountsKeyboard() });
        return;
      }
      await finishAccounts(db, session.user.id, decision.createStarterAccounts, ctx, appMarkup);
      return;
    }
    if (/^профиль(?:\s|$)/iu.test(message)) {
      const saved = savePendingProfile(db, session.user, message);
      await ctx.reply(
        saved === "saved"
          ? text.profileSaved
          : saved === "missing"
            ? text.fileFirst
            : saved === "columns"
              ? text.columnsMissing
              : text.profileBad,
      );
      return;
    }
    const user = session.user;
    const result = applyPhrase(db, user, message, now(), { updateId: ctx.update.update_id });
    if (result.type === "saved" || result.type === "transfer" || result.type === "plan") {
      await confirmWrite(ctx, () => renderCapture(db, user, result));
      return;
    }
    const reply = renderCapture(db, user, result);
    await ctx.reply(reply.text, reply.keyboard === undefined ? undefined : { reply_markup: reply.keyboard });
  }

  /**
   * Sends the confirmation of a change that is already in the ledger.
   * If it cannot be built or sent, a plain line goes out instead and the error stays here:
   * letting it reach the caller would produce "nothing was recorded", which would be false and invite a duplicate.
   */
  async function confirmWrite(
    ctx: Context,
    build: () => { readonly text: string; readonly keyboard?: InlineKeyboard },
  ): Promise<void> {
    try {
      const reply = build();
      await ctx.reply(reply.text, reply.keyboard === undefined ? undefined : { reply_markup: reply.keyboard });
    } catch (error) {
      log.error("confirmation failed after a write", { updateId: ctx.update.update_id, ...errorFields(error) });
      await ctx.reply(text.doneUnconfirmed).catch(() => undefined);
    }
  }

  bot.on("edited_message", async (ctx) => {
    await ctx.reply(text.editIgnored);
  });

  bot.on("message", async (ctx) => {
    await ctx.reply(text.unsupported);
  });

  return bot;
}

function loadSession(db: Mon22rDb, telegramId: number): Session {
  const user = getUserByTelegramId(db, telegramId);
  if (user === null) return { user: null, step: "currency" };
  const flags = readUserFlags(db, user.id);
  return { user, step: awaitingStep({ userExists: true, onboardingStep: flags?.onboardingStep ?? null }) };
}

async function saveCurrency(db: Mon22rDb, telegramId: number, homeCurrency: string, ctx: Context): Promise<void> {
  let user = getUserByTelegramId(db, telegramId);
  if (user === null) {
    try {
      user = createUser(db, { telegramId, homeCurrency, timeZone: DEFAULT_TIME_ZONE });
    } catch (error) {
      if (!(error instanceof LedgerError) || error.code !== "conflict") throw error;
      user = getUserByTelegramId(db, telegramId);
      if (user === null) throw error;
    }
  } else {
    user = updateStoredUser(db, user.id, { homeCurrency });
  }
  updateStoredUser(db, user.id, { onboardingStep: "timezone" });
  await ctx.reply(text.askTimeZone, { reply_markup: timezoneKeyboard() });
}

async function finishAccounts(
  db: Mon22rDb,
  userId: string,
  create: boolean,
  ctx: Context,
  markup: Markup,
): Promise<void> {
  if (create) createStarterAccounts(db, userId);
  updateStoredUser(db, userId, { onboardingStep: null });
  const lead = create ? text.accountsCreated : text.accountsSkipped;
  await ctx.reply(`${lead}\n\n${text.help}`, markup);
}

function appReplyMarkup(url: string | undefined): Markup {
  if (!isMiniAppUrl(url)) return undefined;
  return { reply_markup: new InlineKeyboard().webApp(buttons.app, url) };
}

function isMiniAppUrl(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "example.com";
  } catch {
    return false;
  }
}

async function prompt(ctx: Context, step: OnboardingStep): Promise<void> {
  if (step === "timezone") {
    await ctx.reply(text.askTimeZone, { reply_markup: timezoneKeyboard() });
    return;
  }
  if (step === "accounts") {
    await ctx.reply(text.askAccounts, { reply_markup: accountsKeyboard() });
    return;
  }
  if (step === "currency") await ctx.reply(text.askCurrency);
}

/** Replaces the message a button belongs to. Falls back to a new message when it can no longer be edited. */
async function redraw(ctx: Context, body: string, keyboard: InlineKeyboard | undefined): Promise<void> {
  try {
    await ctx.editMessageText(body, keyboard === undefined ? undefined : { reply_markup: keyboard });
  } catch (error) {
    // Telegram answers 400 when a double tap asks for the text that is already shown.
    if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
    await ctx.reply(body, keyboard === undefined ? undefined : { reply_markup: keyboard });
  }
}

function renderCapture(
  db: Mon22rDb,
  user: User,
  result: CaptureResult,
): { readonly text: string; readonly keyboard?: InlineKeyboard } {
  switch (result.type) {
    case "unparsed":
      return { text: text.unparsed };
    case "replayed":
      return { text: text.replayed };
    case "no_account":
      return { text: text.noAccount(result.currency) };
    case "unknown_account":
      return { text: text.noDestination(result.name) };
    case "ambiguous_account":
      return {
        text: text.ambiguousAccount(
          result.name,
          result.candidates.map((account) => account.name),
        ),
      };
    case "same_account":
      return { text: text.sameAccount };
    case "arrival_amount_required":
      return { text: text.arrivalRequired(result.from.name, result.to.name, result.to.currency) };
    case "currency_mismatch":
      return { text: text.currencyMismatch(result.accountName, result.accountCurrency, result.amountCurrency) };
    case "saved": {
      const view = viewEntry(db, user.id, result.transaction);
      const note = result.createdCategory === null ? "" : `\n${text.newCategory(result.createdCategory.name)}`;
      return { text: `${view.text}${note}`, keyboard: view.keyboard };
    }
    case "transfer": {
      const [outflow, inflow] = result.transactions;
      const keyboard = new InlineKeyboard();
      const undo = callbackData("u", [outflow.id]);
      if (undo !== null) keyboard.text(buttons.undo, undo);
      return { text: formatTransfer(outflow, inflow, result.from.name, result.to.name), keyboard };
    }
    case "plan":
      return {
        text: text.planSaved(
          formatMinor(result.plan.amountMinor, result.plan.currency),
          result.plan.currency,
          result.plan.name,
          result.expectation.dayOfMonth,
          monthLabel(result.expectation.year, result.expectation.month),
        ),
      };
  }
}

/**
 * `/undo`, applied at most once per Telegram update: the deletion and the "this update is done" mark share one
 * transaction, so a redelivered `/undo` does not go on to remove the entry before.
 */
function undoLatest(
  db: Mon22rDb,
  userId: string,
  updateId: number,
  at: Date,
): { readonly type: "replayed" | "nothing" } | { readonly type: "undone"; readonly line: string } {
  const apply = db.sqlite.transaction(() => {
    if (isUpdateHandled(db, updateId)) return { type: "replayed" as const };
    const deleted = deleteLatestTransaction(db, userId);
    if (deleted.length === 0) return { type: "nothing" as const };
    claimUpdate(db, updateId, at);
    return { type: "undone" as const, line: describeDeleted(db, userId, deleted) };
  });
  return apply();
}

/** Says what an undo removed, so a wrong undo is noticed at once. */
function describeDeleted(db: Mon22rDb, userId: string, deleted: readonly Transaction[]): string {
  const accounts = new Map(listAccounts(db, userId).map((account) => [account.id, account.name]));
  const nameOf = (transaction: Transaction): string => accounts.get(transaction.accountId) ?? "счёт";
  const outflow = deleted.find((item) => item.kind === "transfer" && item.direction === "outflow");
  const inflow = deleted.find((item) => item.kind === "transfer" && item.direction === "inflow");
  if (outflow !== undefined && inflow !== undefined) {
    return formatTransfer(outflow, inflow, nameOf(outflow), nameOf(inflow));
  }
  const single = deleted[0];
  if (single === undefined) return "";
  const category =
    single.categoryId === null
      ? null
      : (listCategories(db, userId).find((item) => item.id === single.categoryId)?.name ?? null);
  return formatEntry(single, nameOf(single), category);
}

function correctOrNull(
  db: Mon22rDb,
  userId: string,
  transactionId: string,
  patch: { readonly categoryId?: string; readonly accountId?: string },
): Transaction | null {
  try {
    return correctTransaction(db, userId, transactionId, patch);
  } catch (error) {
    // The entry, the category, or the account was removed after the buttons were drawn.
    if (error instanceof LedgerError) return null;
    throw error;
  }
}

function closeOffer(
  db: Mon22rDb,
  userId: string,
  transactionId: string | undefined,
  expectationId: string | undefined,
): string {
  if (transactionId === undefined || expectationId === undefined) return text.alreadyClosed;
  const transaction = getTransaction(db, userId, transactionId);
  const expectation = getIncomeExpectation(db, userId, expectationId);
  if (transaction === null || transaction.kind !== "income" || expectation === null) return text.alreadyClosed;
  const match = matchInflowToExpectation([expectation], {
    id: transaction.id,
    userId,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    accountId: transaction.accountId,
  });
  if (match === null) return text.alreadyClosed;
  updateIncomeExpectation(db, userId, expectation.id, {
    status: match.status,
    receivedMinor: match.expectation.receivedMinor,
    matchedTransactionId: transaction.id,
  });
  return text.closed;
}

async function commitImport(db: Mon22rDb, user: User, previewId: string, ctx: Context): Promise<void> {
  try {
    const result = commitStoredPreview(db, user, previewId);
    await redraw(ctx, result.created === 0 ? text.nothingNew : text.importDone(result.created), undefined);
  } catch (error) {
    if (error instanceof LedgerError) {
      await redraw(ctx, text.nothingNew, undefined);
      return;
    }
    throw error;
  }
}

function renderAssignment(result: UploadResult): string {
  if (result.type === "ready") return `${text.importCounts(result.counts)}\n${result.account.name}`;
  if (result.type === "currency_mismatch")
    return text.currencyMismatch(result.accountName, result.accountCurrency, result.fileCurrency);
  if (result.type === "no_account") return text.noAccount(result.currency);
  if (result.type === "mixed_currency") return text.mixedCurrency;
  return text.fileUnreadable;
}

async function replyImport(ctx: Context, result: UploadResult): Promise<void> {
  if (result.type === "mapping_required") {
    await ctx.reply(text.mappingNeeded(result.headers));
    return;
  }
  if (result.type === "empty") {
    await ctx.reply(text.importEmpty);
    return;
  }
  if (result.type === "counts") {
    await ctx.reply(text.importCounts(result.counts));
    return;
  }
  if (result.type === "choose_account") {
    const keyboard = new InlineKeyboard();
    for (const account of result.accounts) {
      const data = callbackData("b", [result.previewId, account.id]);
      if (data !== null) keyboard.row().text(account.name.slice(0, 32), data);
    }
    await ctx.reply(`${text.importCounts(result.counts)}\n${text.accountChoice}`, { reply_markup: keyboard });
    return;
  }
  if (result.type === "ready") {
    const keyboard = new InlineKeyboard();
    const data = result.counts.new > 0 ? callbackData("i", [result.previewId]) : null;
    if (data !== null) keyboard.text(buttons.commit, data);
    await ctx.reply(
      `${text.importCounts(result.counts)}\n${result.account.name}`,
      data === null ? undefined : { reply_markup: keyboard },
    );
    return;
  }
  await ctx.reply(renderAssignment(result));
}

function timezoneKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(buttons.timeZone, "z");
}

function accountsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(buttons.yes, "y").text(buttons.no, "n");
}

function commandName(value: string): string | null {
  const match = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function isCsvDocument(fileName: string | undefined, mime: string | undefined, bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.length, 1000);
  for (let index = 0; index < sample; index += 1) {
    if (bytes[index] === 0) return false;
  }
  const name = fileName?.toLowerCase() ?? "";
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".pdf") || name.endsWith(".ofx")) return false;
  if (name.endsWith(".csv") || name.endsWith(".txt")) return true;
  if (mime !== undefined && (mime.includes("csv") || mime.startsWith("text/"))) return true;
  return !name.includes(".");
}

async function downloadTelegramFile(apiRoot: string, token: string, filePath: string): Promise<Uint8Array> {
  const response = await fetch(`${apiRoot}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`File download failed with status ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > FILE_LIMIT) throw new Error("File is larger than the import limit");
  return new Uint8Array(await response.arrayBuffer());
}
