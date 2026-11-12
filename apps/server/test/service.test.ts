import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { createUser, listTransactions, migrate, openDatabase, readState, writeState } from "@mon22r/db";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import { type Service, startService } from "../src/service.js";
import { createStarterAccounts } from "../src/starter.js";
import { FakeTelegram, onCleanup, recordingLogger, scratchDirectory, TEST_TOKEN, textUpdate } from "./helpers.js";

const OWNER = 42;

function environment(directory: string, telegram: FakeTelegram, overrides?: Partial<Env>): Env {
  return {
    botToken: TEST_TOKEN,
    allowedTelegramIds: new Set([OWNER]),
    databasePath: join(directory, "mon22r.sqlite"),
    miniAppUrl: "https://ledger.test",
    port: 0,
    version: "test-build",
    backupDir: join(directory, "backups"),
    backupKeep: 3,
    backupToTelegram: true,
    fxRefresh: false,
    telegramApiRoot: telegram.root,
    ...overrides,
  };
}

function seed(path: string): void {
  const db = openDatabase(path);
  migrate(db);
  const user = createUser(db, { id: "user-a", telegramId: OWNER, homeCurrency: "RSD", timeZone: "Europe/Belgrade" });
  createStarterAccounts(db, user.id);
  db.close();
}

async function start(env: Env, fatal: string[] = []): Promise<{ service: Service; fatal: string[] }> {
  const service = await startService(env, {
    log: recordingLogger().log,
    onFatal: (reason) => fatal.push(reason),
    miniAppDist: "/no/such/mon22r-dist",
  });
  onCleanup(() => service.stop());
  return { service, fatal };
}

describe("service lifecycle", () => {
  it("polls, records a message, reports healthy, and stops cleanly with the update confirmed", async () => {
    const directory = scratchDirectory();
    const telegram = await FakeTelegram.start();
    const env = environment(directory, telegram);
    seed(env.databasePath);

    const { service, fatal } = await start(env);
    expect(telegram.sent("setMyCommands")[0]?.commands).toEqual([
      { command: "month", description: "Итоги месяца" },
      { command: "undo", description: "Отменить последнюю запись" },
      { command: "help", description: "Как писать" },
    ]);
    expect(telegram.sent("setChatMenuButton")).toHaveLength(1);

    telegram.push(textUpdate(501, OWNER, "кофе 350"));
    const reply = await telegram.waitFor((call) => call.method === "sendMessage");
    expect(reply.body.text).toBe("350 RSD · кофе · Поштанска");

    const health = await fetch(`http://127.0.0.1:${service.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "test-build", database: "ok", polling: "ok" });

    await service.stop();
    // The last poll carries the next offset: Telegram will not deliver update 501 again.
    const offsets = telegram.sent("getUpdates").map((body) => body.offset);
    expect(offsets.at(-1)).toBe(502);
    expect(fatal).toEqual([]);

    // After a clean stop the main database file alone holds everything.
    const wal = `${env.databasePath}-wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    const db = openDatabase(env.databasePath);
    expect(listTransactions(db, "user-a").map((row) => row.description)).toEqual(["кофе"]);
    expect(readState(db, "runtime.clean_stop")).toBe("1");
    db.close();
  });

  it("tells the owner after an unclean stop, once", async () => {
    const directory = scratchDirectory();
    const telegram = await FakeTelegram.start();
    const env = environment(directory, telegram);
    seed(env.databasePath);
    const crashed = openDatabase(env.databasePath);
    writeState(crashed, "runtime.clean_stop", "0");
    crashed.close();

    const first = await start(env);
    expect(first.service.recovered).toBe(true);
    const alert = await telegram.waitFor((call) => call.method === "sendMessage");
    expect(alert.body).toMatchObject({ chat_id: OWNER });
    expect(String(alert.body.text)).toContain("перезапущен после сбоя");
    await first.service.stop();

    const second = await start(env);
    expect(second.service.recovered).toBe(false);
    await second.service.stop();
    expect(telegram.sent("sendMessage")).toHaveLength(1);
  });

  it("reports a fatal polling failure instead of running without the bot", async () => {
    const directory = scratchDirectory();
    const telegram = await FakeTelegram.start();
    telegram.failures.set("getUpdates", 401);
    const env = environment(directory, telegram);
    seed(env.databasePath);
    const { fatal } = await start(env);
    const deadline = Date.now() + 5000;
    while (fatal.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fatal).toEqual(["polling failed"]);
  });

  it("refuses to start on a schema that is newer than this build can use", async () => {
    const directory = scratchDirectory();
    const telegram = await FakeTelegram.start();
    const env = environment(directory, telegram);
    seed(env.databasePath);
    const db = openDatabase(env.databasePath);
    db.sqlite.pragma("user_version = 99");
    db.close();
    await expect(startService(env, { log: recordingLogger().log, onFatal: () => undefined })).rejects.toThrow(
      /schema version 99/,
    );
    expect(telegram.calls).toEqual([]);
  });
});
