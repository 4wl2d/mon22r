import type { Mon22rDb } from "@mon22r/db";

/** A long poll waits up to 30 seconds, so several missed rounds mean the loop is stuck. */
export const POLL_STALE_MS = 3 * 60_000;

export type HealthReport = {
  readonly ok: boolean;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly database: "ok" | "failed";
  /** `starting` until the first poll returns, `stale` when polls stopped. */
  readonly polling: "ok" | "starting" | "stale" | "off";
  readonly lastBackupAt: string | null;
};

/** Liveness facts the HTTP health route, the watchdog, and the logs share. */
export type Runtime = {
  readonly version: string;
  readonly startedAt: number;
  /** Time the last `getUpdates` round finished. Null before the first one. */
  lastPollAt: number | null;
  /** False when the process runs without the bot (tools and tests). */
  pollingExpected: boolean;
  lastBackupAt: string | null;
};

export function createRuntime(version: string, now: () => number = Date.now): Runtime {
  return { version, startedAt: now(), lastPollAt: null, pollingExpected: true, lastBackupAt: null };
}

export function pollingState(runtime: Runtime, now: number): HealthReport["polling"] {
  if (!runtime.pollingExpected) return "off";
  if (runtime.lastPollAt === null) return now - runtime.startedAt > POLL_STALE_MS ? "stale" : "starting";
  return now - runtime.lastPollAt > POLL_STALE_MS ? "stale" : "ok";
}

export function readHealth(db: Mon22rDb, runtime: Runtime, now: number = Date.now()): HealthReport {
  let database: HealthReport["database"] = "ok";
  try {
    db.sqlite.prepare("SELECT 1").get();
  } catch {
    database = "failed";
  }
  const polling = pollingState(runtime, now);
  return {
    ok: database === "ok" && polling !== "stale",
    version: runtime.version,
    uptimeSeconds: Math.round((now - runtime.startedAt) / 1000),
    database,
    polling,
    lastBackupAt: runtime.lastBackupAt,
  };
}
