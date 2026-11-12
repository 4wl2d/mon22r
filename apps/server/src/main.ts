import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { serve } from "@hono/node-server";
import { migrate, openDatabase } from "@mon22r/db";

import { createBot } from "./bot.js";
import { readEnv } from "./env.js";
import { createApp } from "./http.js";

const env = readEnv(process.env);
if (env.databasePath !== ":memory:") mkdirSync(dirname(env.databasePath), { recursive: true });
const db = openDatabase(env.databasePath);
migrate(db);

const app = createApp({
  db,
  botToken: env.botToken,
  allowed: env.allowedTelegramIds,
});
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: env.port });

const bot = createBot({
  token: env.botToken,
  db,
  allowed: env.allowedTelegramIds,
  miniAppUrl: env.miniAppUrl,
});

await bot.api
  .setChatMenuButton({
    menu_button: {
      type: "web_app",
      text: "mon22r",
      web_app: { url: env.miniAppUrl },
    },
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "menu");
  });

void bot.start();
