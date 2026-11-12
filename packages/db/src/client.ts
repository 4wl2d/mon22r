import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

export type Mon22rDb = {
  readonly filename: string;
  readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;
  close(): void;
};

export function openDatabase(filename: string): Mon22rDb {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("SQLite filename is required");
  }
  if (filename !== ":memory:" && !existsSync(filename)) {
    const absolute = resolve(filename);
    const directory = dirname(absolute);
    const name = basename(absolute);
    const recoveryFile = existsSync(directory)
      ? readdirSync(directory).find(
          (entry) => entry === `${name}.restoring` || entry.startsWith(`${name}.before-restore-`),
        )
      : undefined;
    if (recoveryFile !== undefined) {
      throw new Error(
        `Database is missing after an interrupted restore. Recover ${resolve(directory, recoveryFile)} before starting.`,
      );
    }
  }
  const sqlite = new Database(filename);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (filename !== ":memory:") sqlite.pragma("journal_mode = WAL");
  const orm = drizzle(sqlite, { schema });
  return {
    filename,
    sqlite,
    orm,
    close() {
      if (!sqlite.open) return;
      // Fold the write-ahead log into the main file so a plain file copy taken after a clean stop is complete.
      if (filename !== ":memory:") sqlite.pragma("wal_checkpoint(TRUNCATE)");
      sqlite.close();
    },
  };
}
