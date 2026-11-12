import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { backupDatabase, type DatabaseFileReport, inspectDatabaseFile, type Mon22rDb, markCleanStop } from "@mon22r/db";

export type BackupLabel = "daily" | "pre-deploy" | "manual";

export type BackupFile = {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly report: DatabaseFileReport;
};

const NAME = /^mon22r-(daily|pre-deploy|manual)-\d{8}T\d{6}Z\.sqlite\.gz$/;

/**
 * Writes a verified, compressed copy of the live database into `directory`.
 * The copy is checked with `PRAGMA integrity_check` before it gets its final name,
 * so every file with that name is known to be restorable.
 */
export async function createBackup(
  db: Mon22rDb,
  directory: string,
  label: BackupLabel,
  now: Date = new Date(),
): Promise<BackupFile> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const name = `mon22r-${label}-${stamp}.sqlite.gz`;
  const raw = join(directory, `.${name}.raw`);
  const partial = join(directory, `.${name}.part`);
  const path = join(directory, name);
  try {
    const report = await backupDatabase(db, raw);
    await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(partial, { mode: 0o600 }));
    await rename(partial, path);
    const info = await stat(path);
    return { path, name, bytes: info.size, createdAt: now.toISOString(), report };
  } finally {
    await rm(raw, { force: true });
    await rm(partial, { force: true });
  }
}

/** Keeps the newest `keep` files of one label and deletes the rest. Returns the deleted names. */
export async function pruneBackups(directory: string, label: BackupLabel, keep: number): Promise<string[]> {
  const names = (await listBackupNames(directory)).filter((name) => name.startsWith(`mon22r-${label}-`));
  const stale = names.slice(0, Math.max(0, names.length - keep));
  for (const name of stale) await rm(join(directory, name), { force: true });
  return stale;
}

/** Backup file names, oldest first by the time in the name, whatever their label. */
export async function listBackupNames(directory: string): Promise<string[]> {
  const stamp = (name: string): string => /(\d{8}T\d{6}Z)\.sqlite\.gz$/.exec(name)?.[1] ?? "";
  try {
    return (await readdir(directory))
      .filter((name) => NAME.test(name))
      .sort((left, right) => stamp(left).localeCompare(stamp(right)) || left.localeCompare(right));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Unpacks a backup into a private temporary file and inspects it. The backup itself is not changed. */
export async function verifyBackup(path: string): Promise<DatabaseFileReport> {
  const scratch = await mkdtemp(join(tmpdir(), "mon22r-verify-"));
  const unpacked = join(scratch, "check.sqlite");
  try {
    await unpackBackup(path, unpacked);
    return inspectDatabaseFile(unpacked);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Replaces the database file with the contents of a backup. The application must be stopped.
 * The files that were there move to `<database>.before-restore-<time>` next to it, so a wrong restore can be undone.
 */
export async function restoreBackup(
  backupPath: string,
  databasePath: string,
  now: Date = new Date(),
): Promise<{ readonly report: DatabaseFileReport; readonly previous: string | null }> {
  const checked = await verifyBackup(backupPath);
  if (!checked.ok) throw new Error(`Backup ${basename(backupPath)} failed verification: ${checked.integrity}`);
  const staged = `${databasePath}.restoring`;
  await unpackBackup(backupPath, staged);
  const suffix = `.before-restore-${now.toISOString().replace(/[-:.]/g, "")}`;
  let previous: string | null = null;
  for (const extension of ["", "-wal", "-shm"]) {
    const current = `${databasePath}${extension}`;
    if (!(await exists(current))) continue;
    await rename(current, `${current}${suffix}`);
    if (extension === "") previous = `${current}${suffix}`;
  }
  await rename(staged, databasePath);
  await chmod(databasePath, 0o600);
  markCleanStop(databasePath);
  return { report: inspectDatabaseFile(databasePath), previous };
}

async function unpackBackup(source: string, destination: string): Promise<void> {
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(destination, { mode: 0o600 }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
