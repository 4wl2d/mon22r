# Setup

How to run your own instance: a Telegram bot, a small Linux server with Docker, and a name that resolves to it. Try a new instance with made-up data first.

For what happens after setup (releases, backups, restore, troubleshooting) see [operations](OPERATIONS.md).

## What you need

- A bot token from BotFather and your numeric Telegram user ID.
- A Linux server with Docker and the Compose plugin, ports 80 and 443 open, and a DNS name pointing at it. A name from a service such as sslip.io works when you have no domain; a domain you own does not depend on that service staying up.
- For releases from the pipeline: this repository on GitHub with Actions enabled.
- For local work: Node.js 22 or 24 and pnpm 10.34.9.

The reference deployment is a 1-CPU arm64 virtual machine. The image is built for arm64 by the pipeline; on another architecture change `runs-on` of the `image` job in `.github/workflows/ci.yml` to a runner of that architecture.

## Settings

All settings are environment variables, kept in one `.env` file on the server (mode 600). `.env.example` is the template.

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | yes | Token from BotFather. Used for polling and for checking Mini App launch data. |
| `ALLOWED_TELEGRAM_IDS` | yes | Comma-separated numeric IDs. The first one is the owner: it receives alerts and backup copies. An empty value admits nobody. |
| `MINI_APP_URL` | yes | Public `https://` address of the Mini App. |
| `DOMAIN` | yes on the server | Host name Caddy serves and obtains a certificate for. Must match `MINI_APP_URL`. |
| `DATABASE_PATH` | no | SQLite file. Default `./data/mon22r.sqlite`; the stack sets `/data/mon22r.sqlite`. |
| `PORT` | no | HTTP port, default `3000`. |
| `BACKUP_DIR` | no | Where backups go. Default `backups` next to the database; the stack sets `/backups`. |
| `BACKUP_KEEP` | no | Daily backups kept on disk, default `14`. |
| `BACKUP_TO_TELEGRAM` | no | `on` (default) sends a backup file to the owner's chat weekly when the ledger changed. `off` keeps backups on the server only. |
| `FX_REFRESH` | no | `on` (default) fetches reference rates once a day for the home-currency estimate. `off` leaves the estimate out unless rates already exist. |
| `TELEGRAM_API_ROOT` | no | Address of a local Bot API server. Tests and the pipeline point it at a stand-in. |
| `APP_VERSION` | no | Set by the image build to the commit. Reported by `/healthz`. |

The token is a credential: it lives only in `.env` on the server. The pipeline does not have it and does not need it.

## Telegram

1. Create a bot with `/newbot` in BotFather and put the token in `BOT_TOKEN`.
2. Put your numeric ID in `ALLOWED_TELEGRAM_IDS`. A username is not an ID.
3. Start the service (below), open a private chat with the bot, and send `/start`. It asks for the home currency, the time zone, and whether to create starter accounts.

On every start the service sets the bot's menu button to `MINI_APP_URL` and its command list to `/month`, `/undo`, `/help`. Nothing needs to be configured in BotFather for that.

Run exactly one instance per token. Two processes polling the same bot make Telegram refuse one of them, which the service treats as fatal and reports.

## Server

Prepare the server once. From a checkout on your computer:

```sh
scp -r deploy/server <user>@<server>:/tmp/mon22r-bootstrap
ssh <user>@<server> 'bash /tmp/mon22r-bootstrap/bootstrap.sh'
```

`bootstrap.sh` creates `/opt/mon22r`, installs the release scripts into `/opt/mon22r/bin`, and never overwrites an existing `.env`. Then create the settings file:

```sh
ssh <user>@<server>
umask 077
cat > /opt/mon22r/.env    # paste the four required settings, then Ctrl-D
```

Layout on the server:

```text
/opt/mon22r/.env         settings and the token, mode 600
/opt/mon22r/compose.yml  active stack, copied from the current release
/opt/mon22r/Caddyfile    active proxy configuration
/opt/mon22r/releases/    what each installed release shipped
/opt/mon22r/backups/     database backups
/opt/mon22r/bin/         deploy, rollback, backup, restore, status, compose
```

The database lives in the Docker volume `mon22r_sqlite`, certificates in `mon22r_caddy-data`. Do not run `docker compose down -v`: `-v` deletes both.

## Releases from the pipeline

Every push to `main` that passes all checks is released automatically. One-time wiring:

1. Create a key pair for the pipeline and authorize its public half on the server:

   ```sh
   ssh-keygen -t ed25519 -N '' -C mon22r-deploy -f ./mon22r-deploy
   ssh <user>@<server> "bash /opt/mon22r/bin/bootstrap.sh --deploy-key '$(cat mon22r-deploy.pub)'"
   ```

2. In the repository settings create the environment **production**, restrict its deployment branches to `main`, and add these environment secrets:

   | Secret | Value |
   | --- | --- |
   | `DEPLOY_SSH_KEY` | Contents of the private key file `mon22r-deploy`. |
   | `DEPLOY_HOST` | Server address. |
   | `DEPLOY_USER` | Server user that ran `bootstrap.sh`. |
   | `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <server>`, after comparing it with the key you already trust. |

   Delete the local private key file once it is stored.

3. Add the **repository** secret `HEALTHCHECK_URL` with the value `https://<domain>/healthz`. The monitor reads it; keeping it a secret keeps the address out of public logs.

4. Set the repository variables `DEPLOY_ENABLED=true` and `MONITOR_ENABLED=true`. Until `DEPLOY_ENABLED` is set, merges build and test the image but release nothing.

5. Protect `main` so changes enter only through a pull request whose `Validate` and `Image` checks passed.

What a release does is described in [operations](OPERATIONS.md#releases).

## Releasing by hand

The same scripts work without the pipeline, from any machine with Docker of the server's architecture:

```sh
sha=$(git rev-parse HEAD)
docker build --build-arg APP_VERSION=$sha -t mon22r:$sha .
mkdir release && docker save mon22r:$sha | gzip > release/image.tar.gz
(cd release && sha256sum image.tar.gz > image.sha256)
cp deploy/compose.yml deploy/Caddyfile deploy/server/*.sh release/
scp -r release <user>@<server>:/opt/mon22r/incoming/$sha
ssh <user>@<server> "bash /opt/mon22r/incoming/$sha/deploy.sh $sha /opt/mon22r/incoming/$sha"
```

## Local work

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify            # format and lint, typecheck, tests, builds: the same gates as the pipeline
pnpm format            # apply formatting and safe lint fixes
pnpm preview           # build, then serve the Mini App on a throwaway ledger
pnpm bench             # server timings on a synthetic ledger of 10 000 entries
```

`pnpm preview` prints an address that carries launch data signed with a made-up token, the way Telegram passes it. No bot runs and no real data is involved. `node apps/server/scripts/preview.mjs --empty` shows a ledger with accounts only, `--fresh` the first-run setup.

To run the whole service locally, give it its own bot token, never the production one: two instances on one token knock each other out.

```sh
pnpm build
node --env-file=.env apps/server/dist/main.js
```

[Back to README](../README.md) · [Operations](OPERATIONS.md) · [Architecture](ARCHITECTURE.md)
