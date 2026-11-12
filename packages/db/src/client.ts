import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

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
      sqlite.close();
    },
  };
}
