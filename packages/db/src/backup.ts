import Database from "better-sqlite3";

import type { Mon22rDb } from "./client.js";
import { CLEAN_STOP_KEY } from "./state.js";

export type DatabaseFileReport = {
  readonly ok: boolean;
  /** `ok`, or the first lines SQLite reported. */
  readonly integrity: string;
  readonly foreignKeyViolations: number;
  readonly migrations: readonly string[];
  readonly users: number;
  readonly accounts: number;
  readonly transactions: number;
  /** Newest `created_at` among transactions, to judge how fresh a backup is. */
  readonly latestTransactionAt: string | null;
};

/**
 * Writes a consistent, single-file copy of the open database with SQLite's online backup API.
 * Safe while the application is writing; rows still in the write-ahead log are included.
 */
export async function backupDatabase(db: Mon22rDb, destination: string): Promise<DatabaseFileReport> {
  await db.sqlite.backup(destination);
  // The copy inherits write-ahead logging. Switching it off folds everything into the one file,
  // so the backup has no sidecar files and can be moved or compressed on its own.
  const copy = new Database(destination);
  try {
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
  const report = inspectDatabaseFile(destination);
  if (!report.ok) throw new Error(`Backup failed verification: ${report.integrity}`);
  return report;
}

/**
 * Records a clean stop in a database file that is not open anywhere.
 * A backup is taken while the service runs, so it carries the "still running" mark; restored as is,
 * the next start would report a crash that never happened.
 */
export function markCleanStop(path: string): void {
  const sqlite = new Database(path, { fileMustExist: true });
  try {
    // A backup from before the table existed has no mark to correct.
    if (!hasTable(sqlite, "app_state")) return;
    sqlite
      .prepare(
        "INSERT INTO app_state (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = excluded.updated_at",
      )
      .run(CLEAN_STOP_KEY, new Date().toISOString());
  } finally {
    sqlite.close();
  }
}

/** Opens a database file read-only and reports whether it is intact and what it holds. */
export function inspectDatabaseFile(path: string): DatabaseFileReport {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = textColumn(sqlite.pragma("integrity_check"), "integrity_check").slice(0, 5).join("; ");
    const foreignKeys: unknown = sqlite.pragma("foreign_key_check");
    const foreignKeyViolations = Array.isArray(foreignKeys) ? foreignKeys.length : 0;
    const migrations = hasTable(sqlite, "schema_migrations")
      ? textColumn(sqlite.prepare("SELECT id FROM schema_migrations ORDER BY id").all(), "id")
      : [];
    const latest: unknown = hasTable(sqlite, "transactions")
      ? sqlite.prepare("SELECT max(created_at) AS value FROM transactions").get()
      : undefined;
    return {
      ok: integrity === "ok" && foreignKeyViolations === 0 && migrations.length > 0,
      integrity: integrity.length === 0 ? "no result" : integrity,
      foreignKeyViolations,
      migrations,
      users: countRows(sqlite, "users"),
      accounts: countRows(sqlite, "accounts"),
      transactions: countRows(sqlite, "transactions"),
      latestTransactionAt: readText(latest, "value"),
    };
  } finally {
    sqlite.close();
  }
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function countRows(sqlite: Database.Database, table: "users" | "accounts" | "transactions"): number {
  if (!hasTable(sqlite, table)) return 0;
  const row: unknown = sqlite.prepare(`SELECT count(*) AS value FROM ${table}`).get();
  const value = typeof row === "object" && row !== null && "value" in row ? row.value : 0;
  return typeof value === "number" ? value : 0;
}

function textColumn(rows: unknown, column: string): string[] {
  if (!Array.isArray(rows)) return [];
  const values: string[] = [];
  for (const row of rows) {
    const value = readText(row, column);
    if (value !== null) values.push(value);
  }
  return values;
}

function readText(row: unknown, column: string): string | null {
  if (typeof row !== "object" || row === null) return null;
  const value = (row as Record<string, unknown>)[column];
  return typeof value === "string" ? value : null;
}
