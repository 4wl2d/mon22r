import { listAccounts, listCategories, listCategoriesByUse, type Mon22rDb } from "@mon22r/db";
import type { Transaction } from "@mon22r/domain";
import { InlineKeyboard } from "grammy";

import { callbackData } from "./callbacks.js";
import { offerFor } from "./capture.js";
import { buttons, text } from "./copy.js";
import { formatEntry } from "./format.js";

const CATEGORY_BUTTONS = 9;
const ACCOUNT_BUTTONS = 3;
const PER_ROW = 3;

export type EntryView = { readonly text: string; readonly keyboard: InlineKeyboard };

/**
 * Confirmation for a saved income, expense, or refund, built from what the ledger holds now.
 * The same function redraws the message after a button changes the category or the account.
 */
export function viewEntry(db: Mon22rDb, userId: string, transaction: Transaction): EntryView {
  const accounts = listAccounts(db, userId);
  const account = accounts.find((item) => item.id === transaction.accountId);
  const category =
    transaction.categoryId === null
      ? null
      : (listCategories(db, userId).find((item) => item.id === transaction.categoryId) ?? null);
  const keyboard = new InlineKeyboard();
  const undo = callbackData("u", [transaction.id]);
  if (undo !== null) keyboard.text(buttons.undo, undo);

  if (transaction.categoryId === null && transaction.kind !== "income") {
    const choices = listCategoriesByUse(db, userId).slice(0, CATEGORY_BUTTONS);
    choices.forEach((choice, index) => {
      const data = callbackData("c", [transaction.id, choice.id]);
      if (data === null) return;
      if (index % PER_ROW === 0) keyboard.row();
      keyboard.text(clip(choice.name, 18), data);
    });
  }

  const others = accounts
    .filter((item) => !item.archived && item.currency === transaction.currency && item.id !== transaction.accountId)
    .slice(0, ACCOUNT_BUTTONS);
  for (const other of others) {
    const data = callbackData("a", [transaction.id, other.id]);
    if (data !== null) keyboard.row().text(clip(`→ ${other.name}`, 32), data);
  }

  const offer = offerFor(db, userId, transaction);
  if (offer !== null) {
    const data = callbackData("m", [transaction.id, offer.expectationId]);
    if (data !== null) keyboard.row().text(clip(text.closePlan(offer.name), 32), data);
  }

  return {
    text: formatEntry(transaction, account?.name ?? "счёт", category?.name ?? null),
    keyboard,
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
