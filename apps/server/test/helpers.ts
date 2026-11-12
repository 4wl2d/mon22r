import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Mon22rDb, migrate, openDatabase } from "@mon22r/db";
import { sign } from "@tma.js/init-data-node";
import { afterEach } from "vitest";

import type { Logger } from "../src/log.js";

/** Shaped like a bot token so nothing treats it as malformed. It opens no real bot. */
export const TEST_TOKEN = "1000000:test-token-for-automated-checks-only";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

export function onCleanup(action: () => void | Promise<void>): void {
  cleanups.push(action);
}

export function memoryDatabase(): Mon22rDb {
  const db = openDatabase(":memory:");
  migrate(db);
  onCleanup(() => db.close());
  return db;
}

export function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mon22r-test-"));
  onCleanup(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function authHeader(telegramId: number, token: string = TEST_TOKEN, signedAt: Date = new Date()): string {
  return `tma ${sign({ user: { id: telegramId, first_name: "A" } }, token, signedAt)}`;
}

export type LogLine = { readonly level: string; readonly message: string; readonly fields: unknown };

export function recordingLogger(): { readonly log: Logger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (message: string, fields?: unknown) => {
    lines.push({ level, message, fields });
  };
  return { log: { info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

export type TelegramCall = { readonly method: string; readonly body: Record<string, unknown> };

/**
 * A local stand-in for the Bot API over real HTTP: long polling with offsets, and a record of every call.
 * It lets the whole service run, start to stop, without reaching Telegram.
 */
export class FakeTelegram {
  readonly calls: TelegramCall[] = [];
  /** Method name -> status code to answer with, to simulate Telegram refusing a call. */
  readonly failures = new Map<string, number>();
  private readonly queue: { readonly update_id: number }[] = [];
  private readonly server: Server;
  private nextMessageId = 1000;

  private constructor() {
    this.server = createServer((request, response) => {
      void this.answer(request).then(
        ({ status, body }) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
  }

  static async start(): Promise<FakeTelegram> {
    const fake = new FakeTelegram();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    onCleanup(() => fake.stop());
    return fake;
  }

  get root(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  push(update: { readonly update_id: number }): void {
    this.queue.push(update);
  }

  sent(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.body);
  }

  /** Resolves once a call matching the predicate has arrived. */
  async waitFor(match: (call: TelegramCall) => boolean, timeoutMs = 5000): Promise<TelegramCall> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.calls.find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error("The expected Telegram call did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private async answer(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const method = /\/bot[^/]+\/(\w+)/.exec(request.url ?? "")?.[1] ?? "";
    const body = await readJson(request);
    this.calls.push({ method, body });
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      return { status: failure, body: { ok: false, error_code: failure, description: "Simulated failure" } };
    }
    return { status: 200, body: { ok: true, result: await this.result(method, body) } };
  }

  private async result(method: string, body: Record<string, unknown>): Promise<unknown> {
    if (method === "getMe") return { id: 1, is_bot: true, first_name: "mon22r", username: "mon22r_test_bot" };
    if (method === "getUpdates") {
      const offset = typeof body.offset === "number" ? body.offset : 0;
      // An offset confirms everything below it, exactly as Telegram does.
      while (this.queue[0] !== undefined && this.queue[0].update_id < offset) this.queue.shift();
      if (this.queue.length === 0) await new Promise((resolve) => setTimeout(resolve, 40));
      return [...this.queue];
    }
    if (method === "sendMessage" || method === "editMessageText" || method === "sendDocument") {
      this.nextMessageId += 1;
      return { message_id: this.nextMessageId, date: 1, chat: { id: body.chat_id, type: "private" }, text: body.text };
    }
    return true;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!(request.headers["content-type"] ?? "").includes("application/json")) return { raw: raw.length };
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function textUpdate(updateId: number, userId: number, text: string, chatType = "private") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_794_000_000,
      chat: { id: userId, type: chatType, first_name: "A" },
      from: { id: userId, is_bot: false, first_name: "A" },
      text,
    },
  };
}

export function callbackUpdate(updateId: number, userId: number, data: string, messageId = 500) {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      chat_instance: "1",
      from: { id: userId, is_bot: false, first_name: "A" },
      data,
      message: {
        message_id: messageId,
        date: 1_794_000_000,
        chat: { id: userId, type: "private", first_name: "A" },
        from: { id: 1, is_bot: true, first_name: "mon22r" },
        text: "entry",
      },
    },
  };
}
