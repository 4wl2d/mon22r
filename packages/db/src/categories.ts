import { assertUserId, createCategory as buildCategory, type Category, LedgerError, noteKey } from "@mon22r/domain";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { Mon22rDb } from "./client.js";
import { accounts, categories, importExternalKeys, transactions } from "./schema.js";

const USE_WINDOW_MS = 90 * 86_400_000;

/** Categories ordered by how often they were used in the last 90 days, then by name. */
export function listCategoriesByUse(db: Mon22rDb, userId: string, now: Date = new Date()): readonly Category[] {
  const owner = assertUserId(userId);
  const since = new Date(now.getTime() - USE_WINDOW_MS).toISOString();
  const uses = new Map<string, number>();
  const counted = db.orm
    .select({ categoryId: transactions.categoryId, uses: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.userId, owner), isNotNull(transactions.categoryId), gte(transactions.createdAt, since)))
    .groupBy(transactions.categoryId)
    .all();
  for (const row of counted) {
    if (row.categoryId !== null) uses.set(row.categoryId, row.uses);
  }
  return db.orm
    .select()
    .from(categories)
    .where(eq(categories.userId, owner))
    .all()
    .map(toCategory)
    .sort((left, right) => {
      const byUse = (uses.get(right.id) ?? 0) - (uses.get(left.id) ?? 0);
      return byUse !== 0 ? byUse : left.name.localeCompare(right.name, "ru");
    });
}

/** Category whose name matches after trimming, lower-casing, and collapsing spaces. */
export function findCategoryByName(db: Mon22rDb, userId: string, name: string): Category | null {
  const owner = assertUserId(userId);
  const wanted = noteKey(name);
  if (wanted.length === 0) return null;
  const rows = db.orm.select().from(categories).where(eq(categories.userId, owner)).all();
  const row = rows.find((item) => noteKey(item.name) === wanted);
  return row === undefined ? null : toCategory(row);
}

export function renameCategory(db: Mon22rDb, userId: string, id: string, name: string): Category {
  const owner = assertUserId(userId);
  const existing = db.orm
    .select()
    .from(categories)
    .where(and(eq(categories.userId, owner), eq(categories.id, id)))
    .get();
  if (existing === undefined) throw new LedgerError("category_not_found", "Category was not found for this user");
  const next = buildCategory({ id: existing.id, userId: owner, name, createdAt: existing.createdAt });
  const clash = findCategoryByName(db, owner, next.name);
  if (clash !== null && clash.id !== existing.id) throw new LedgerError("conflict", "Category name already exists");
  db.orm
    .update(categories)
    .set({ name: next.name })
    .where(and(eq(categories.userId, owner), eq(categories.id, existing.id)))
    .run();
  return next;
}

/** Deletes a category. Its transactions stay and become uncategorized. */
export function deleteCategory(db: Mon22rDb, userId: string, id: string): { readonly cleared: number } {
  const owner = assertUserId(userId);
  const apply = db.sqlite.transaction(() => {
    const cleared = db.orm
      .update(transactions)
      .set({ categoryId: null })
      .where(and(eq(transactions.userId, owner), eq(transactions.categoryId, id)))
      .run().changes;
    const removed = db.orm
      .delete(categories)
      .where(and(eq(categories.userId, owner), eq(categories.id, id)))
      .run().changes;
    if (removed === 0) throw new LedgerError("category_not_found", "Category was not found for this user");
    return { cleared };
  });
  return apply();
}

/**
 * Category last chosen for the same note. One indexed lookup on (user, note key, created).
 * Returns null when the note was never categorized.
 */
export function rememberedCategoryId(db: Mon22rDb, userId: string, note: string): string | null {
  const owner = assertUserId(userId);
  const key = noteKey(note);
  if (key.length === 0) return null;
  const row = db.orm
    .select({ categoryId: transactions.categoryId })
    .from(transactions)
    .where(and(eq(transactions.userId, owner), eq(transactions.noteKey, key), isNotNull(transactions.categoryId)))
    .orderBy(desc(transactions.createdAt), desc(sql`${transactions}.rowid`))
    .limit(1)
    .get();
  return row?.categoryId ?? null;
}

/**
 * Sets or clears the category on many transactions at once. Transfer legs are left alone.
 * Returns the number of rows changed.
 */
export function categorizeTransactions(
  db: Mon22rDb,
  userId: string,
  ids: readonly string[],
  categoryId: string | null,
): number {
  const owner = assertUserId(userId);
  if (ids.length === 0) return 0;
  const apply = db.sqlite.transaction(() => {
    if (categoryId !== null) {
      const category = db.orm
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.userId, owner), eq(categories.id, categoryId)))
        .get();
      if (category === undefined) throw new LedgerError("category_not_found", "Category was not found for this user");
    }
    let changed = 0;
    // SQLite caps bound parameters per statement, so long selections go in slices.
    for (let start = 0; start < ids.length; start += 200) {
      changed += db.orm
        .update(transactions)
        .set({ categoryId })
        .where(
          and(
            eq(transactions.userId, owner),
            inArray(transactions.id, ids.slice(start, start + 200)),
            ne(transactions.kind, "transfer"),
          ),
        )
        .run().changes;
    }
    return changed;
  });
  return apply();
}

/**
 * Active account of this currency that took the latest hand-entered, non-transfer transaction.
 * Imported lines do not count: an import says nothing about where the next chat entry belongs.
 */
export function lastManualAccountId(db: Mon22rDb, userId: string, currency: string): string | null {
  const owner = assertUserId(userId);
  const row = db.orm
    .select({ accountId: transactions.accountId })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(importExternalKeys, eq(importExternalKeys.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.userId, owner),
        eq(transactions.currency, currency),
        ne(transactions.kind, "transfer"),
        eq(accounts.archived, 0),
        isNull(importExternalKeys.id),
      ),
    )
    .orderBy(desc(transactions.createdAt), desc(sql`${transactions}.rowid`))
    .limit(1)
    .get();
  return row?.accountId ?? null;
}

function toCategory(row: typeof categories.$inferSelect): Category {
  return buildCategory({ id: row.id, userId: row.userId, name: row.name, createdAt: row.createdAt });
}
