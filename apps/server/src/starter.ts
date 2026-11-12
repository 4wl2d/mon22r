import { createAccount, listAccounts, type Mon22rDb } from "@mon22r/db";
import { type Account, noteKey } from "@mon22r/domain";

import { STARTER_ACCOUNTS } from "./onboarding.js";

export function createStarterAccounts(db: Mon22rDb, userId: string): Account[] {
  const existing = listAccounts(db, userId);
  const names = new Set(existing.map((account) => noteKey(account.name)));
  const created: Account[] = [];
  const started = Date.now();
  STARTER_ACCOUNTS.forEach((starter, index) => {
    if (names.has(noteKey(starter.name))) return;
    created.push(
      createAccount(db, userId, {
        name: starter.name,
        currency: starter.currency,
        createdAt: new Date(started + index).toISOString(),
      }),
    );
    names.add(noteKey(starter.name));
  });
  return created;
}
