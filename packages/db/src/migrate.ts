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

export function migrate(db: Mon22rDb): void {
  db.sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const apply = db.sqlite.transaction(() => {
    const applied = new Set(appliedMigrationIds(db));
    const pending = [
      { id: MIGRATION_ID, sql: initialSchemaSql },
      { id: MIGRATION_002, sql: migration002Sql },
    ];
    for (const migration of pending) {
      if (applied.has(migration.id)) continue;
      db.sqlite.exec(migration.sql);
      db.sqlite
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
    }
  });
  apply();
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
