import { noteKey } from "@mon22r/domain";

import type { Mon22rDb } from "./client.js";

/** First schema version. Later migrations should add a new id instead of editing this SQL. */
export const MIGRATION_ID = "001_init";

/** Onboarding progress, saved CSV profiles, and import previews. The file itself is not stored. */
export const MIGRATION_002 = "002_onboarding_profiles";

export const migration002Sql = `
ALTER TABLE users ADD COLUMN onboarding_step TEXT;
ALTER TABLE users ADD COLUMN pending_csv_json TEXT;

CREATE TABLE statement_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, fingerprint),
  UNIQUE (user_id, name)
);

CREATE INDEX statement_profiles_user_idx ON statement_profiles (user_id);

CREATE TABLE import_previews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  source TEXT NOT NULL,
  account_id TEXT REFERENCES accounts (id),
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX import_previews_user_idx ON import_previews (user_id);
`;

/**
 * Initial SQLite schema.
 * Bank passwords and internet-banking sessions are never stored.
 * import_external_keys rejects a repeated (user_id, source, external_key).
 */
export const initialSchemaSql = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER,
  home_currency TEXT NOT NULL CHECK (length(home_currency) = 3 AND home_currency = upper(home_currency)),
  time_zone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX users_telegram_id_unique ON users (telegram_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX categories_user_id_idx ON categories (user_id);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  category_id TEXT REFERENCES categories (id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'refund', 'transfer')),
  transfer_group_id TEXT,
  refund_of_transaction_id TEXT REFERENCES transactions (id),
  occurred_at TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'expense' AND direction = 'outflow' AND transfer_group_id IS NULL)
    OR (kind = 'income' AND direction = 'inflow' AND transfer_group_id IS NULL)
    OR (kind = 'refund' AND direction = 'inflow' AND transfer_group_id IS NULL)
    OR (kind = 'transfer' AND transfer_group_id IS NOT NULL AND category_id IS NULL)
  )
);

CREATE INDEX transactions_user_occurred_idx ON transactions (user_id, occurred_at);
CREATE INDEX transactions_user_transfer_idx ON transactions (user_id, transfer_group_id);

CREATE TABLE income_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  account_id TEXT REFERENCES accounts (id),
  recurrence TEXT NOT NULL CHECK (recurrence IN ('monthly', 'once')),
  start_year INTEGER NOT NULL,
  start_month INTEGER NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  remind INTEGER NOT NULL DEFAULT 0 CHECK (remind IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX income_plans_user_id_idx ON income_plans (user_id);

CREATE TABLE income_expectations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  plan_id TEXT REFERENCES income_plans (id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  name TEXT NOT NULL,
  expected_minor INTEGER NOT NULL CHECK (expected_minor > 0),
  received_minor INTEGER NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  account_id TEXT REFERENCES accounts (id),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  status TEXT NOT NULL CHECK (status IN ('expected', 'received', 'partial', 'skipped')),
  matched_transaction_id TEXT REFERENCES transactions (id),
  created_at TEXT NOT NULL
);

CREATE INDEX income_expectations_user_month_idx ON income_expectations (user_id, year, month);
CREATE UNIQUE INDEX income_expectations_plan_month_unique
  ON income_expectations (user_id, plan_id, year, month)
  WHERE plan_id IS NOT NULL;

CREATE TABLE fx_rates (
  id TEXT PRIMARY KEY,
  base_currency TEXT NOT NULL CHECK (length(base_currency) = 3 AND base_currency = upper(base_currency)),
  quote_currency TEXT NOT NULL CHECK (length(quote_currency) = 3 AND quote_currency = upper(quote_currency)),
  numerator INTEGER NOT NULL CHECK (numerator > 0),
  denominator INTEGER NOT NULL CHECK (denominator > 0),
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (base_currency, quote_currency, as_of, source)
);

CREATE TABLE import_external_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  source TEXT NOT NULL,
  external_key TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions (id),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, source, external_key)
);

CREATE INDEX import_external_keys_user_idx ON import_external_keys (user_id);
`;

/**
 * Default account, an indexed note key, the undo index, handled Telegram updates, and small runtime state.
 * Everything here is additive: the previous release keeps working against this schema.
 */
export const MIGRATION_003 = "003_capture_keys_state";

export const migration003Sql = `
ALTER TABLE users ADD COLUMN default_account_id TEXT REFERENCES accounts (id);

ALTER TABLE transactions ADD COLUMN note_key TEXT NOT NULL DEFAULT '';

CREATE INDEX transactions_user_note_idx ON transactions (user_id, note_key, created_at);
CREATE INDEX transactions_user_created_idx ON transactions (user_id, created_at);

CREATE TABLE handled_updates (
  update_id INTEGER PRIMARY KEY,
  handled_at TEXT NOT NULL
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type Migration = {
  readonly id: string;
  readonly sql: string;
  /**
   * Set when a release older than this migration can no longer run against the schema.
   * Additive changes leave it unset, which keeps a rollback to the previous image possible.
   */
  readonly breaksOlderReleases?: boolean;
};

/** Append only. The position in this list is the schema version. */
export const MIGRATIONS: readonly Migration[] = [
  { id: MIGRATION_ID, sql: initialSchemaSql },
  { id: MIGRATION_002, sql: migration002Sql },
  { id: MIGRATION_003, sql: migration003Sql },
];

export type MigrationResult = {
  readonly applied: readonly string[];
  /** Number of migrations this build knows. */
  readonly schemaVersion: number;
  /** Lowest schema version a release must know to run against this database. */
  readonly compatFloor: number;
};

export class SchemaTooNewError extends Error {
  constructor(compatFloor: number, schemaVersion: number) {
    super(
      `Database needs schema version ${compatFloor} or newer, this build knows ${schemaVersion}. Deploy a newer release or restore the backup taken before the upgrade.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Applies pending migrations in one transaction.
 * `PRAGMA user_version` stores the compatibility floor, so an older release refuses a schema it cannot use
 * instead of writing to it.
 */
export function migrate(db: Mon22rDb, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  db.sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const schemaVersion = migrations.length;
  const storedFloor = readUserVersion(db);
  if (storedFloor > schemaVersion) throw new SchemaTooNewError(storedFloor, schemaVersion);
  const apply = db.sqlite.transaction((): MigrationResult => {
    const known = new Set(appliedMigrationIds(db));
    const applied: string[] = [];
    let compatFloor = Math.max(storedFloor, 1);
    migrations.forEach((migration, index) => {
      if (known.has(migration.id)) return;
      db.sqlite.exec(migration.sql);
      db.sqlite
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
      applied.push(migration.id);
      if (migration.breaksOlderReleases === true) compatFloor = Math.max(compatFloor, index + 1);
    });
    if (compatFloor !== storedFloor) db.sqlite.pragma(`user_version = ${compatFloor}`);
    return { applied, schemaVersion, compatFloor };
  });
  const result = apply();
  fillNoteKeys(db);
  return result;
}

/**
 * Gives every described transaction its note key.
 * Runs on each start: rows written by a release older than migration 003 arrive without one.
 */
export function fillNoteKeys(db: Mon22rDb): number {
  const columns: unknown = db.sqlite.pragma("table_info(transactions)");
  const hasNoteKey =
    Array.isArray(columns) &&
    columns.some(
      (column) => typeof column === "object" && column !== null && "name" in column && column.name === "note_key",
    );
  if (!hasNoteKey) return 0;
  const rows: unknown = db.sqlite
    .prepare("SELECT id, description FROM transactions WHERE note_key = '' AND description <> ''")
    .all();
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const update = db.sqlite.prepare("UPDATE transactions SET note_key = ? WHERE id = ?");
  const apply = db.sqlite.transaction(() => {
    let changed = 0;
    for (const row of rows) {
      if (typeof row !== "object" || row === null || !("id" in row) || !("description" in row)) continue;
      if (typeof row.id !== "string" || typeof row.description !== "string") continue;
      const key = noteKey(row.description);
      if (key.length === 0) continue;
      update.run(key, row.id);
      changed += 1;
    }
    return changed;
  });
  return apply();
}

function readUserVersion(db: Mon22rDb): number {
  const value: unknown = db.sqlite.pragma("user_version", { simple: true });
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function appliedMigrationIds(db: Mon22rDb): string[] {
  const rows: unknown = db.sqlite.prepare("SELECT id FROM schema_migrations").all();
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "object" && row !== null && "id" in row && typeof row.id === "string") ids.push(row.id);
  }
  return ids;
}
