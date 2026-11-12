# Setup

Run your own instance with a dedicated Telegram bot and a domain you control. Use synthetic data while validating a new deployment.

## Requirements

- Node.js **22 or newer** and **pnpm 10.34.9**.
- A Telegram bot token from BotFather, and the numeric Telegram user IDs permitted to use it.
- A public HTTPS origin for the Mini App. The Compose example uses Docker, Docker Compose, and Caddy.
- Persistent storage and an operator-managed backup plan. `better-sqlite3` is a native dependency; a local build may require Python, Make, and a C++ compiler. The Dockerfile provides them.

## Environment

Create a local `.env` in the repository root. `.env.example` is the repository's template; never commit a populated environment file or share a bot token. Replace these example values before launching:

```dotenv
BOT_TOKEN=replace-with-your-bot-token
ALLOWED_TELEGRAM_IDS=123456789
MINI_APP_URL=https://ledger.example.com
DATABASE_PATH=./data/mon22r.sqlite
PORT=3000
DOMAIN=ledger.example.com
```

The numeric ID above is a synthetic placeholder. Telegram usernames are not allowlist IDs.

| Variable               | Required    | Purpose / default                                                                                                                             |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`            | Yes         | Dedicated token issued by BotFather. Used for polling and validating Mini App launch data.                                                    |
| `ALLOWED_TELEGRAM_IDS` | Yes         | Comma-separated numeric IDs. Missing or malformed input prevents startup. An empty string creates an empty allowlist and **denies everyone**. |
| `MINI_APP_URL`         | Yes         | Full public HTTPS URL shown by the bot's Mini App/menu buttons.                                                                               |
| `DATABASE_PATH`        | No          | SQLite file; defaults to `./data/mon22r.sqlite`. Compose overrides it to `/data/mon22r.sqlite`.                                               |
| `PORT`                 | No          | HTTP port; defaults to `3000`. Must be an integer from 1 to 65535.                                                                            |
| `DOMAIN`               | For Compose | Hostname used by Caddy and Compose interpolation. Keep it aligned with `MINI_APP_URL`.                                                        |
| `NODE_ENV`             | No          | The Docker image sets `production`. Not an access-control setting.                                                                            |

The application requires configuration values but does not provision DNS or enforce an HTTPS scheme itself. Configure HTTPS at your reverse proxy.

## Install, verify, and build

From the repository root:

```sh
corepack enable
corepack prepare pnpm@10.34.9 --activate
pnpm install --frozen-lockfile

pnpm typecheck
pnpm test
pnpm --filter @mon22r/server build
pnpm --filter @mon22r/miniapp build
```

These are the exact root verification and package build scripts. There is no root `build` script. The server's TypeScript project references build its workspace dependencies; the Mini App build runs a type check and Vite. No passing result is implied by listing these commands.

Start the built application from the repository root so its default Mini App asset path resolves correctly:

```sh
node --env-file=.env apps/server/dist/main.js
```

Node loads `.env` explicitly. The server's `start` package script alone does not load it. Startup creates the database directory, applies pending migrations, serves the built Mini App and API on `0.0.0.0`, sets the Telegram chat menu button, and starts long polling. Put this HTTP listener behind your HTTPS proxy and firewall it from direct public access.

## Telegram and HTTPS

1. In BotFather, create a dedicated bot with `/newbot` and put its token in `BOT_TOKEN`.
2. Set `ALLOWED_TELEGRAM_IDS` to the intended users' numeric IDs before starting the server.
3. Point your domain's DNS to the deployment host and provide a valid HTTPS endpoint. In the supplied Compose setup, Caddy handles certificates on ports 80 and 443.
4. Set `MINI_APP_URL` to that HTTPS origin. In BotFather, use `/setmenubutton` or **Bot Settings > Menu Button** to set the same URL and the `mon22r` button text. Keep any Main Mini App URL aligned with this domain. The runtime also calls `setChatMenuButton`; review logs if that call fails.
5. Open your bot in a private Telegram chat and send `/start`. Complete the currency, time-zone, and optional starter-account setup, then open `mon22r` from the menu.

The API expects `Authorization: tma <raw Telegram init data>`. A plain browser visit without valid Telegram launch data cannot access ledger endpoints. Signatures and a 24-hour launch-data expiry are checked before the allowlist is applied.

## Manual Docker Compose deployment

The repository includes an application Dockerfile, a two-service Compose file, and a Caddy reverse-proxy configuration. This is a **manual deployment path**, not automated production CD.

With `.env` configured at the repository root:

```sh
docker compose build
docker compose up -d
docker compose logs --tail=100 app caddy
```

The image performs a frozen install and both package builds. `app` exposes port 3000 inside the Compose network without publishing it to the host. `caddy` publishes 80/443 and proxies to `app:3000`. Confirm DNS, TLS, the Telegram menu, and allowlist behavior after deployment.

For an update: back up first, obtain the reviewed source revision, then run `docker compose up -d --build`. Do not run a second local or containerized polling process with the same bot token. There is no webhook receiver or multi-instance coordination in the current runtime.

## Persistence and backups

- A direct Node launch defaults to `./data/mon22r.sqlite`.
- Compose stores the database in the named `sqlite` volume at `/data/mon22r.sqlite`; normal container recreation preserves it.
- Caddy uses separate `caddy-data` and `caddy-config` volumes.
- **Do not use `docker compose down -v`** unless you intend to remove those volumes and their contents.

SQLite uses WAL mode. Recent committed records can be in `mon22r.sqlite-wal`, so copying only the main file while the application is running is unsafe. Use a SQLite-aware online backup tool, or stop all writers cleanly and copy the complete consistent database state. Preserve any accompanying WAL file; do not discard sidecars from an unclean shutdown. Back up the persistent volume, not the container filesystem, and test restoration before trusting a backup. Take a backup before schema migrations and deployment changes.

Database contents, parsed import previews, and backups are sensitive financial data. Protect host access and backup storage. Database-at-rest encryption is not configured by this application. The original CSV file is not stored in SQLite, but its parsed preview rows and column mappings are persisted.

## Local interface work

After building and launching the backend, the existing development script is:

```sh
pnpm --filter @mon22r/miniapp dev
```

Vite proxies `/api` to `http://127.0.0.1:3000`. Keep the dev server local. **Do not expose or tunnel it publicly**; deploy the built static assets through the production server and HTTPS proxy. The backend still requires genuine Telegram authentication and the allowlist.

[Back to README](../README.md) · [Architecture](ARCHITECTURE.md)
