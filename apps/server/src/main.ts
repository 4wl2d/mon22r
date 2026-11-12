import { dirname, join } from "node:path";

import { type Env, readEnv } from "./env.js";
import { createLogger, errorFields } from "./log.js";
import { alertOwner } from "./notify.js";
import { type Service, startService } from "./service.js";

const STOP_LIMIT_MS = 8_000;

const env = readSettings();
const log = createLogger({ secrets: [env.botToken] });
let service: Service | null = null;
let exiting = false;

/** A wrong setting is the operator's to fix: one clear line instead of a stack trace, then a non-zero exit. */
function readSettings(): Env {
  try {
    return readEnv(process.env);
  } catch (error) {
    createLogger().error("settings are invalid", { reason: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

/** Logs, tells the owner, and exits non-zero so the container's restart policy brings the service back. */
async function fatal(reason: string, error?: unknown): Promise<void> {
  if (exiting) return;
  exiting = true;
  log.error(reason, error === undefined ? undefined : errorFields(error));
  await alertOwner({
    token: env.botToken,
    chatId: [...env.allowedTelegramIds][0],
    message: `mon22r остановился: ${reason}. Сервис перезапустится сам. Если сообщение повторяется, смотрите журнал сервера.`,
    markerPath: join(dirname(env.databasePath), ".last-alert"),
    apiRoot: env.telegramApiRoot,
  });
  process.exit(1);
}

async function stop(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  log.info("stopping", { signal });
  const limit = setTimeout(() => {
    log.error("stop timed out");
    process.exit(1);
  }, STOP_LIMIT_MS);
  limit.unref();
  await service?.stop();
  process.exit(0);
}

process.on("uncaughtException", (error) => void fatal("uncaught exception", error));
process.on("unhandledRejection", (error) => void fatal("unhandled rejection", error));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

try {
  service = await startService(env, { log, onFatal: (reason, error) => void fatal(reason, error) });
} catch (error) {
  await fatal("start failed", error);
}
