import { dirname, resolve } from "node:path";

import { parseAllowedIds } from "./auth.js";

export type Env = {
  readonly botToken: string;
  readonly allowedTelegramIds: ReadonlySet<number>;
  readonly databasePath: string;
  readonly miniAppUrl: string;
  readonly port: number;
  /** Git revision baked into the image. `dev` outside a release build. */
  readonly version: string;
  readonly backupDir: string;
  /** Daily backups kept on disk. */
  readonly backupKeep: number;
  /** Also send each scheduled backup to the owner's chat as a file. */
  readonly backupToTelegram: boolean;
  /** Fetch daily reference rates for the home-currency estimate. */
  readonly fxRefresh: boolean;
  /** Alternative Bot API root: a local Bot API server, or a stub in tests. */
  readonly telegramApiRoot: string | undefined;
};

export function readEnv(source: NodeJS.ProcessEnv): Env {
  const botToken = required(source.BOT_TOKEN, "BOT_TOKEN");
  const miniAppUrl = readUrl(required(source.MINI_APP_URL, "MINI_APP_URL"), "MINI_APP_URL");
  const databasePath = source.DATABASE_PATH?.trim() || "./data/mon22r.sqlite";
  const backupDir = source.BACKUP_DIR?.trim() || resolve(dirname(databasePath), "backups");
  const telegramApiRoot = source.TELEGRAM_API_ROOT?.trim() || undefined;
  return {
    botToken,
    allowedTelegramIds: parseAllowedIds(source.ALLOWED_TELEGRAM_IDS),
    databasePath,
    miniAppUrl,
    port: readInteger(source.PORT, "PORT", 3000, 1, 65_535),
    version: source.APP_VERSION?.trim() || "dev",
    backupDir,
    backupKeep: readInteger(source.BACKUP_KEEP, "BACKUP_KEEP", 14, 1, 365),
    backupToTelegram: readSwitch(source.BACKUP_TO_TELEGRAM, "BACKUP_TO_TELEGRAM", true),
    fxRefresh: readSwitch(source.FX_REFRESH, "FX_REFRESH", true),
    telegramApiRoot: telegramApiRoot === undefined ? undefined : readUrl(telegramApiRoot, "TELEGRAM_API_ROOT"),
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function readUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http or https URL`);
  return value;
}

function readInteger(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} is invalid`);
  return parsed;
}

function readSwitch(value: string | undefined, name: string, fallback: boolean): boolean {
  const token = value?.trim().toLowerCase() ?? "";
  if (token === "") return fallback;
  if (token === "on" || token === "true" || token === "1") return true;
  if (token === "off" || token === "false" || token === "0") return false;
  throw new Error(`${name} must be on or off`);
}
