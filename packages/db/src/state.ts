import { eq, lt } from "drizzle-orm";

import type { Mon22rDb } from "./client.js";
import { appState, handledUpdates } from "./schema.js";

/**
 * `app_state` key that is "0" for the whole time the service runs and "1" after a clean stop.
 * Finding "0" at start means the previous run ended without one.
 */
export const CLEAN_STOP_KEY = "runtime.clean_stop";

/**
 * Marks a Telegram update as applied. Returns false when it already was.
 * Call it inside the same SQLite transaction as the ledger change, so a redelivered update
 * (a restart between the write and Telegram's acknowledgement) cannot write twice.
 */
export function claimUpdate(db: Mon22rDb, updateId: number, now: Date = new Date()): boolean {
  if (!Number.isSafeInteger(updateId)) throw new Error("updateId must be an integer");
  const result = db.orm
    .insert(handledUpdates)
    .values({ updateId, handledAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return result.changes === 1;
}

export function isUpdateHandled(db: Mon22rDb, updateId: number): boolean {
  const row = db.orm
    .select({ updateId: handledUpdates.updateId })
    .from(handledUpdates)
    .where(eq(handledUpdates.updateId, updateId))
    .get();
  return row !== undefined;
}

/** Telegram redelivers for at most 24 hours, so older ids only take space. */
export function pruneHandledUpdates(db: Mon22rDb, olderThan: Date): number {
  return db.orm.delete(handledUpdates).where(lt(handledUpdates.handledAt, olderThan.toISOString())).run().changes;
}

export function readState(db: Mon22rDb, key: string): string | null {
  const row = db.orm.select({ value: appState.value }).from(appState).where(eq(appState.key, key)).get();
  return row?.value ?? null;
}

export function writeState(db: Mon22rDb, key: string, value: string, now: Date = new Date()): void {
  const updatedAt = now.toISOString();
  db.orm
    .insert(appState)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt } })
    .run();
}
