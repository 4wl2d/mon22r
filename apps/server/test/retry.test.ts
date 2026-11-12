import { HttpError } from "grammy";
import { describe, expect, it } from "vitest";

import { boundedRetry } from "../src/retry.js";

type Answer = { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };

function harness(answers: (Answer | Error)[]) {
  const waits: number[] = [];
  let calls = 0;
  const transformer = boundedRetry({ sleep: async (ms) => void waits.push(ms) });
  const prev = async () => {
    const next = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next as never;
  };
  const call = (method: string) => transformer(prev as never, method as never, {} as never, undefined);
  return { call, waits, calls: () => calls };
}

const dropped = () => new HttpError("Network request for 'sendMessage' failed!", new Error("socket hang up"));

describe("bounded retry", () => {
  it("retries a dropped connection twice with short pauses, then gives the error to the caller", async () => {
    const recovered = harness([dropped(), { ok: true }]);
    await expect(recovered.call("sendMessage")).resolves.toEqual({ ok: true });
    expect(recovered.calls()).toBe(2);
    expect(recovered.waits).toEqual([1000]);

    const down = harness([dropped()]);
    await expect(down.call("sendMessage")).rejects.toBeInstanceOf(HttpError);
    // Three attempts and four seconds of waiting in all: the update loop is never held for minutes.
    expect(down.calls()).toBe(3);
    expect(down.waits).toEqual([1000, 3000]);
  });

  it("retries a server error, waits out a short flood limit, and returns a long one", async () => {
    const flaky = harness([{ ok: false, error_code: 502 }, { ok: true }]);
    await expect(flaky.call("sendMessage")).resolves.toEqual({ ok: true });

    const flood = harness([{ ok: false, error_code: 429, parameters: { retry_after: 2 } }, { ok: true }]);
    await expect(flood.call("sendMessage")).resolves.toEqual({ ok: true });
    expect(flood.waits).toEqual([2000]);

    const longFlood = harness([{ ok: false, error_code: 429, parameters: { retry_after: 600 } }]);
    await expect(longFlood.call("sendMessage")).resolves.toMatchObject({ ok: false, error_code: 429 });
    expect(longFlood.calls()).toBe(1);
    expect(longFlood.waits).toEqual([]);
  });

  it("does not repeat a request Telegram rejected, and leaves long polling to its own loop", async () => {
    const rejected = harness([{ ok: false, error_code: 400, description: "Bad Request" }]);
    await expect(rejected.call("sendMessage")).resolves.toMatchObject({ ok: false, error_code: 400 });
    expect(rejected.calls()).toBe(1);

    const polling = harness([dropped()]);
    await expect(polling.call("getUpdates")).rejects.toBeInstanceOf(HttpError);
    expect(polling.calls()).toBe(1);

    const other = harness([new TypeError("a bug, not the network")]);
    await expect(other.call("sendMessage")).rejects.toBeInstanceOf(TypeError);
    expect(other.calls()).toBe(1);
  });
});
