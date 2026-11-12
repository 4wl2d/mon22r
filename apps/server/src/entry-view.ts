import { listAccounts, listCategories, listCategoriesByUse, type Mon22rDb } from "@mon22r/db";
import type { Transaction } from "@mon22r/domain";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";

import { callbackData } from "./callbacks.js";
import { offerFor } from "./capture.js";
import { buttons, closePlanLabel } from "./copy.js";
import { entryHtml } from "./format.js";

const CATEGORY_BUTTONS = 9;
const ACCOUNT_BUTTONS = 3;
const PER_ROW = 3;

export type EntryView = { readonly text: string; readonly keyboard: InlineKeyboard };

/**
 * Confirmation for a saved income, expense, or refund, built from what the ledger holds now.
 * The same function redraws the message after a button changes the category or the account.
 *
 * Buttons read top to bottom in the order they are needed: a category while there is none, then the other
 * accounts of the same currency, then an expected income this one could count toward, and the way out last.
 */
export function viewEntry(db: Mon22rDb, userId: string, transaction: Transaction): EntryView {
  const accounts = listAccounts(db, userId);
  const account = accounts.find((item) => item.id === transaction.accountId);
  const category =
    transaction.categoryId === null
      ? null
      : (listCategories(db, userId).find((item) => item.id === transaction.categoryId) ?? null);
  const rows: InlineKeyboardButton[][] = [];

  if (transaction.categoryId === null && transaction.kind !== "income") {
    const choices: InlineKeyboardButton[] = [];
    for (const choice of listCategoriesByUse(db, userId).slice(0, CATEGORY_BUTTONS)) {
      const data = callbackData("c", [transaction.id, choice.id]);
      if (data !== null) choices.push(InlineKeyboard.text(clip(choice.name, 18), data));
    }
    for (let index = 0; index < choices.length; index += PER_ROW) rows.push(choices.slice(index, index + PER_ROW));
  }

  const others = accounts
    .filter((item) => !item.archived && item.currency === transaction.currency && item.id !== transaction.accountId)
    .slice(0, ACCOUNT_BUTTONS);
  for (const other of others) {
    const data = callbackData("a", [transaction.id, other.id]);
    if (data !== null) rows.push([InlineKeyboard.text(clip(`→ ${other.name}`, 32), data)]);
  }

  const offer = offerFor(db, userId, transaction);
  if (offer !== null) {
    const data = callbackData("m", [transaction.id, offer.expectationId]);
    if (data !== null) rows.push([InlineKeyboard.text(clip(closePlanLabel(offer.name), 32), data)]);
  }

  const undo = callbackData("u", [transaction.id]);
  if (undo !== null) rows.push([InlineKeyboard.text(buttons.undo, undo)]);

  return {
    text: entryHtml(transaction, account?.name ?? "счёт", category?.name ?? null),
    keyboard: InlineKeyboard.from(rows),
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
