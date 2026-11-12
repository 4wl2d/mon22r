import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * User-owned rows are always queried with that user's id.
 * fx_rates is shared reference data for estimates, not personal data.
 * Home-currency estimates must not update transactions.amount_minor.
 * Bank passwords and internet-banking sessions are not represented here.
 * Physical checks and the import-key unique index are created in migrate.ts.
 */

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    telegramId: integer("telegram_id"),
    homeCurrency: text("home_currency").notNull(),
    timeZone: text("time_zone").notNull(),
    createdAt: text("created_at").notNull(),
    /** Null once currency, time zone, and the starter-account question are settled. */
    onboardingStep: text("onboarding_step"),
    /** Last unrecognized CSV header, so a restart can still save a column mapping. */
    pendingCsvJson: text("pending_csv_json"),
    /** Account that receives an amount written without a currency. Null falls back to the home currency. */
    defaultAccountId: text("default_account_id"),
  },
  (table) => [uniqueIndex("users_telegram_id_unique").on(table.telegramId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    archived: integer("archived").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("accounts_user_id_idx").on(table.userId)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("categories_user_name_unique").on(table.userId, table.name)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    categoryId: text("category_id").references(() => categories.id),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    direction: text("direction").notNull(),
    kind: text("kind").notNull(),
    transferGroupId: text("transfer_group_id"),
    refundOfTransactionId: text("refund_of_transaction_id"),
    occurredAt: text("occurred_at").notNull(),
    description: text("description").notNull(),
    createdAt: text("created_at").notNull(),
    /** `noteKey(description)`. Empty for rows written by a release older than migration 003 until the next start. */
    noteKey: text("note_key").notNull().default(""),
  },
  (table) => [
    index("transactions_user_occurred_idx").on(table.userId, table.occurredAt),
    index("transactions_user_transfer_idx").on(table.userId, table.transferGroupId),
    index("transactions_user_note_idx").on(table.userId, table.noteKey, table.createdAt),
    index("transactions_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const incomePlans = sqliteTable(
  "income_plans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    dayOfMonth: integer("day_of_month").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    recurrence: text("recurrence").notNull(),
    startYear: integer("start_year").notNull(),
    startMonth: integer("start_month").notNull(),
    remind: integer("remind").notNull().default(0),
    active: integer("active").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("income_plans_user_id_idx").on(table.userId)],
);

export const incomeExpectations = sqliteTable(
  "income_expectations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    planId: text("plan_id").references(() => incomePlans.id),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    name: text("name").notNull(),
    expectedMinor: integer("expected_minor").notNull(),
    receivedMinor: integer("received_minor").notNull().default(0),
    currency: text("currency").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    dayOfMonth: integer("day_of_month").notNull(),
    status: text("status").notNull(),
    matchedTransactionId: text("matched_transaction_id").references(() => transactions.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("income_expectations_user_month_idx").on(table.userId, table.year, table.month),
    uniqueIndex("income_expectations_plan_month_unique")
      .on(table.userId, table.planId, table.year, table.month)
      .where(sql`plan_id IS NOT NULL`),
  ],
);

export const fxRates = sqliteTable(
  "fx_rates",
  {
    id: text("id").primaryKey(),
    baseCurrency: text("base_currency").notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    numerator: integer("numerator").notNull(),
    denominator: integer("denominator").notNull(),
    asOf: text("as_of").notNull(),
    source: text("source").notNull(),
  },
  (table) => [
    uniqueIndex("fx_rates_pair_day_unique").on(table.baseCurrency, table.quoteCurrency, table.asOf, table.source),
  ],
);

export const importExternalKeys = sqliteTable(
  "import_external_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    externalKey: text("external_key").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .unique()
      .references(() => transactions.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("import_external_keys_identity_unique").on(table.userId, table.source, table.externalKey)],
);

export const statementProfiles = sqliteTable(
  "statement_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    fingerprint: text("fingerprint").notNull(),
    mappingJson: text("mapping_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("statement_profiles_fingerprint_unique").on(table.userId, table.fingerprint),
    uniqueIndex("statement_profiles_name_unique").on(table.userId, table.name),
    index("statement_profiles_user_idx").on(table.userId),
  ],
);

export const importPreviews = sqliteTable(
  "import_previews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    linesJson: text("lines_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("import_previews_user_idx").on(table.userId)],
);

/** Telegram update ids that already changed the ledger. A redelivered update is answered, not applied again. */
export const handledUpdates = sqliteTable("handled_updates", {
  updateId: integer("update_id").primaryKey(),
  handledAt: text("handled_at").notNull(),
});

/** Small runtime facts that must survive a restart, such as the time of the last backup. */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
