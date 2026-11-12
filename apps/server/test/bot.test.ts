import {
  createUser,
  getUserByTelegramId,
  listAccounts,
  listCategories,
  listTransactions,
  type Mon22rDb,
  recordTransaction,
  updateStoredUser,
} from "@mon22r/db";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";

import { createBot } from "../src/bot.js";
import { text, toast } from "../src/copy.js";
import { createStarterAccounts } from "../src/starter.js";
import { callbackUpdate, memoryDatabase, recordingLogger, TEST_TOKEN, textUpdate } from "./helpers.js";

const OWNER = 42;
const now = new Date("2026-11-12T10:00:00.000Z");
const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "mon22r",
  username: "mon22r_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

type Sent = { readonly method: string; readonly payload: Record<string, unknown> };
type Button = { readonly text: string; readonly callback_data?: string };

function harness(
  db: Mon22rDb,
  options?: {
    clock?: () => Date;
    files?: Record<string, string>;
    /** Makes the stand-in refuse a call the way Telegram refuses a bad request. */
    reject?: (method: string, payload: Record<string, unknown>) => boolean;
  },
) {
  const sent: Sent[] = [];
  const logger = recordingLogger();
  const bot = createBot({
    token: TEST_TOKEN,
    db,
    allowed: new Set([OWNER]),
    miniAppUrl: "https://ledger.test",
    now: options?.clock ?? (() => now),
    log: logger.log,
    botInfo,
    downloadFile: async (path) => new TextEncoder().encode(options?.files?.[path] ?? ""),
  });
  // The last transformer installed runs first, so no call leaves the process.
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    if (options?.reject?.(method, payload as Record<string, unknown>) === true) {
      return { ok: false, error_code: 400, description: "Bad Request: simulated" } as never;
    }
    const result = method === "getFile" ? { file_id: "f", file_unique_id: "u", file_path: "statement.csv" } : true;
    return { ok: true, result } as never;
  });
  let nextId = 1;
  return {
    sent,
    lines: logger.lines,
    async say(message: string, from = OWNER, chatType = "private") {
      const before = sent.length;
      await bot.handleUpdate(textUpdate(nextId++, from, message, chatType) as Update);
      return sent.slice(before);
    },
    async press(data: string, from = OWNER) {
      const before = sent.length;
      await bot.handleUpdate(callbackUpdate(nextId++, from, data) as Update);
      return sent.slice(before);
    },
    async deliver(update: unknown) {
      const before = sent.length;
      await bot.handleUpdate(update as Update);
      return sent.slice(before);
    },
  };
}

function readyOwner(db: Mon22rDb) {
  const user = createUser(db, { id: "user-a", telegramId: OWNER, homeCurrency: "RSD", timeZone: "Europe/Belgrade" });
  createStarterAccounts(db, user.id);
  return user;
}

function buttons(call: Sent | undefined): Button[] {
  const markup = call?.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function dataOf(call: Sent | undefined, label: string): string {
  const data = buttons(call).find((button) => button.text === label)?.callback_data;
  if (data === undefined)
    throw new Error(
      `No button "${label}" among: ${buttons(call)
        .map((item) => item.text)
        .join(", ")}`,
    );
  return data;
}

describe("bot", () => {
  it("walks a new owner through setup and then captures", async () => {
    const db = memoryDatabase();
    const chat = harness(db);
    const start = await chat.say("/start");
    expect(start[0]?.payload).toMatchObject({ text: text.start, parse_mode: "HTML" });
    expect(buttons(start[0]).map((button) => button.text)).toEqual(["EUR", "RSD", "RUB", "GBP"]);
    expect((await chat.say("динары"))[0]?.payload.text).toBe(text.invalidCurrency);
    const zone = await chat.say("rsd");
    expect(zone[0]?.payload.text).toBe(text.askTimeZone);
    // A pressed setup button turns its question into the answer, then the next question arrives.
    const accounts = await chat.press(dataOf(zone[0], "Оставить Europe/Belgrade"));
    expect(accounts[0]).toMatchObject({
      method: "editMessageText",
      payload: { text: text.timeZoneChosen("Europe/Belgrade") },
    });
    expect(buttons(accounts[0])).toEqual([]);
    expect(accounts[1]?.payload.text).toBe(text.askAccounts);
    const done = await chat.press(dataOf(accounts[1], "Создать счета"));
    expect(done[0]?.payload.text).toBe(text.accountsChosen(true));
    expect(String(done[1]?.payload.text)).toContain(text.accountsCreated);
    expect(String(done[1]?.payload.text)).toContain(text.help);
    expect(buttons(done[1]).map((button) => button.text)).toEqual(["Открыть mon22r"]);

    const saved = await chat.say("кофе 350");
    expect(saved[0]?.payload.text).toBe("<b>−350\u00A0RSD</b> · кофе\nПоштанска · без категории");
    expect(buttons(saved[0]).map((button) => button.text)).toEqual(["Отменить"]);
  });

  it("takes the home currency from a setup button, and ignores that button once setup has moved on", async () => {
    const db = memoryDatabase();
    const chat = harness(db);
    const start = await chat.say("/start");
    const picked = await chat.press(dataOf(start[0], "EUR"));
    expect(picked[0]).toMatchObject({ method: "editMessageText", payload: { text: text.currencyChosen("EUR") } });
    expect(picked[1]?.payload.text).toBe(text.askTimeZone);
    const again = await chat.press(dataOf(start[0], "RSD"));
    expect(again.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
    expect(getUserByTelegramId(db, OWNER)?.homeCurrency).toBe("EUR");
  });

  it("escapes what the owner typed, so a note cannot break or forge the formatting", async () => {
    const db = memoryDatabase();
    readyOwner(db);
    const chat = harness(db);
    const saved = await chat.say("<b>чай</b> & co 100");
    expect(saved[0]?.payload.text).toBe(
      "<b>−100\u00A0RSD</b> · &lt;b&gt;чай&lt;/b&gt; &amp; co\nПоштанска · без категории",
    );
    expect((await chat.say("/undo"))[0]?.payload.text).toBe(
      text.undone("−100\u00A0RSD · &lt;b&gt;чай&lt;/b&gt; &amp; co · Поштанска"),
    );
    expect((await chat.say("перевод 100 на <сбер>"))[0]?.payload.text).toBe(text.noDestination("<сбер>"));
    expect(text.noDestination("<сбер>")).toContain("&lt;сбер&gt;");
  });

  it("lets the confirmation set a category, move the entry, and undo it, redrawing the same message", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    const chat = harness(db);
    const tagged = await chat.say("обед 900 #Еда");
    expect(tagged[0]?.payload.text).toBe(`<b>−900\u00A0RSD</b> · обед\nПоштанска · Еда\n${text.newCategory("Еда")}`);
    await chat.say("такси 1200 #Транспорт");
    const cash = (await import("@mon22r/db")).createAccount(db, user.id, { name: "Наличные", currency: "RSD" });

    const tea = await chat.say("чай 100");
    // A category first while there is none, then the other account, and the way out last.
    expect(buttons(tea[0]).map((button) => button.text)).toEqual(["Еда", "Транспорт", "→ Наличные", "Отменить"]);

    const categorized = await chat.press(dataOf(tea[0], "Еда"));
    expect(categorized[0]).toMatchObject({
      method: "editMessageText",
      payload: { text: "<b>−100\u00A0RSD</b> · чай\nПоштанска · Еда" },
    });
    expect(buttons(categorized[0]).map((button) => button.text)).toEqual(["→ Наличные", "Отменить"]);
    expect(categorized.at(-1)?.method).toBe("answerCallbackQuery");

    const moved = await chat.press(dataOf(categorized[0], "→ Наличные"));
    expect(moved[0]?.payload.text).toBe("<b>−100\u00A0RSD</b> · чай\nНаличные · Еда");
    expect(moved.at(-1)?.payload.text).toBe(toast.movedTo("Наличные"));
    expect(listTransactions(db, user.id).find((row) => row.description === "чай")?.accountId).toBe(cash.id);

    const undo = dataOf(moved[0], "Отменить");
    const undone = await chat.press(undo);
    expect(undone[0]?.payload.text).toBe(text.undone("−100\u00A0RSD · чай · Наличные · Еда"));
    expect(buttons(undone[0])).toEqual([]);
    expect((await chat.press(undo))[0]?.payload.text).toBe(text.alreadyUndone);
    // A category button on a removed entry answers with a toast instead of failing.
    expect((await chat.press(dataOf(tea[0], "Транспорт"))).at(-1)?.payload.text).toBe(toast.alreadyUndone);
    expect(listTransactions(db, user.id)).toHaveLength(2);
  });

  it("refuses strangers and stays silent in groups", async () => {
    const db = memoryDatabase();
    readyOwner(db);
    const chat = harness(db);
    expect((await chat.say("кофе 350", 7))[0]?.payload.text).toBe(text.denied);
    expect((await chat.press("u", 7))[0]).toMatchObject({
      method: "answerCallbackQuery",
      payload: { text: toast.denied },
    });
    expect(await chat.say("кофе 350", OWNER, "group")).toEqual([]);
    expect(await chat.say("кофе 350", 7, "group")).toEqual([]);
    expect(listTransactions(db, "user-a")).toEqual([]);
    expect(chat.lines.filter((line) => line.message === "bot access denied")).toHaveLength(3);
  });

  it("does not record a redelivered message twice", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    const chat = harness(db);
    const update = textUpdate(900, OWNER, "кофе 350");
    expect((await chat.deliver(update))[0]?.payload.text).toBe(
      "<b>−350\u00A0RSD</b> · кофе\nПоштанска · без категории",
    );
    expect((await chat.deliver(update))[0]?.payload.text).toBe(text.replayed);
    expect(listTransactions(db, user.id)).toHaveLength(1);
  });

  it("undoes once per /undo message, even when Telegram delivers the message again", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    const chat = harness(db);
    await chat.say("хлеб 120");
    await chat.say("молоко 150");
    const undo = textUpdate(950, OWNER, "/undo");
    expect((await chat.deliver(undo))[0]?.payload.text).toBe(text.undone("−150\u00A0RSD · молоко · Поштанска"));
    // The same update again must not go on to remove the entry before it.
    expect((await chat.deliver(undo))[0]?.payload.text).toBe(text.replayed);
    expect(listTransactions(db, user.id).map((row) => row.description)).toEqual(["хлеб"]);
    // A new /undo is a new request.
    expect((await chat.say("/undo"))[0]?.payload.text).toBe(text.undone("−120\u00A0RSD · хлеб · Поштанска"));
  });

  it("never says nothing was recorded when only the confirmation failed", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    // Telegram refuses any message that carries buttons; plain text still goes through.
    const chat = harness(db, {
      reject: (method, payload) => method === "sendMessage" && payload.reply_markup !== undefined,
    });
    const answers = await chat.say("кофе 350");
    expect(answers.map((call) => call.payload.text)).toEqual([
      "<b>−350\u00A0RSD</b> · кофе\nПоштанска · без категории",
      text.doneUnconfirmed,
    ]);
    expect(answers.map((call) => call.payload.text)).not.toContain(text.failed);
    expect(listTransactions(db, user.id)).toHaveLength(1);
    expect(
      chat.lines.some((line) => line.level === "error" && line.message === "confirmation failed after a write"),
    ).toBe(true);
  });

  it("tells a failure from an unreadable line, and logs it without the message text", async () => {
    const db = memoryDatabase();
    readyOwner(db);
    let broken = false;
    const chat = harness(db, {
      clock: () => {
        if (broken) throw new Error("clock is broken");
        return now;
      },
    });
    expect((await chat.say("что-то без суммы"))[0]?.payload.text).toBe(text.unparsed);
    broken = true;
    expect((await chat.say("секретный обед 900"))[0]?.payload.text).toBe(text.failed);
    const failure = chat.lines.find((line) => line.message === "text failed");
    expect(failure?.level).toBe("error");
    expect(JSON.stringify(chat.lines)).not.toContain("секретный");
    expect(listTransactions(db, "user-a")).toEqual([]);
  });

  it("summarizes the month and says what an undo removed", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    const chat = harness(db);
    expect((await chat.say("/undo"))[0]?.payload.text).toBe(text.nothingToUndo);
    await chat.say("обед 900 #Еда");
    await chat.say("+зп 180000");
    await chat.say("кофе 4.50 gbp");
    const summary = String((await chat.say("/month"))[0]?.payload.text);
    expect(summary).toBe(
      [
        "<b>Ноябрь 2026</b>",
        "<b>RSD</b> · расходы 900 · доходы 180\u00A0000\nЕда 900",
        "<b>GBP</b> · расходы 4,50\nбез категории 4,50",
      ].join("\n\n"),
    );
    expect((await chat.say("/undo"))[0]?.payload.text).toBe(text.undone("−4,50\u00A0GBP · кофе · UK"));

    // Imported lines are not what /undo is for.
    const card = listAccounts(db, user.id)[0];
    if (card === undefined) throw new Error("starter account missing");
    recordTransaction(db, user.id, {
      accountId: card.id,
      kind: "expense",
      amountMinor: 100,
      currency: "RSD",
      occurredAt: now.toISOString(),
      createdAt: new Date(now.getTime() + 60_000).toISOString(),
      importIdentity: { source: "bank", externalKey: "line-1" },
    });
    expect((await chat.say("/undo"))[0]?.payload.text).toBe(text.undone("+180\u00A0000\u00A0RSD · зп · Поштанска"));
    expect(
      listTransactions(db, user.id)
        .map((row) => row.description)
        .sort(),
    ).toEqual(["", "обед"]);
  });

  it("explains transfers it cannot complete instead of guessing", async () => {
    const db = memoryDatabase();
    readyOwner(db);
    const chat = harness(db);
    expect((await chat.say("перевод 100 gbp на поштанска"))[0]?.payload.text).toBe(
      text.arrivalRequired("UK", "Поштанска", "RSD"),
    );
    expect((await chat.say("перевод 100 gbp на поштанска 14000"))[0]?.payload.text).toBe(
      "<b>100\u00A0GBP → 14\u00A0000\u00A0RSD</b> · перевод\nUK → Поштанска",
    );
    expect((await chat.say("перевод 100 на сбер"))[0]?.payload.text).toBe(text.noDestination("сбер"));
  });

  it("imports a statement: asks for the columns once, previews, and writes only new lines", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    const csv = ["Date;Details;Sum;Ref", "01.11.2026;MAXI 123;-1250,00;r1", "02.11.2026;Salary;180000,00;r2"].join(
      "\n",
    );
    const chat = harness(db, { files: { "statement.csv": csv } });
    const document = (updateId: number) => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: OWNER, type: "private", first_name: "A" },
        from: { id: OWNER, is_bot: false, first_name: "A" },
        document: {
          file_id: "f",
          file_unique_id: "u",
          file_name: "statement.csv",
          mime_type: "text/csv",
          file_size: csv.length,
        },
      },
    });
    const unknown = await chat.deliver(document(100));
    expect(unknown.at(-1)?.payload.text).toBe(text.mappingNeeded(["Date", "Details", "Sum", "Ref"]));
    expect(
      (
        await chat.say("профиль bank | date=Date | amount=Sum | description=Details | currency=RSD | externalKey=Ref")
      )[0]?.payload.text,
    ).toBe(text.profileSaved);
    const preview = await chat.deliver(document(101));
    expect(preview.at(-1)?.payload.text).toBe(text.importPreview({ new: 2, duplicate: 0, skipped: 0 }, "Поштанска"));
    expect(buttons(preview.at(-1)).map((button) => button.text)).toEqual(["Записать", "Не записывать"]);
    const committed = await chat.press(dataOf(preview.at(-1), "Записать"));
    expect(committed[0]).toMatchObject({
      method: "editMessageText",
      payload: { text: text.importDone(2, "Поштанска") },
    });
    expect(buttons(committed[0]).map((button) => button.text)).toEqual(["Открыть mon22r"]);
    expect(
      listTransactions(db, user.id)
        .map((row) => `${row.kind} ${row.amountMinor}`)
        .sort(),
    ).toEqual(["expense 125000", "income 18000000"]);
    const again = await chat.deliver(document(102));
    expect(again.at(-1)?.payload.text).toBe(
      `${text.importPreview({ new: 0, duplicate: 2, skipped: 0 }, "Поштанска")}\n${text.nothingNew}`,
    );
    expect(buttons(again.at(-1))).toEqual([]);
    // Pressing the old button again writes nothing.
    await chat.press(dataOf(preview.at(-1), "Записать"));
    expect(listTransactions(db, user.id)).toHaveLength(2);
  });

  it("drops a statement preview when asked, and says so if it is pressed again", async () => {
    const db = memoryDatabase();
    const user = readyOwner(db);
    const csv = ["Date;Details;Sum;Ref", "01.11.2026;MAXI 123;-1250,00;r1"].join("\n");
    const chat = harness(db, { files: { "statement.csv": csv } });
    const document = (updateId: number) => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: OWNER, type: "private", first_name: "A" },
        from: { id: OWNER, is_bot: false, first_name: "A" },
        document: { file_id: "f", file_unique_id: "u", file_name: "statement.csv", mime_type: "text/csv" },
      },
    });
    await chat.deliver(document(100));
    await chat.say("профиль bank | date=Date | amount=Sum | description=Details | currency=RSD | externalKey=Ref");
    const preview = await chat.deliver(document(101));
    const cancelled = await chat.press(dataOf(preview.at(-1), "Не записывать"));
    expect(cancelled[0]).toMatchObject({ method: "editMessageText", payload: { text: text.importCancelled } });
    expect(buttons(cancelled[0])).toEqual([]);
    expect((await chat.press(dataOf(preview.at(-1), "Не записывать"))).at(-1)?.payload.text).toBe(toast.importGone);
    await chat.press(dataOf(preview.at(-1), "Записать"));
    expect(listTransactions(db, user.id)).toEqual([]);
  });

  it("answers edits and unsupported messages instead of ignoring them", async () => {
    const db = memoryDatabase();
    readyOwner(db);
    const chat = harness(db);
    const edited = textUpdate(1, OWNER, "кофе 450");
    expect((await chat.deliver({ update_id: 300, edited_message: edited.message }))[0]?.payload.text).toBe(
      text.editIgnored,
    );
    const photo = {
      update_id: 301,
      message: {
        ...edited.message,
        text: undefined,
        photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
      },
    };
    expect((await chat.deliver(photo))[0]?.payload.text).toBe(text.unsupported);
  });

  it("continues setup after a restart from the saved step", async () => {
    const db = memoryDatabase();
    const user = createUser(db, { id: "user-a", telegramId: OWNER, homeCurrency: "RSD" });
    updateStoredUser(db, user.id, { onboardingStep: "accounts" });
    const chat = harness(db);
    expect((await chat.say("кофе 350"))[0]?.payload.text).toBe(text.needYesOrNo);
    expect(String((await chat.say("нет"))[0]?.payload.text)).toContain(text.accountsSkipped);
    expect(listAccounts(db, user.id)).toEqual([]);
    expect(listCategories(db, user.id)).toEqual([]);
  });
});
