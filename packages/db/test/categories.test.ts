import {
  categorizeTransactions,
  claimUpdate,
  createAccount,
  createCategory,
  createUser,
  deleteCategory,
  findCategoryByName,
  isUpdateHandled,
  lastManualAccountId,
  listCategoriesByUse,
  listTransactions,
  type Mon22rDb,
  migrate,
  openDatabase,
  pruneHandledUpdates,
  readState,
  recordTransaction,
  recordTransfer,
  rememberedCategoryId,
  renameCategory,
  writeState,
} from "@mon22r/db";
import { LedgerError } from "@mon22r/domain";
import { afterEach, describe, expect, it } from "vitest";

const open: Mon22rDb[] = [];
const now = new Date("2026-11-12T10:00:00.000Z");

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  const user = createUser(db, { id: "user-a", homeCurrency: "RSD" });
  const other = createUser(db, { id: "user-b", homeCurrency: "RSD" });
  const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
  const cash = createAccount(db, user.id, { id: "cash", name: "Наличные", currency: "RSD" });
  const food = createCategory(db, user.id, { id: "food", name: "Еда" });
  const cafe = createCategory(db, user.id, { id: "cafe", name: "Кафе" });
  return { db, user, other, card, cash, food, cafe };
}

function expense(
  db: Mon22rDb,
  userId: string,
  id: string,
  accountId: string,
  description: string,
  createdAt: string,
  categoryId?: string,
) {
  return recordTransaction(db, userId, {
    id,
    accountId,
    kind: "expense",
    amountMinor: 1000,
    currency: "RSD",
    categoryId: categoryId ?? null,
    occurredAt: createdAt,
    createdAt,
    description,
  }).transaction;
}

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

describe("categories", () => {
  it("remembers the latest category for a note, ignoring case, spacing, and uncategorized rows", () => {
    const { db, user, card, food, cafe } = seeded();
    expense(db, user.id, "old", card.id, "Кофе", "2026-11-01T00:00:00.000Z", food.id);
    expense(db, user.id, "blank", card.id, "кофе", "2026-11-02T00:00:00.000Z");
    expense(db, user.id, "new", card.id, " кофе ", "2026-11-03T00:00:00.000Z", cafe.id);
    expect(rememberedCategoryId(db, user.id, "КОФЕ")).toBe(cafe.id);
    expect(rememberedCategoryId(db, user.id, "такси")).toBeNull();
    expect(rememberedCategoryId(db, "user-b", "кофе")).toBeNull();
  });

  it("categorizes many rows at once, skips transfers, and never touches another user's rows", () => {
    const { db, user, other, card, cash, food } = seeded();
    expense(db, user.id, "a", card.id, "maxi 1", "2026-11-01T00:00:00.000Z");
    expense(db, user.id, "b", card.id, "maxi 2", "2026-11-02T00:00:00.000Z");
    const [outflow] = recordTransfer(db, user.id, {
      fromAccountId: card.id,
      toAccountId: cash.id,
      from: { minor: 100, currency: "RSD" },
      to: { minor: 100, currency: "RSD" },
      occurredAt: "2026-11-03T00:00:00.000Z",
    });
    const otherCard = createAccount(db, other.id, { id: "other-card", name: "Other", currency: "RSD" });
    expense(db, other.id, "theirs", otherCard.id, "maxi", "2026-11-01T00:00:00.000Z");

    expect(categorizeTransactions(db, user.id, ["a", "b", outflow.id, "theirs", "missing"], food.id)).toBe(2);
    const mine = listTransactions(db, user.id);
    expect(
      mine
        .filter((row) => row.categoryId === food.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(listTransactions(db, other.id)[0]?.categoryId).toBeNull();
    expect(() => categorizeTransactions(db, other.id, ["theirs"], food.id)).toThrow(LedgerError);
    expect(categorizeTransactions(db, user.id, ["a"], null)).toBe(1);
  });

  it("renames without creating a duplicate and deletes without losing transactions", () => {
    const { db, user, card, food, cafe } = seeded();
    expense(db, user.id, "a", card.id, "хлеб", "2026-11-01T00:00:00.000Z", food.id);
    expect(findCategoryByName(db, user.id, "  еда ")?.id).toBe(food.id);
    expect(() => renameCategory(db, user.id, cafe.id, "ЕДА")).toThrow(LedgerError);
    expect(renameCategory(db, user.id, cafe.id, "Кофейни").name).toBe("Кофейни");
    expect(deleteCategory(db, user.id, food.id)).toEqual({ cleared: 1 });
    expect(listTransactions(db, user.id).map((row) => [row.id, row.categoryId])).toEqual([["a", null]]);
    expect(() => deleteCategory(db, user.id, food.id)).toThrow(LedgerError);
  });

  it("lists the categories used most in the last 90 days first", () => {
    const { db, user, card, food, cafe } = seeded();
    expense(db, user.id, "c1", card.id, "латте", "2026-11-01T00:00:00.000Z", cafe.id);
    expense(db, user.id, "c2", card.id, "раф", "2026-11-02T00:00:00.000Z", cafe.id);
    expense(db, user.id, "f-old", card.id, "хлеб", "2026-01-01T00:00:00.000Z", food.id);
    expect(listCategoriesByUse(db, user.id, now).map((category) => category.name)).toEqual(["Кафе", "Еда"]);
  });

  it("finds the account of the last hand-entered line, not of an import or an archived account", () => {
    const { db, user, card, cash } = seeded();
    expect(lastManualAccountId(db, user.id, "RSD")).toBeNull();
    expense(db, user.id, "typed", cash.id, "рынок", "2026-11-01T00:00:00.000Z");
    recordTransaction(db, user.id, {
      accountId: card.id,
      kind: "expense",
      amountMinor: 500,
      currency: "RSD",
      occurredAt: "2026-11-05T00:00:00.000Z",
      createdAt: "2026-11-05T00:00:00.000Z",
      importIdentity: { source: "bank", externalKey: "line-1" },
    });
    expect(lastManualAccountId(db, user.id, "RSD")).toBe(cash.id);
    expect(lastManualAccountId(db, user.id, "EUR")).toBeNull();
  });
});

describe("runtime state", () => {
  it("claims a Telegram update once and forgets old claims", () => {
    const { db } = seeded();
    expect(isUpdateHandled(db, 100)).toBe(false);
    expect(claimUpdate(db, 100, new Date("2026-11-01T00:00:00.000Z"))).toBe(true);
    expect(claimUpdate(db, 100, now)).toBe(false);
    expect(isUpdateHandled(db, 100)).toBe(true);
    expect(pruneHandledUpdates(db, new Date("2026-11-05T00:00:00.000Z"))).toBe(1);
    expect(isUpdateHandled(db, 100)).toBe(false);
  });

  it("keeps small facts across restarts", () => {
    const { db } = seeded();
    expect(readState(db, "backup.last_ok_at")).toBeNull();
    writeState(db, "backup.last_ok_at", "a", now);
    writeState(db, "backup.last_ok_at", "b", now);
    expect(readState(db, "backup.last_ok_at")).toBe("b");
  });
});
