import {
  createAccount,
  createUser,
  fillNoteKeys,
  initialSchemaSql,
  MIGRATION_002,
  MIGRATION_ID,
  MIGRATIONS,
  type Mon22rDb,
  migrate,
  migration002Sql,
  openDatabase,
  recordTransaction,
  rememberedCategoryId,
  SchemaTooNewError,
} from "@mon22r/db";
import { afterEach, describe, expect, it } from "vitest";

const open: Mon22rDb[] = [];

function blank(): Mon22rDb {
  const db = openDatabase(":memory:");
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

/** The schema the first release ran on, with rows written the way that release wrote them. */
function releaseOneDatabase(): Mon22rDb {
  const db = blank();
  migrate(db, [
    { id: MIGRATION_ID, sql: initialSchemaSql },
    { id: MIGRATION_002, sql: migration002Sql },
  ]);
  db.sqlite.exec(`
    INSERT INTO users (id, telegram_id, home_currency, time_zone, created_at)
      VALUES ('user-a', 1, 'EUR', 'Europe/Belgrade', '2026-11-12T01:29:58.593Z');
    INSERT INTO accounts (id, user_id, name, currency, archived, created_at)
      VALUES ('card', 'user-a', 'Поштанска', 'RSD', 0, '2026-11-12T01:29:58.593Z');
    INSERT INTO categories (id, user_id, name, created_at)
      VALUES ('food', 'user-a', 'еда', '2026-11-12T01:30:00.000Z');
    INSERT INTO transactions
      (id, user_id, account_id, category_id, amount_minor, currency, direction, kind, occurred_at, description, created_at)
      VALUES ('t1', 'user-a', 'card', 'food', 35000, 'RSD', 'outflow', 'expense',
              '2026-11-10T10:00:00.000Z', '  Кофе   С Собой ', '2026-11-12T01:53:53.351Z');
  `);
  return db;
}

describe("migrations", () => {
  it("upgrades a release-one database in place and keeps every row", () => {
    const db = releaseOneDatabase();
    const result = migrate(db);
    expect(result.applied).toEqual(["003_capture_keys_state"]);
    expect(result.schemaVersion).toBe(MIGRATIONS.length);
    expect(result.compatFloor).toBe(1);

    const row = db.sqlite.prepare("SELECT amount_minor, description, note_key FROM transactions WHERE id = 't1'").get();
    expect(row).toEqual({ amount_minor: 35_000, description: "  Кофе   С Собой ", note_key: "кофе с собой" });
    // The Cyrillic note is found again, which SQLite's own lower() could not do.
    expect(rememberedCategoryId(db, "user-a", "кофе с собой")).toBe("food");
    expect(migrate(db).applied).toEqual([]);
  });

  it("stays usable by the previous release: its inserts still work and are repaired at the next start", () => {
    const db = releaseOneDatabase();
    migrate(db);
    // Release one does not know note_key or default_account_id.
    db.sqlite.exec(`
      INSERT INTO transactions
        (id, user_id, account_id, category_id, amount_minor, currency, direction, kind, occurred_at, description, created_at)
        VALUES ('t2', 'user-a', 'card', 'food', 1000, 'RSD', 'outflow', 'expense',
                '2026-11-11T10:00:00.000Z', 'Такси', '2026-11-12T02:00:00.000Z');
    `);
    expect(rememberedCategoryId(db, "user-a", "такси")).toBeNull();
    expect(fillNoteKeys(db)).toBe(1);
    expect(rememberedCategoryId(db, "user-a", "такси")).toBe("food");
  });

  it("refuses a database whose schema this build is too old for, and leaves it untouched", () => {
    const db = blank();
    migrate(db, [
      ...MIGRATIONS,
      { id: "999_breaking", sql: "CREATE TABLE later (id TEXT)", breaksOlderReleases: true },
    ]);
    const before = db.sqlite.prepare("SELECT count(*) AS n FROM schema_migrations").get();
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual(before);
  });

  it("tolerates a newer additive migration, so the previous image can be started again after a rollback", () => {
    const db = blank();
    migrate(db, [...MIGRATIONS, { id: "999_additive", sql: "CREATE TABLE later (id TEXT)" }]);
    expect(migrate(db)).toMatchObject({ applied: [], compatFloor: 1 });
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD" });
    const card = createAccount(db, user.id, { name: "Поштанска", currency: "RSD" });
    const saved = recordTransaction(db, user.id, {
      accountId: card.id,
      kind: "expense",
      amountMinor: 100,
      currency: "RSD",
      occurredAt: "2026-11-12T10:00:00.000Z",
    });
    expect(saved.status).toBe("created");
  });

  it("rolls a failing migration back completely", () => {
    const db = blank();
    expect(() =>
      migrate(db, [...MIGRATIONS, { id: "999_broken", sql: "CREATE TABLE ok (id TEXT); SELECT nope();" }]),
    ).toThrow();
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ok', 'users')")
      .all();
    expect(tables).toEqual([]);
  });
});
