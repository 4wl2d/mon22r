import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAccount, createUser, listFxRates, migrate, openDatabase, recordTransaction } from "@mon22r/db";
import { describe, expect, it } from "vitest";

import { listBackupNames } from "../src/backup.js";
import { text } from "../src/copy.js";
import { readRates, toFxRate } from "../src/fx.js";
import { createRuntime, POLL_STALE_MS } from "../src/health.js";
import { type JobsInput, startJobs } from "../src/jobs.js";
import { buildMonthView } from "../src/month-view.js";
import { onCleanup, recordingLogger, scratchDirectory } from "./helpers.js";

const start = new Date("2026-11-12T03:00:00.000Z");
const DAY = 86_400_000;

function setup(overrides?: Partial<JobsInput>) {
  const directory = scratchDirectory();
  const db = openDatabase(join(directory, "mon22r.sqlite"));
  migrate(db);
  const user = createUser(db, { id: "user-a", homeCurrency: "EUR", timeZone: "Europe/Belgrade" });
  const card = createAccount(db, user.id, { id: "card", name: "Поштанска", currency: "RSD" });
  let clock = start.getTime();
  const runtime = createRuntime("test", () => clock);
  runtime.lastPollAt = clock;
  const sent: { method: string; chatId: number; caption?: string; text?: string }[] = [];
  const stalled: string[] = [];
  const logger = recordingLogger();
  const requests: string[] = [];
  const jobs = startJobs({
    db,
    log: logger.log,
    runtime,
    backupDir: join(directory, "backups"),
    backupKeep: 2,
    backupChatId: 42,
    fxRefresh: true,
    api: {
      sendDocument: async (chatId, _file, other) => {
        sent.push({ method: "sendDocument", chatId: Number(chatId), caption: other?.caption });
        return {} as never;
      },
      sendMessage: async (chatId, message) => {
        sent.push({ method: "sendMessage", chatId: Number(chatId), text: message });
        return {} as never;
      },
    },
    now: () => new Date(clock),
    fetch: async (url) => {
      requests.push(String(url));
      return Response.json({
        result: "success",
        base_code: "EUR",
        time_last_update_unix: Math.floor(clock / 1000),
        rates: { EUR: 1, RSD: 117.58486, RUB: 91.981104 },
      });
    },
    onStalled: () => stalled.push("stalled"),
    ...overrides,
  });
  onCleanup(() => {
    jobs.stop();
    db.close();
  });
  const spend = (id: string) =>
    recordTransaction(db, user.id, {
      id,
      accountId: card.id,
      kind: "expense",
      amountMinor: 1_175_849,
      currency: "RSD",
      occurredAt: new Date(clock).toISOString(),
      createdAt: new Date(clock).toISOString(),
    });
  return {
    db,
    user,
    jobs,
    runtime,
    sent,
    stalled,
    requests,
    lines: logger.lines,
    directory,
    spend,
    advance(ms: number) {
      clock += ms;
      runtime.lastPollAt = clock;
    },
    freezePolling(ms: number) {
      clock += ms;
    },
  };
}

describe("background jobs", () => {
  it("backs up daily, keeps the newest files, and sends a copy only weekly and only after changes", async () => {
    const world = setup();
    world.spend("a");
    await world.jobs.tick();
    expect(await listBackupNames(join(world.directory, "backups"))).toEqual([
      "mon22r-daily-20261112T030000Z.sqlite.gz",
    ]);
    expect(world.sent).toEqual([{ method: "sendDocument", chatId: 42, caption: text.backupCaption(1) }]);
    expect(world.runtime.lastBackupAt).toBe("2026-11-12T03:00:00.000Z");

    // Within the same day nothing repeats, however often the timer fires.
    world.advance(60_000);
    await world.jobs.tick();
    expect(await listBackupNames(join(world.directory, "backups"))).toHaveLength(1);

    world.advance(DAY);
    world.spend("b");
    await world.jobs.tick();
    world.advance(DAY);
    await world.jobs.tick();
    expect(await listBackupNames(join(world.directory, "backups"))).toEqual([
      "mon22r-daily-20261113T030100Z.sqlite.gz",
      "mon22r-daily-20261114T030100Z.sqlite.gz",
    ]);
    // Still one file in the chat: the week has not passed.
    expect(world.sent).toHaveLength(1);

    world.advance(6 * DAY);
    await world.jobs.tick();
    expect(world.sent.at(-1)).toEqual({ method: "sendDocument", chatId: 42, caption: text.backupCaption(2) });
    expect(world.sent).toHaveLength(2);

    // A quiet week sends nothing: the chat already has this exact state.
    world.advance(8 * DAY);
    await world.jobs.tick();
    expect(world.sent).toHaveLength(2);
  });

  it("reports a failed backup to the owner and tries again later", async () => {
    // A regular file where the backup directory should be: creating the directory fails on every platform.
    const blocked = join(scratchDirectory(), "not-a-directory");
    writeFileSync(blocked, "");
    const world = setup({ backupDir: blocked });
    await world.jobs.tick();
    expect(world.sent).toEqual([{ method: "sendMessage", chatId: 42, text: text.backupFailed }]);
    expect(world.lines.some((line) => line.level === "error" && line.message === "backup failed")).toBe(true);
    // Not again a minute later, but again after the retry pause.
    world.advance(60_000);
    await world.jobs.tick();
    expect(world.sent).toHaveLength(1);
    world.advance(31 * 60_000);
    await world.jobs.tick();
    expect(world.sent).toHaveLength(2);
  });

  it("refreshes rates once a day and makes the home-currency estimate appear", async () => {
    const world = setup();
    world.spend("a");
    expect(buildMonthView(world.db, world.user, { year: 2026, month: 11 }).estimateInHomeCurrency).toBeNull();
    await world.jobs.tick();
    expect(world.requests).toEqual(["https://open.er-api.com/v6/latest/EUR"]);
    expect(listFxRates(world.db)).toEqual([toFxRate("EUR", "RSD", 117.58486, "2026-11-12")]);
    // 11 758,49 RSD at 117.58486 is 100.00 EUR.
    expect(buildMonthView(world.db, world.user, { year: 2026, month: 11 }).estimateInHomeCurrency).toMatchObject({
      minor: -10_000,
      currency: "EUR",
      asOf: "2026-11-12",
      usedConversion: true,
    });
    world.advance(60_000);
    await world.jobs.tick();
    expect(world.requests).toHaveLength(1);
    world.advance(DAY);
    await world.jobs.tick();
    expect(world.requests).toHaveLength(2);
    // One row per pair: yesterday's rate is replaced, not kept.
    expect(listFxRates(world.db).map((rate) => rate.asOf)).toEqual(["2026-11-13"]);
  });

  it("keeps the old rates when the rate service fails or answers nonsense", async () => {
    let healthy = true;
    const world = setup({
      fetch: async () =>
        healthy
          ? Response.json({
              result: "success",
              base_code: "EUR",
              time_last_update_unix: 1_794_441_600,
              rates: { RSD: 117 },
            })
          : new Response("busy", { status: 503 }),
    });
    world.spend("a");
    await world.jobs.tick();
    const before = listFxRates(world.db);
    expect(before).toHaveLength(1);
    healthy = false;
    world.advance(DAY);
    await world.jobs.tick();
    expect(listFxRates(world.db)).toEqual(before);
    expect(world.lines.some((line) => line.level === "warn" && line.message === "rates not refreshed")).toBe(true);
    expect(() => readRates({ result: "error" }, "EUR", new Set(["RSD"]))).toThrow();
    expect(() =>
      readRates({ result: "success", base_code: "USD", time_last_update_unix: 1, rates: {} }, "EUR", new Set()),
    ).toThrow();
    expect(
      readRates(
        { result: "success", base_code: "EUR", time_last_update_unix: 1_794_441_600, rates: { RSD: -1, RUB: "x" } },
        "EUR",
        new Set(["RSD", "RUB"]),
      ),
    ).toEqual([]);
  });

  it("keeps watching the poll loop while a slow job is still running", async () => {
    let release: () => void = () => undefined;
    const world = setup({
      // A rate request that does not come back for a long time.
      fetch: () => new Promise<Response>((resolve) => (release = () => resolve(new Response("late", { status: 503 })))),
    });
    const slow = world.jobs.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    world.freezePolling(POLL_STALE_MS + 1000);
    await world.jobs.tick();
    expect(world.stalled).toEqual(["stalled"]);
    release();
    await slow;
  });

  it("asks for a restart when polling has stalled, and does no other work first", async () => {
    const world = setup();
    world.freezePolling(POLL_STALE_MS + 1000);
    await world.jobs.tick();
    expect(world.stalled).toEqual(["stalled"]);
    expect(await listBackupNames(join(world.directory, "backups"))).toEqual([]);
  });
});
