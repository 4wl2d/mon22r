import { HttpError, type Transformer } from "grammy";

/** Pauses before the second and the third attempt. Three attempts in all. */
const DELAYS_MS: readonly number[] = [1000, 3000];
/** A flood limit that asks for a longer wait than this is returned to the caller instead of waited out. */
const MAX_FLOOD_WAIT_SECONDS = 15;

/**
 * Retries a Bot API call a bounded number of times on a dropped connection, a 5xx answer, or a short flood limit.
 *
 * Updates are handled one at a time, so a call that waits blocks the whole bot. The retry therefore gives up
 * after a few seconds and lets the handler report the failure; it never backs off for minutes.
 * Long polling is left alone: it has its own loop and its own patience.
 */
export function boundedRetry(options?: {
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}): Transformer {
  const delays = options?.delaysMs ?? DELAYS_MS;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (prev, method, payload, signal) => {
    if (method === "getUpdates") return prev(method, payload, signal);
    for (let attempt = 0; ; attempt += 1) {
      const delay = delays[attempt];
      try {
        const result = await prev(method, payload, signal);
        if (result.ok || delay === undefined) return result;
        const floodWait = result.parameters?.retry_after;
        if (typeof floodWait === "number") {
          if (floodWait > MAX_FLOOD_WAIT_SECONDS) return result;
          await sleep(floodWait * 1000);
        } else if (result.error_code >= 500) {
          await sleep(delay);
        } else {
          // A 4xx answer is about the request itself; sending it again changes nothing.
          return result;
        }
      } catch (error) {
        if (!(error instanceof HttpError) || delay === undefined || signal?.aborted === true) throw error;
        await sleep(delay);
      }
    }
  };
}
