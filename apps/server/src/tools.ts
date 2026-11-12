import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAccount, createUser, listTransactions, migrate, openDatabase } from "@mon22r/db";

import {
  type BackupLabel,
  createBackup,
  listBackupNames,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from "./backup.js";
import { applyPhrase } from "./capture.js";

/**
 * Operations entry point: `node apps/server/dist/tools.js <command>`.
 *   backup [daily|pre-deploy|manual]   write a verified backup of DATABASE_PATH into BACKUP_DIR
 *   verify <file>                      unpack a backup into a temporary file and check it
 *   restore <file>                     replace DATABASE_PATH with a backup (stop the application first)
 *   list                               list backups in BACKUP_DIR
 *   selfcheck                          prove this build works: native SQLite, migrations, capture, backup, Mini App files
 * Every command prints one JSON object. The exit code is 0 only on success.
 * The bot token is not needed and not read.
 */
const PRE_DEPLOY_KEEP = 5;
const MANUAL_KEEP = 10;

const databasePath = process.env.DATABASE_PATH?.trim() || "./data/mon22r.sqlite";
const backupDir = process.env.BACKUP_DIR?.trim() || resolve(databasePath, "..", "backups");
const [command, argument] = process.argv.slice(2);

async function run(): Promise<Record<string, unknown>> {
  if (command === "backup") {
    const label = readLabel(argument);
    const db = openDatabase(databasePath);
    try {
      const file = await createBackup(db, backupDir, label);
      if (label === "pre-deploy") await pruneBackups(backupDir, label, PRE_DEPLOY_KEEP);
      if (label === "manual") await pruneBackups(backupDir, label, MANUAL_KEEP);
      return { file: file.path, bytes: file.bytes, ...file.report };
    } finally {
      db.sqlite.close();
    }
  }
  if (command === "verify") {
    const report = await verifyBackup(requirePath(argument));
    return { ...report, file: argument };
  }
  if (command === "restore") {
    const result = await restoreBackup(requirePath(argument), databasePath);
    return { ...result.report, restoredTo: databasePath, previous: result.previous };
  }
  if (command === "list") {
    return { ok: true, directory: backupDir, backups: await listBackupNames(backupDir) };
  }
  if (command === "selfcheck") return selfcheck();
  throw new Error(
    "Usage: tools.js backup [daily|pre-deploy|manual] | verify <file> | restore <file> | list | selfcheck",
  );
}

/**
 * Exercises the parts of a build that only fail once packaged: the native SQLite module for this CPU,
 * the migrations, a capture through the real code path, a backup round trip, and the Mini App files.
 * It works in a scratch directory and touches neither the real database nor the network.
 */
async function selfcheck(): Promise<Record<string, unknown>> {
  const scratch = await mkdtemp(join(tmpdir(), "mon22r-selfcheck-"));
  try {
    const db = openDatabase(join(scratch, "check.sqlite"));
    const migration = migrate(db);
    const user = createUser(db, { telegramId: 1, homeCurrency: "RSD" });
    createAccount(db, user.id, { name: "Check", currency: "RSD" });
    const captured = applyPhrase(db, user, "кофе 350", new Date());
    const backup = await createBackup(db, join(scratch, "backups"), "manual");
    const verified = await verifyBackup(backup.path);
    const rows = listTransactions(db, user.id).length;
    db.close();
    const miniApp = existsSync(resolve(process.cwd(), "apps/miniapp/dist/index.html"));
    return {
      ok: captured.type === "saved" && rows === 1 && verified.ok && verified.transactions === 1 && miniApp,
      node: process.version,
      arch: process.arch,
      schemaVersion: migration.schemaVersion,
      capture: captured.type,
      backup: verified.integrity,
      miniApp,
      version: process.env.APP_VERSION?.trim() || "dev",
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function readLabel(value: string | undefined): BackupLabel {
  if (value === undefined) return "manual";
  if (value === "daily" || value === "pre-deploy" || value === "manual") return value;
  throw new Error("Backup label must be daily, pre-deploy, or manual");
}

function requirePath(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error("A backup file path is required");
  return value;
}

try {
  const result = await run();
  console.info(JSON.stringify(result));
  process.exitCode = result.ok === true ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
