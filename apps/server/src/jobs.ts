import { type Mon22rDb, pruneHandledUpdates, pruneImportPreviews, readState, writeState } from "@mon22r/db";
import type { Api } from "grammy";
import { InputFile } from "grammy";

import { type BackupFile, createBackup, pruneBackups } from "./backup.js";
import { text } from "./copy.js";
import { refreshFxRates } from "./fx.js";
import { pollingState, type Runtime } from "./health.js";
import { errorFields, type Logger } from "./log.js";

const TICK_MS = 60_000;
const DAY_MS = 86_400_000;
const BACKUP_EVERY_MS = DAY_MS;
const BACKUP_SEND_EVERY_MS = 7 * DAY_MS;
const RETRY_AFTER_MS = 30 * 60_000;
const HANDLED_UPDATES_KEEP_MS = 3 * DAY_MS;
const PREVIEWS_KEEP_MS = 7 * DAY_MS;

export const STATE = {
  backupAt: "backup.last_ok_at",
  backupSentAt: "backup.last_sent_at",
  backupSentMark: "backup.last_sent_mark",
  fxOn: "fx.last_ok_on",
  maintenanceAt: "maintenance.last_at",
} as const;

export type JobsInput = {
  readonly db: Mon22rDb;
  readonly log: Logger;
  readonly runtime: Runtime;
  readonly backupDir: string;
  readonly backupKeep: number;
  /** Chat that receives the weekly backup file. Null keeps backups on disk only. */
  readonly backupChatId: number | null;
  readonly fxRefresh: boolean;
  readonly api: Pick<Api, "sendDocument" | "sendMessage">;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  /** Called when the long-poll loop stopped answering. The process should exit so it is restarted. */
  readonly onStalled: () => void;
};

export type Jobs = {
  /** One pass over every job. The timer calls it; tests call it directly. */
  tick(): Promise<void>;
  stop(): void;
};

/**
 * Background work of the single process: the polling watchdog, the daily backup with its weekly copy to
 * Telegram, the daily rate refresh, and cleanup. Each job remembers its last success in `app_state`,
 * so a restart neither repeats nor skips it.
 */
export function startJobs(input: JobsInput): Jobs {
  const { db, log, runtime } = input;
  const now = input.now ?? (() => new Date());
  const lastAttempt = new Map<string, number>();
  let running = false;
  let stopped = false;

  runtime.lastBackupAt = readState(db, STATE.backupAt);

  const due = (key: string, everyMs: number, at: number): boolean => {
    const last = Date.parse(readState(db, key) ?? "");
    if (!Number.isNaN(last) && at - last < everyMs) return false;
    return at - (lastAttempt.get(key) ?? 0) >= RETRY_AFTER_MS;
  };

  async function backup(at: Date): Promise<void> {
    lastAttempt.set(STATE.backupAt, at.getTime());
    try {
      const file = await createBackup(db, input.backupDir, "daily", at);
      await pruneBackups(input.backupDir, "daily", input.backupKeep);
      writeState(db, STATE.backupAt, file.createdAt, at);
      runtime.lastBackupAt = file.createdAt;
      log.info("backup written", { name: file.name, bytes: file.bytes, transactions: file.report.transactions });
      await sendBackup(file, at);
    } catch (error) {
      log.error("backup failed", errorFields(error));
      if (input.backupChatId !== null) {
        await input.api.sendMessage(input.backupChatId, text.backupFailed).catch(() => undefined);
      }
    }
  }

  /** Off-host copy: at most weekly, and only when the ledger changed since the copy sent last. */
  async function sendBackup(file: BackupFile, at: Date): Promise<void> {
    if (input.backupChatId === null) return;
    const mark = `${file.report.transactions}:${file.report.latestTransactionAt ?? ""}`;
    const sentAt = Date.parse(readState(db, STATE.backupSentAt) ?? "");
    const fresh = !Number.isNaN(sentAt) && at.getTime() - sentAt < BACKUP_SEND_EVERY_MS;
    if (fresh || readState(db, STATE.backupSentMark) === mark) return;
    try {
      await input.api.sendDocument(input.backupChatId, new InputFile(file.path, file.name), {
        caption: text.backupCaption(file.report.transactions),
        disable_notification: true,
      });
      writeState(db, STATE.backupSentAt, at.toISOString(), at);
      writeState(db, STATE.backupSentMark, mark, at);
      log.info("backup sent", { name: file.name });
    } catch (error) {
      log.warn("backup not sent", errorFields(error));
    }
  }

  async function rates(at: Date): Promise<void> {
    lastAttempt.set(STATE.fxOn, at.getTime());
    try {
      const refreshed = await refreshFxRates({ db, fetch: input.fetch });
      writeState(db, STATE.fxOn, at.toISOString(), at);
      if (refreshed !== null) log.info("rates refreshed", { asOf: refreshed.asOf, pairs: refreshed.pairs });
    } catch (error) {
      log.warn("rates not refreshed", errorFields(error));
    }
  }

  function maintain(at: Date): void {
    lastAttempt.set(STATE.maintenanceAt, at.getTime());
    const updates = pruneHandledUpdates(db, new Date(at.getTime() - HANDLED_UPDATES_KEEP_MS));
    const previews = pruneImportPreviews(db, new Date(at.getTime() - PREVIEWS_KEEP_MS));
    writeState(db, STATE.maintenanceAt, at.toISOString(), at);
    if (updates > 0 || previews > 0) log.info("cleanup", { handledUpdates: updates, importPreviews: previews });
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const at = now();
    // The watchdog runs on every tick, also while a slow job from an earlier tick is still going.
    if (pollingState(runtime, at.getTime()) === "stale") {
      log.error("polling stalled", { lastPollAt: runtime.lastPollAt });
      input.onStalled();
      return;
    }
    if (running) return;
    running = true;
    try {
      if (due(STATE.backupAt, BACKUP_EVERY_MS, at.getTime())) await backup(at);
      if (input.fxRefresh && due(STATE.fxOn, DAY_MS, at.getTime())) await rates(at);
      if (due(STATE.maintenanceAt, DAY_MS, at.getTime())) maintain(at);
    } catch (error) {
      log.error("job tick failed", errorFields(error));
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
