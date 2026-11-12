import { describe, expect, it } from "vitest";

import { readEnv } from "../src/env.js";

const required = { BOT_TOKEN: "test-token", MINI_APP_URL: "https://ledger.test", ALLOWED_TELEGRAM_IDS: "42" };

describe("backup privacy defaults", () => {
  it("keeps full-ledger backups local unless Telegram delivery is explicitly enabled", () => {
    expect(readEnv(required).backupToTelegram).toBe(false);
    expect(readEnv({ ...required, BACKUP_TO_TELEGRAM: "" }).backupToTelegram).toBe(false);
    expect(readEnv({ ...required, BACKUP_TO_TELEGRAM: "off" }).backupToTelegram).toBe(false);
    expect(readEnv({ ...required, BACKUP_TO_TELEGRAM: "on" }).backupToTelegram).toBe(true);
  });
});
