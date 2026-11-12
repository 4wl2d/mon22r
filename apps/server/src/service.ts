import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { serve } from "@hono/node-server";
import { CLEAN_STOP_KEY, type MigrationResult, migrate, openDatabase, readState, writeState } from "@mon22r/db";

import { createBot } from "./bot.js";
import { commands } from "./copy.js";
import type { Env } from "./env.js";
import { createRuntime, type Runtime } from "./health.js";
import { createApp } from "./http.js";
import { type Jobs, startJobs } from "./jobs.js";
import { errorFields, type Logger } from "./log.js";
import { alertOwner } from "./notify.js";

const FIRST_TICK_MS = 30_000;

export type Service = {
  readonly port: number;
  readonly runtime: Runtime;
  readonly migration: MigrationResult;
  readonly jobs: Jobs;
  /** True when the previous run ended without a clean stop. */
  readonly recovered: boolean;
  /** Confirms handled updates with Telegram, closes HTTP, and checkpoints and closes the database. */
  stop(): Promise<void>;
};

/**
 * Starts the whole application in this process: database, HTTP, the bot's long polling, and background jobs.
 * `onFatal` is called when the service cannot go on (polling ended or stalled); the caller decides to exit.
 */
export async function startService(
  env: Env,
  options: {
    readonly log: Logger;
    readonly onFatal: (reason: string, error?: unknown) => void;
    readonly miniAppDist?: string;
  },
): Promise<Service> {
  const { log } = options;
  const runtime = createRuntime(env.version);
  const owner = [...env.allowedTelegramIds][0];

  if (env.databasePath !== ":memory:") mkdirSync(dirname(env.databasePath), { recursive: true });
  const db = openDatabase(env.databasePath);
  let migration: MigrationResult;
  try {
    migration = migrate(db);
  } catch (error) {
    db.sqlite.close();
    throw error;
  }
  log.info("database ready", {
    applied: migration.applied,
    schemaVersion: migration.schemaVersion,
    compatFloor: migration.compatFloor,
  });

  // "0" stays in place for the whole run. Finding it at the next start means the previous run did not stop cleanly.
  const recovered = readState(db, CLEAN_STOP_KEY) === "0";
  writeState(db, CLEAN_STOP_KEY, "0");

  const app = createApp({
    db,
    botToken: env.botToken,
    allowed: env.allowedTelegramIds,
    log,
    runtime,
    miniAppDist: options.miniAppDist,
  });
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: env.port });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;

  const bot = createBot({
    token: env.botToken,
    db,
    allowed: env.allowedTelegramIds,
    miniAppUrl: env.miniAppUrl,
    log,
    runtime,
    apiRoot: env.telegramApiRoot,
  });

  const jobs = startJobs({
    db,
    log,
    runtime,
    backupDir: env.backupDir,
    backupKeep: env.backupKeep,
    backupChatId: env.backupToTelegram && owner !== undefined ? owner : null,
    fxRefresh: env.fxRefresh,
    api: bot.api,
    onStalled: () => options.onFatal("polling stalled"),
  });
  const firstTick = setTimeout(() => void jobs.tick(), FIRST_TICK_MS);
  firstTick.unref();

  // The menu button and the command list live on Telegram's side; a failure here must not block the bot.
  await Promise.all([
    bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "mon22r", web_app: { url: env.miniAppUrl } } }),
    bot.api.setMyCommands([...commands]),
  ]).catch((error: unknown) => log.warn("telegram settings not applied", errorFields(error)));

  let stopping = false;
  const polling = bot
    .start({
      allowed_updates: ["message", "edited_message", "callback_query"],
      onStart: (info) => log.info("polling", { bot: info.username }),
    })
    .then(() => {
      // `start` resolves only after `stop`. Getting here without one means polling ended by itself.
      if (!stopping) options.onFatal("polling ended");
    })
    .catch((error: unknown) => {
      if (!stopping) options.onFatal("polling failed", error);
    });

  log.info("started", { version: env.version, port });
  if (recovered) {
    log.warn("previous run did not stop cleanly");
    void alertOwner({
      token: env.botToken,
      chatId: owner,
      message: `mon22r перезапущен после сбоя, версия ${env.version}. Последние записи стоит проверить через /month.`,
      markerPath: join(dirname(env.databasePath), ".last-alert"),
      apiRoot: env.telegramApiRoot,
    });
  }

  return {
    port,
    runtime,
    migration,
    jobs,
    recovered,
    async stop() {
      if (stopping) return;
      stopping = true;
      clearTimeout(firstTick);
      jobs.stop();
      // Stopping the bot confirms the updates handled so far, so they are not delivered again after a restart.
      await bot.stop().catch((error: unknown) => log.warn("bot stop failed", errorFields(error)));
      await polling;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      writeState(db, CLEAN_STOP_KEY, "1");
      db.close();
      log.info("stopped");
    },
  };
}
