import { createAccount, listAccounts, type Mon22rDb } from "@mon22r/db";
import type { Account } from "@mon22r/domain";

import { STARTER_ACCOUNTS } from "./onboarding.js";
import { normalizeNote } from "./phrases.js";

export function createStarterAccounts(db: Mon22rDb, userId: string): Account[] {
  const existing = listAccounts(db, userId);
  const names = new Set(existing.map((account) => normalizeNote(account.name)));
  const created: Account[] = [];
  const started = Date.now();
  STARTER_ACCOUNTS.forEach((starter, index) => {
    if (names.has(normalizeNote(starter.name))) return;
    created.push(
      createAccount(db, userId, {
        name: starter.name,
        currency: starter.currency,
        createdAt: new Date(started + index).toISOString(),
      }),
    );
    names.add(normalizeNote(starter.name));
  });
  return created;
}
