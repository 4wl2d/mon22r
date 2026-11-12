# Operations

Running the service after [setup](SETUP.md): releases, rollback, backups, restore, monitoring, and what to do when something is wrong. Commands are run on the server unless stated otherwise.

```sh
/opt/mon22r/bin/status.sh        # release, containers, health, backups, disk, recent log
/opt/mon22r/bin/compose.sh ...   # docker compose for the current release, e.g. logs -f app
```

Use `compose.sh` instead of plain `docker compose`: it supplies the image of the current release.

## Releases

A push to `main` runs the pipeline. Nothing is released unless every step before it passed.

1. **Validate**, on Node 22 and 24: dependency audit, format and lint, shellcheck, typecheck, tests, builds.
2. **Image**, on arm64: build the image with the commit as its version, run its self-check (native SQLite, migrations, a capture, a backup round trip, packaged Mini App), boot it against a stand-in Bot API, require `/healthz` to report healthy as this commit, and stop it cleanly. The image is then packed with its SHA-256.
3. **Release to production**, one at a time, never cancelled midway:
   - superseded runs skip deployment when their commit is no longer the tip of `main`;
   - the server checks the file against its SHA-256, loads it, and checks that its label names this commit;
   - the old process stops gracefully, confirming handled updates with Telegram and checkpointing the database;
   - a verified backup is written (`mon22r-pre-deploy-…`), including those final writes. If it cannot be written, the previous service is resumed and the release fails;
   - the stack switches to the new image; requests arriving during the switch wait in the proxy for up to 10 seconds;
   - the release counts only when the application reports healthy **as this commit**, inside the container and through the public address.

If the new version is not healthy within two minutes, the previous release is started again, the run fails, and the owner gets a Telegram message saying which version is running.

The version in use is always visible: `status.sh`, `https://<domain>/healthz`, and the bottom of the Mini App's settings. Both the internal and proxy checks require that exact version and a working poll loop; a 200 response containing the old Mini App page does not pass.

To retry the current `main` release, run **CI** manually with branch `main`. The same validation and image tests run first. A manual run on another branch never gets production credentials or deploys.

## Rollback

**Through GitHub:** Actions → *Roll back production* → Run workflow, type `rollback`.

**On the server:**

```sh
/opt/mon22r/bin/rollback.sh
```

Both start the previous release again and wait for it to report healthy. The current and the previous image stay on the server, so a rollback needs no build and no network. Running it twice returns to where you were.

### Rollback and the database

A rollback switches the program, not the data. Whether that is safe is decided by the migration rule every change follows:

- A migration may only **add** (tables, columns with defaults, indexes). The previous release then keeps working on the newer schema, and rollback needs nothing else. Tests keep this true for the releases so far: a database migrated to the newest schema is written to the way the previous release writes.
- A migration that the previous release cannot live with must be marked `breaksOlderReleases`. The database then records a compatibility floor, and an older build **refuses to start** on it with a message that names the cause, instead of writing to a schema it does not understand.

When a release with such a migration fails its health check, the automatic rollback notices that the previous release does not start, restores the backup taken before the release, and starts the previous release on it. The replaced database files are kept (see below). Doing the same by hand:

```sh
/opt/mon22r/bin/rollback.sh                      # says the schema is too new
/opt/mon22r/bin/restore.sh mon22r-pre-deploy-<time>.sqlite.gz
```

Entries made between the release and the restore are not in the restored database. They are still in the files moved aside by the restore, and in your chat history.

## Backups

| Kind | When | Kept |
| --- | --- | --- |
| `mon22r-daily-…` | Once a day by the application, first one within a minute of start | newest 14 (`BACKUP_KEEP`) |
| `mon22r-pre-deploy-…` | Before every release | newest 5 |
| `mon22r-manual-…` | `/opt/mon22r/bin/backup.sh` | newest 10 |
| Copy in your Telegram chat | Weekly, only if the ledger changed since the last copy | as long as the chat keeps it |

Every backup is made with SQLite's online backup, so it is consistent while the application is writing, and is checked with `PRAGMA integrity_check` before it gets its name. A file named `mon22r-…sqlite.gz` is a complete single-file database, gzip-compressed.

Backups on the server protect against a bad release or a mistake. The weekly copy in Telegram protects against losing the server. If you prefer no copy in Telegram, set `BACKUP_TO_TELEGRAM=off` and copy `/opt/mon22r/backups` elsewhere on a schedule of your own.

A failed backup is logged, reported to the owner in Telegram, and retried after 30 minutes. `/healthz` shows `lastBackupAt`.

## Restore

To restore on the same server:

```sh
ls /opt/mon22r/backups
/opt/mon22r/bin/restore.sh mon22r-daily-<time>.sqlite.gz     # or: restore.sh latest
```

The script verifies the backup first and changes nothing if it is damaged. Then it stops the application, moves the current database files aside inside the data volume as `mon22r.sqlite.before-restore-<time>`, puts the backup in place, starts the application, and waits for it to report healthy. Migrations newer than the backup are applied on start.

To restore on a **new** server: complete [setup](SETUP.md) up to a first release, then

```sh
scp mon22r-<kind>-<time>.sqlite.gz <user>@<server>:/opt/mon22r/backups/
ssh <user>@<server> /opt/mon22r/bin/restore.sh mon22r-<kind>-<time>.sqlite.gz
```

A file from the Telegram chat is the same kind of file: download it and proceed as above.

To look inside a backup without restoring it:

```sh
gunzip -c mon22r-daily-<time>.sqlite.gz > check.sqlite && sqlite3 check.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM transactions;'
```

Undoing a restore: stop the application (`compose.sh stop app`), move `mon22r.sqlite.before-restore-<time>` back to `mon22r.sqlite` inside the volume, start it again. Remove old `before-restore` files once you no longer need them; they are full copies.

## Monitoring and alerts

| Signal | Where it shows | What it means |
| --- | --- | --- |
| `/healthz` | `https://<domain>/healthz`, Docker health status | `ok` is false when the database cannot be read or polling has made no round for three minutes. |
| Telegram message "перезапущен после сбоя" | Owner's chat | The previous run ended without a clean stop: crash, kill, or power loss. Check the last entries with `/month`. |
| Telegram message "остановился: …" | Owner's chat | The process hit a fatal condition and exited; Docker restarts it. At most one such message per 30 minutes. |
| Telegram message about a release | Owner's chat | A release failed its checks; says which version is running. |
| Telegram message "Резервная копия не удалась" | Owner's chat | See the log; usually disk space or permissions on `/opt/mon22r/backups`. |
| Failed *Monitor* run | GitHub notification e-mail | The public address did not report healthy three times in a row, or the certificate expires within 10 days. Covers the case where the whole server is down and cannot send anything itself. |
| Failed *CI* run on `main` | GitHub notification e-mail | A release did not go out or was rolled back. |

GitHub disables scheduled workflows in a repository with no activity for 60 days. Merging a dependency update counts as activity; otherwise re-enable *Monitor* on the Actions page.

The service recovers by itself from a crash (Docker restart policy), a stalled poll loop (the watchdog exits the process so it restarts), a reboot (Docker starts on boot), and Telegram or network errors (calls are retried, polling reconnects).

## Logs

```sh
/opt/mon22r/bin/compose.sh logs --since 1h app
/opt/mon22r/bin/compose.sh logs --since 1h app | grep '"level":"error"'
```

One JSON object per line: `time`, `level`, `message`, and fields. Requests are logged with method, route, status, and duration. Message text, notes, amounts, and launch data are never logged, and the bot token is masked if it ever appears in an error. Docker keeps five files of 10 MB per container.

## Troubleshooting

| Symptom | Check | Fix |
| --- | --- | --- |
| Bot does not answer | `status.sh`: is `app` running and healthy? | If it restarts in a loop, read the log for the reason. `polling failed` with 409 means a second instance uses the token: stop it. With 401 the token is wrong or revoked: fix `BOT_TOKEN` in `.env`, then `compose.sh up -d`. |
| Bot answers "Сбой, ничего не записано" | Error lines in the log at that time | Nothing was written. Send the line again; if it repeats, the log has the stack. |
| Bot answers "Это сообщение уже записано" | — | Telegram delivered the message again after a restart. The entry exists once; nothing to do. |
| Mini App says "Сессия истекла" | — | Launch data is valid for 24 hours. Close the Mini App and open it from the chat. |
| Mini App does not open at all | `curl -I https://<domain>/` | No answer: is `caddy` running, are ports 80 and 443 open, does the name resolve to the server? Certificate errors: `compose.sh logs caddy`. |
| Month shows no single total | `/healthz` is fine, estimate missing | Rates are fetched once a day; the log has `rates not refreshed` if the rate service fails. Totals per currency are unaffected. |
| Release failed | The failed run's log; `status.sh` | The previous version is running. Fix forward with a new commit. |
| Process refuses to start: "Database needs schema version …" | — | An older image was started on a newer database. Release a newer version, or restore the pre-deploy backup. |
| Disk filling up | `status.sh`, `docker system df` | `docker image prune` removes unused images; old `before-restore` files and backups can be deleted. |

## Routine

- **Token rotation:** `/revoke` in BotFather, put the new token in `/opt/mon22r/.env`, `compose.sh up -d`. Launch data signed with the old token stops working at once.
- **Deploy key rotation:** generate a new pair, add the public key with `bootstrap.sh --deploy-key`, replace the `DEPLOY_SSH_KEY` secret, remove the old line from `~/.ssh/authorized_keys`.
- **Dependency updates** arrive weekly as pull requests, including the base image digest and Caddy. They pass the same gates and release like any change.
- **Operating system updates** are the server owner's job. A reboot is safe: the stack starts again by itself.
- **Restore drill:** once in a while, run the "look inside a backup" command above on the newest file from the Telegram chat.

[Back to README](../README.md) · [Setup](SETUP.md) · [Architecture](ARCHITECTURE.md)
