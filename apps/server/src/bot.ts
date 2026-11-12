import {
  correctTransaction,
  createUser,
  deleteLatestTransaction,
  deleteTransaction,
  getIncomeExpectation,
  getTransaction,
  getUserByTelegramId,
  listCategories,
  readUserFlags,
  updateIncomeExpectation,
  updateStoredUser,
  type Mon22rDb,
} from "@mon22r/db";
import { DEFAULT_TIME_ZONE, LedgerError, matchInflowToExpectation, type User } from "@mon22r/domain";
import { Bot, InlineKeyboard, type Context } from "grammy";

import { callbackData, readCallback } from "./callbacks.js";
import { applyPhrase, type CaptureResult } from "./capture.js";
import { buttons, monthLabel, text } from "./copy.js";
import { formatEntry, formatMinor } from "./format.js";
import { assignPreviewAccount, commitStoredPreview, previewUpload, savePendingProfile, type UploadResult } from "./imports.js";
import { awaitingStep, decideOnboarding, type OnboardingStep } from "./onboarding.js";
import { createStarterAccounts } from "./starter.js";

const FILE_LIMIT = 1_500_000;

export function createBot(input: {
  readonly token: string;
  readonly db: Mon22rDb;
  readonly allowed: ReadonlySet<number>;
  readonly miniAppUrl?: string;
  readonly now?: () => Date;
  readonly downloadFile?: (filePath: string) => Promise<Uint8Array>;
}): Bot {
  const appMarkup = appReplyMarkup(input.miniAppUrl);
  const bot = new Bot(input.token);
  const now = input.now ?? (() => new Date());
  const download = input.downloadFile ?? ((filePath: string) => downloadTelegramFile(input.token, filePath));

  bot.catch((error) => {
    console.error(error instanceof Error ? error.name : "bot");
  });

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id === undefined || !input.allowed.has(id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: text.denied });
      else if (ctx.chat?.type === "private") await ctx.reply(text.denied);
      return;
    }
    if (ctx.chat?.type !== undefined && ctx.chat.type !== "private") return;
    await next();
  });

  bot.on("callback_query:data", async (ctx) => {
    const session = loadSession(input.db, ctx.from.id);
    const parsed = readCallback(ctx.callbackQuery.data);
    let toast: string | undefined;
    try {
      if (parsed?.prefix === "z" && session.step === "timezone" && session.user !== null) {
        updateStoredUser(input.db, session.user.id, { timeZone: DEFAULT_TIME_ZONE, onboardingStep: "accounts" });
        await ctx.reply(text.askAccounts, { reply_markup: accountsKeyboard() });
      } else if ((parsed?.prefix === "y" || parsed?.prefix === "n") && session.step === "accounts" && session.user !== null) {
        await finishAccounts(input.db, session.user.id, parsed.prefix === "y", ctx, appMarkup);
      } else if (parsed?.prefix === "u" && session.user !== null) {
        const id = parsed.ids[0];
        const deleted = id === undefined ? [] : deleteTransaction(input.db, session.user.id, id);
        const reply = deleted.length === 0 ? text.alreadyUndone : text.undone;
        await ctx.editMessageText(reply).catch(async () => ctx.reply(reply));
      } else if (parsed?.prefix === "c" && session.user !== null) {
        toast = await rememberCategory(input.db, session.user.id, parsed.ids[0], parsed.ids[1]);
      } else if (parsed?.prefix === "m" && session.user !== null) {
        toast = closeOffer(input.db, session.user.id, parsed.ids[0], parsed.ids[1]);
      } else if (parsed?.prefix === "i" && session.user !== null) {
        const id = parsed.ids[0];
        if (id !== undefined) await commitImport(input.db, session.user, id, ctx);
      } else if (parsed?.prefix === "b" && session.user !== null) {
        const previewId = parsed.ids[0];
        const accountId = parsed.ids[1];
        if (previewId !== undefined && accountId !== undefined) {
          await replyImport(ctx, assignPreviewAccount(input.db, session.user, previewId, accountId));
        }
      } else if (session.step !== "ready") {
        await prompt(ctx, session.step);
      }
    } finally {
      await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast }).catch(() => undefined);
    }
  });

  bot.on("message:document", async (ctx) => {
    const session = loadSession(input.db, ctx.from.id);
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
      await replyImport(ctx, previewUpload(input.db, session.user, csv));
    } catch (error) {
      console.error(error instanceof Error ? error.name : "import");
      await ctx.reply(text.fileUnreadable);
    }
  });

  bot.on("message:text", async (ctx) => {
    const message = ctx.message.text;
    const session = loadSession(input.db, ctx.from.id);
    try {
      const command = commandName(message);
      if (command === "start" || command === "help") {
        if (session.step === "ready") await ctx.reply(text.help, appMarkup);
        else await prompt(ctx, session.step);
        return;
      }
      if (command === "undo") {
        if (session.step !== "ready" || session.user === null) {
          await prompt(ctx, session.step);
          return;
        }
        const deleted = deleteLatestTransaction(input.db, session.user.id);
        await ctx.reply(deleted.length === 0 ? text.nothingToUndo : text.undone);
        return;
      }
      if (session.step === "currency") {
        const decision = decideOnboarding("currency", message);
        if (decision.type !== "save-currency") {
          await ctx.reply(text.invalidCurrency);
          return;
        }
        await saveCurrency(input.db, ctx.from.id, decision.homeCurrency, ctx);
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
        updateStoredUser(input.db, session.user.id, { timeZone: decision.timeZone, onboardingStep: "accounts" });
        await ctx.reply(text.askAccounts, { reply_markup: accountsKeyboard() });
        return;
      }
      if (session.step === "accounts") {
        const decision = decideOnboarding("accounts", message);
        if (decision.type !== "finish") {
          await ctx.reply(text.needYesOrNo, { reply_markup: accountsKeyboard() });
          return;
        }
        await finishAccounts(input.db, session.user.id, decision.createStarterAccounts, ctx, appMarkup);
        return;
      }
      if (/^профиль(?:\s|$)/iu.test(message)) {
        const saved = savePendingProfile(input.db, session.user, message);
        await ctx.reply(
          saved === "saved" ? text.profileSaved : saved === "missing" ? text.fileFirst : saved === "columns" ? text.columnsMissing : text.profileBad,
        );
        return;
      }
      const result = applyPhrase(input.db, session.user, message, now());
      const keyboard = captureKeyboard(input.db, session.user.id, result);
      const line = renderCapture(result);
      if (keyboard === undefined) await ctx.reply(line);
      else await ctx.reply(line, { reply_markup: keyboard });
    } catch (error) {
      console.error(error instanceof Error ? error.name : "text");
      await ctx.reply(text.unparsed);
    }
  });

  return bot;
}

function loadSession(db: Mon22rDb, telegramId: number): { readonly user: User | null; readonly step: OnboardingStep } {
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
  markup: { readonly reply_markup: InlineKeyboard } | undefined,
): Promise<void> {
  if (create) createStarterAccounts(db, userId);
  updateStoredUser(db, userId, { onboardingStep: null });
  const lead = create ? text.accountsCreated : text.accountsSkipped;
  await ctx.reply(`${lead}\n\n${text.help}`, markup);
}

function appReplyMarkup(url: string | undefined): { readonly reply_markup: InlineKeyboard } | undefined {
  if (!isMiniAppUrl(url)) return undefined;
  return { reply_markup: new InlineKeyboard().webApp("mon22r", url) };
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

function renderCapture(result: CaptureResult): string {
  switch (result.type) {
    case "unparsed":
      return text.unparsed;
    case "no_account":
      return text.noAccount(result.currency);
    case "no_destination":
      return text.noDestination(result.name);
    case "same_account":
      return text.sameAccount;
    case "currency_mismatch":
      return text.currencyMismatch(result.accountName, result.accountCurrency, result.amountCurrency);
    case "saved":
      return formatEntry(result.transaction.amountMinor, result.transaction.currency, result.transaction.description, result.account.name);
    case "transfer":
      return formatEntry(result.transactions[0].amountMinor, result.transactions[0].currency, result.transactions[0].description, result.from.name);
    case "plan":
      return text.planSaved(
        formatMinor(result.plan.amountMinor, result.plan.currency),
        result.plan.currency,
        result.plan.name,
        result.expectation.dayOfMonth,
        monthLabel(result.expectation.year, result.expectation.month),
      );
  }
}

function captureKeyboard(db: Mon22rDb, userId: string, result: CaptureResult): InlineKeyboard | undefined {
  if (result.type !== "saved" && result.type !== "transfer") return undefined;
  const transaction = result.type === "saved" ? result.transaction : result.transactions[0];
  const keyboard = new InlineKeyboard();
  const undo = callbackData("u", [transaction.id]);
  if (undo !== null) keyboard.text(buttons.undo, undo);
  if (result.type === "saved" && result.transaction.categoryId === null) {
    for (const category of listCategories(db, userId).slice(0, 12)) {
      const data = callbackData("c", [transaction.id, category.id]);
      if (data !== null) keyboard.row().text(category.name.slice(0, 32), data);
    }
  }
  if (result.type === "saved" && result.offer !== null) {
    const data = callbackData("m", [transaction.id, result.offer.expectationId]);
    if (data !== null) keyboard.row().text(text.closePlan(result.offer.name).slice(0, 32), data);
  }
  return keyboard.inline_keyboard.length === 0 ? undefined : keyboard;
}

async function rememberCategory(db: Mon22rDb, userId: string, transactionId: string | undefined, categoryId: string | undefined): Promise<string | undefined> {
  if (transactionId === undefined || categoryId === undefined) return undefined;
  try {
    correctTransaction(db, userId, transactionId, { categoryId });
    return undefined;
  } catch (error) {
    if (error instanceof LedgerError) return text.alreadyUndone;
    throw error;
  }
}

function closeOffer(db: Mon22rDb, userId: string, transactionId: string | undefined, expectationId: string | undefined): string {
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
    const reply = result.created === 0 ? text.nothingNew : text.importDone(result.created);
    await ctx.editMessageText(reply).catch(async () => ctx.reply(reply));
  } catch (error) {
    if (error instanceof LedgerError) {
      await ctx.reply(text.nothingNew);
      return;
    }
    throw error;
  }
}

function renderAssignment(result: UploadResult): string {
  if (result.type === "ready") return `${text.importCounts(result.counts)}\n${result.account.name}`;
  if (result.type === "currency_mismatch") return text.currencyMismatch(result.accountName, result.accountCurrency, result.fileCurrency);
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
    await ctx.reply(text.importCounts(result.counts), data === null ? undefined : { reply_markup: keyboard });
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

async function downloadTelegramFile(token: string, filePath: string): Promise<Uint8Array> {
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!response.ok) throw new Error("download failed");
  return new Uint8Array(await response.arrayBuffer());
}
