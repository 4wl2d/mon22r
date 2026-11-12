import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  CLEAN_STOP_KEY,
  createAccount,
  createUser,
  inspectDatabaseFile,
  listTransactions,
  migrate,
  openDatabase,
  readState,
  recordTransaction,
  writeState,
} from "@mon22r/db";
import { describe, expect, it } from "vitest";

import { createBackup, listBackupNames, pruneBackups, restoreBackup, verifyBackup } from "../src/backup.js";
import { onCleanup, scratchDirectory } from "./helpers.js";

function liveDatabase(directory: string) {
  const path = join(directory, "mon22r.sqlite");
  const db = openDatabase(path);
  migrate(db);
  onCleanup(() => db.close());
  const user = createUser(db, { id: "user-a", homeCurrency: "RSD" });
  const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
  const add = (id: string, at: string) =>
    recordTransaction(db, user.id, {
      id,
      accountId: card.id,
      kind: "expense",
      amountMinor: 35_000,
      currency: "RSD",
      occurredAt: at,
      createdAt: at,
      description: id,
    });
  return { path, db, user, add };
}

describe("backups", () => {
  it("copies a database that is being written to, including rows still in the write-ahead log", async () => {
    const directory = scratchDirectory();
    const live = liveDatabase(directory);
    live.add("first", "2026-11-10T10:00:00.000Z");
    live.add("second", "2026-11-11T10:00:00.000Z");
    // Nothing was checkpointed: a plain copy of the main file would miss both rows.
    expect(inspectDatabaseFile(live.path).transactions).toBe(2);

    const backups = join(directory, "backups");
    const file = await createBackup(live.db, backups, "daily", new Date("2026-11-12T03:00:00.000Z"));
    expect(file.name).toBe("mon22r-daily-20261112T030000Z.sqlite.gz");
    expect(file.report).toMatchObject({ ok: true, integrity: "ok", users: 1, accounts: 1, transactions: 2 });
    expect(file.report.latestTransactionAt).toBe("2026-11-11T10:00:00.000Z");
    // No temporary pieces are left next to the backup.
    expect(readdirSync(backups)).toEqual([file.name]);
    expect(await verifyBackup(file.path)).toMatchObject({ ok: true, transactions: 2 });
  });

  it("restores a backup over a later state and keeps the replaced files", async () => {
    const directory = scratchDirectory();
    const live = liveDatabase(directory);
    live.add("kept", "2026-11-10T10:00:00.000Z");
    // The service is running while the backup is taken, so the backup carries its "still running" mark.
    writeState(live.db, CLEAN_STOP_KEY, "0");
    const file = await createBackup(
      live.db,
      join(directory, "backups"),
      "pre-deploy",
      new Date("2026-11-12T03:00:00.000Z"),
    );
    live.add("after-backup", "2026-11-12T09:00:00.000Z");
    live.db.close();

    const restored = await restoreBackup(file.path, live.path, new Date("2026-11-12T12:00:00.000Z"));
    expect(restored.report).toMatchObject({ ok: true, transactions: 1 });
    expect(restored.previous).toBe(`${live.path}.before-restore-20261112T120000000Z`);
    // The state that was replaced is still there, in case the restore was the mistake.
    expect(inspectDatabaseFile(restored.previous ?? "").transactions).toBe(2);

    const reopened = openDatabase(live.path);
    expect(migrate(reopened).applied).toEqual([]);
    expect(listTransactions(reopened, "user-a").map((row) => row.id)).toEqual(["kept"]);
    // A restore is not a crash: the next start must not report one.
    expect(readState(reopened, CLEAN_STOP_KEY)).toBe("1");
    reopened.close();
  });

  it("rejects a damaged backup before touching the database", async () => {
    const directory = scratchDirectory();
    const live = liveDatabase(directory);
    live.add("kept", "2026-11-10T10:00:00.000Z");
    live.db.close();
    const damaged = join(directory, "mon22r-manual-20261112T030000Z.sqlite.gz");
    writeFileSync(damaged, gzipSync(Buffer.from("this is not a database")));
    await expect(restoreBackup(damaged, live.path)).rejects.toThrow();
    const truncated = join(directory, "mon22r-manual-20261112T040000Z.sqlite.gz");
    writeFileSync(truncated, Buffer.from([0x1f, 0x8b, 0x08]));
    await expect(verifyBackup(truncated)).rejects.toThrow();
    expect(inspectDatabaseFile(live.path).transactions).toBe(1);
  });

  it("keeps the newest files of a label and leaves other labels alone", async () => {
    const directory = scratchDirectory();
    const live = liveDatabase(directory);
    const backups = join(directory, "backups");
    for (const day of [10, 11, 12, 13]) {
      await createBackup(live.db, backups, "daily", new Date(Date.UTC(2026, 10, day, 3)));
    }
    await createBackup(live.db, backups, "pre-deploy", new Date(Date.UTC(2026, 10, 1, 3)));
    writeFileSync(join(backups, "notes.txt"), "not a backup");
    expect(await pruneBackups(backups, "daily", 2)).toEqual([
      "mon22r-daily-20261110T030000Z.sqlite.gz",
      "mon22r-daily-20261111T030000Z.sqlite.gz",
    ]);
    // Oldest first by time, not by label: "latest" must mean the newest backup of any kind.
    expect(await listBackupNames(backups)).toEqual([
      "mon22r-pre-deploy-20261101T030000Z.sqlite.gz",
      "mon22r-daily-20261112T030000Z.sqlite.gz",
      "mon22r-daily-20261113T030000Z.sqlite.gz",
    ]);
    expect(await listBackupNames(join(directory, "missing"))).toEqual([]);
  });
});
