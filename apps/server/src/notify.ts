import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SEND_TIMEOUT_MS = 5_000;
const QUIET_MS = 30 * 60_000;

/**
 * Sends the owner a plain message without the bot object, for moments when the process is going down
 * or never came up. A marker file limits it to one message per half hour, so a crash loop cannot flood the chat.
 * Never throws: an alert that fails must not hide the original problem.
 */
export async function alertOwner(input: {
  readonly token: string;
  readonly chatId: number | undefined;
  readonly message: string;
  readonly markerPath: string;
  readonly apiRoot?: string;
  readonly fetch?: typeof fetch;
  readonly now?: number;
}): Promise<boolean> {
  if (input.chatId === undefined) return false;
  const now = input.now ?? Date.now();
  try {
    if (now - statSync(input.markerPath).mtimeMs < QUIET_MS) return false;
  } catch {
    // No marker yet: nothing was sent recently.
  }
  try {
    mkdirSync(dirname(input.markerPath), { recursive: true });
    writeFileSync(input.markerPath, "");
    utimesSync(input.markerPath, new Date(now), new Date(now));
    const request = input.fetch ?? fetch;
    const response = await request(`${input.apiRoot ?? "https://api.telegram.org"}/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: input.chatId, text: input.message }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
