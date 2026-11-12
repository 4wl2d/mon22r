import { parseAllowedIds } from "./auth.js";

export type Env = {
  readonly botToken: string;
  readonly allowedTelegramIds: ReadonlySet<number>;
  readonly databasePath: string;
  readonly miniAppUrl: string;
  readonly port: number;
};

export function readEnv(source: NodeJS.ProcessEnv): Env {
  const botToken = required(source.BOT_TOKEN, "BOT_TOKEN");
  const miniAppUrl = required(source.MINI_APP_URL, "MINI_APP_URL");
  const databasePath = source.DATABASE_PATH?.trim() || "./data/mon22r.sqlite";
  const port = source.PORT === undefined || source.PORT.trim() === "" ? 3000 : Number(source.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("PORT is invalid");
  return {
    botToken,
    allowedTelegramIds: parseAllowedIds(source.ALLOWED_TELEGRAM_IDS),
    databasePath,
    miniAppUrl,
    port,
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
