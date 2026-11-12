// A stand-in for the Bot API, used only by the pipeline to boot the built image without reaching Telegram.
// It serves one queued "/start" from the allowed user and writes every method it is asked for to a log file.
// Usage: node deploy/ci/stub-telegram.mjs <port> <log file>
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8081);
const logFile = process.argv[3] ?? "stub-telegram.log";
const queue = [
  {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: "private", first_name: "Pipeline" },
      from: { id: 42, is_bot: false, first_name: "Pipeline" },
      text: "/start",
    },
  },
];
writeFileSync(logFile, "");

function result(method, body) {
  if (method === "getMe") return { id: 1, is_bot: true, first_name: "mon22r", username: "mon22r_pipeline_bot" };
  if (method === "getUpdates") {
    const offset = typeof body.offset === "number" ? body.offset : 0;
    while (queue[0] !== undefined && queue[0].update_id < offset) queue.shift();
    return [...queue];
  }
  if (method === "sendMessage") {
    return {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: { id: body.chat_id, type: "private" },
      text: body.text,
    };
  }
  return true;
}

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const method = /\/bot[^/]+\/(\w+)/.exec(request.url ?? "")?.[1] ?? "";
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      body = {};
    }
    appendFileSync(logFile, `${method} ${typeof body.offset === "number" ? `offset=${body.offset}` : ""}\n`);
    const answer = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: result(method, body) }));
    };
    // An empty poll waits a little, like a long poll, so the log stays short.
    if (method === "getUpdates" && queue.length === 0) setTimeout(answer, 500);
    else answer();
  });
}).listen(port, "0.0.0.0", () => console.info(`stub Bot API on ${port}`));
