# Architecture

A TypeScript pnpm workspace: a Telegram bot and a React Mini App sharing one ledger. In production it is one Node process and one SQLite file, with Caddy in front for HTTPS.

## Where things are

| Path | Responsibility |
| --- | --- |
| `apps/server/src/main.ts`, `service.ts` | Process entry and lifecycle: start, signals, fatal exits; database, HTTP, bot, and jobs wired together. |
| `apps/server/src/bot.ts`, `capture.ts`, `phrases.ts`, `entry-view.ts` | Chat handlers, applying a line to the ledger, the phrase grammar, and the confirmation with its buttons. |
| `apps/server/src/copy.ts`, `format.ts`, `month-summary.ts` | Everything the bot says: message texts, amounts and entry lines, and the `/month` summary. |
| `apps/server/src/http.ts`, `auth.ts`, `month-view.ts` | Mini App API, launch-data check, and the month summary both the API and `/month` use. |
| `apps/server/src/jobs.ts`, `backup.ts`, `fx.ts`, `notify.ts`, `health.ts` | Scheduled work, backup and restore, reference rates, owner alerts, liveness. |
| `apps/server/src/tools.ts`, `healthcheck.ts` | Operations commands and the container health probe. |
| `apps/miniapp/src` | Screens (month, entries, settings, setup), shared components and the stylesheet, the API client with response validation, a small read cache, Telegram integration. |
| `packages/domain/src` | Money parsing, transaction rules, calendar months in a time zone, totals, income expectations, FX estimates. |
| `packages/db/src` | SQLite connection, schema, migrations, repository functions scoped to a user, backup primitives. |
| `packages/importers/src` | CSV parsing, column mapping, preview classification, statement-line commit. |
| `deploy/` | Production stack, proxy configuration, release scripts, the pipeline's stand-in Bot API. |

## Runtime

```text
Telegram chat ── long polling ──> grammY ── allowlist ──> onboarding / capture / CSV import
                                                              │
Telegram Mini App ── HTTPS ──> Caddy ──> Hono /api/* ── signed launch data + allowlist
                                                              │
                                              repository functions, scoped to the user
                                                              │
                                                  domain rules + SQLite (WAL)
```

One process does everything, so there is no coordination to get wrong: updates are handled one at a time and SQLite calls are synchronous. Because one slow Bot API call would hold up every update behind it, calls have a 50-second limit and are retried at most twice, a few seconds apart.

**Start.** Read settings, open the database, apply pending migrations, start HTTP, set the bot's menu button and commands, start polling, start the job timer.

**Stop.** On SIGTERM the process stops the jobs, stops the bot (which confirms the handled updates with Telegram), closes HTTP, checkpoints the write-ahead log into the main file, and exits 0. A stop that takes longer than eight seconds exits non-zero.

**Failure.** Fatal conditions — polling refused or ended, an uncaught error, a poll loop silent for three minutes — are logged, reported to the owner at most once per half hour, and end the process with a non-zero code. Docker's restart policy starts it again. A flag in the database tells the next start that the previous run did not stop cleanly, and the owner is told.

## Access

- The bot checks the sender's numeric ID against the allowlist before anything else and ignores group chats.
- `/api/*` requires `Authorization: tma <launch data>`. The signature is checked with the bot token, launch data older than 24 hours is refused, and the user must be on the allowlist.
- Every repository function takes the internal user ID and filters by it. Tests exercise one user's requests against another user's rows.
- Request bodies are limited to 256 KB and validated field by field. Currency codes must be ISO 4217 codes the runtime knows.
- Responses carry a content security policy that allows only this origin's scripts and framing by Telegram's web clients, plus `nosniff`, HSTS, and `no-referrer`. API answers are `no-store`; hashed assets are cached for a year; the page itself is revalidated.
- `/healthz` is public and reveals only liveness, the version, and the time of the last backup.

These are implemented and tested controls, not an audit.

## Ledger rules

Money is an integer count of minor units with a currency code. Amounts are positive; direction and kind carry the meaning.

- Kinds: expense, income, refund, transfer. A transfer is two linked rows written in one database transaction and counted in neither income nor spending. A refund lowers spending in its category.
- Totals are kept per currency. Month boundaries are computed in the user's time zone and queried as UTC instants.
- The home-currency figure is an estimate from the latest stored rate of each pair. It is labeled as one, and stored amounts are never rewritten. With a rate missing, the estimate is omitted.
- Removing a transaction that had closed an income line reopens that line by the removed amount.

## Capture

The grammar is deterministic and Russian. One line becomes an expense, income (`+`), refund (`возврат`), transfer (`перевод`), or plan (`план`), with an optional leading day (`вчера`, `5.11`) and an optional `#category`.

- **Which account.** An amount without a currency goes to the default account, in its currency; without a default, to the home currency. For a currency, the choice is: the default account if it holds that currency, else the account of the last hand-entered line of that currency, else the oldest active one. The confirmation offers the other accounts of that currency as buttons.
- **Which category.** A tag wins and creates the category if needed. Otherwise the category last used for the same note applies; the note key is stored on each row and indexed, so this is one lookup regardless of history size.
- **Transfers.** Accounts are named by any part of their name; several matches are narrowed by currency or reported back. Between currencies the arrived amount is required, because guessing a rate would put a wrong number in the ledger.
- **Exactly once.** The ledger write and a record of the Telegram update ID share one SQLite transaction. An update delivered again after a restart is answered with "already recorded" and writes nothing.
- **Undo.** `/undo` and the button remove the entry (both legs of a transfer) and say what was removed. `/undo` skips imported lines.

**Chat messages.** Every message is sent with Telegram's HTML parse mode: bold for the amount or the title, `<code>` for anything meant to be copied. `copy.ts` and `format.ts` are the only places that build message text, and they escape every name and note that comes from the ledger. Button labels and callback answers are plain text. A confirmation's buttons are ordered by need: categories while the entry has none, the other accounts of its currency, an expected income it could count toward, and undo last. A pressed setup button turns its question into the answer.

Income plans are monthly templates. Each month they apply to gets its own line with a status: expected, received, partial, skipped. An income entry of a similar amount offers to close the matching line; nothing is closed without a tap. A line remembers only the last entry that was matched to it, so when a line was filled by several partial entries, removing an earlier one does not reopen it; set its status by hand in that case.

## CSV import

```text
file → header → saved column profile, or ask for one
     → preview: new / duplicate / skipped
     → account of the file's currency → confirm → commit
```

Profiles are keyed by the header. Duplicates are recognized by user, profile, and the line's external key, and a unique index enforces that at commit. Commit runs in one transaction and removes the stored preview; previews never committed are deleted after a week. The uploaded file itself is not stored.

## Storage and migrations

SQLite with foreign keys, a five-second busy timeout, and WAL. `schema_migrations` lists applied migrations; pending ones are applied in one transaction at start.

Migrations are append-only and, by default, **additive**: the previous release must keep working on the new schema, so a release can be rolled back without touching data. A migration that breaks that sets `breaksOlderReleases`; the database then stores a compatibility floor in `PRAGMA user_version`, and a build that knows fewer migrations than the floor refuses to start. Tests cover an in-place upgrade from the first release's schema, writes made the way the previous release makes them, and the refusal.

Backups use SQLite's online backup API, are converted to a single file, checked with `PRAGMA integrity_check`, and gzip-compressed. See [operations](OPERATIONS.md#backups).

## Mini App

React 19 with Vite. The Telegram SDK supplies launch data, viewport insets as CSS variables, haptics, and external links; nothing is loaded from other origins. The API client validates every answer before use, gives each call a time limit, and retries a failed read once but never a write.

Reads go through a small in-memory cache keyed by month: a screen shows cached data at once and refreshes in the background, and returning from the chat refreshes what is on screen. Opening the app costs two requests; the entries screen costs one.

**Interface.** One stylesheet defines the system: a light and a dark palette as CSS variables, chosen from the Telegram client's theme (the system's outside Telegram) and mirrored onto the client chrome; one accent that marks what can be acted on; surfaces with rows; controls at least 44px tall. Anything that can be changed opens in a sheet, which is a native modal `<dialog>`: focus stays inside, and Escape, the scrim, the close control, and Telegram's back button close it. The sheet sits above the on-screen keyboard through the visual viewport. An action that finishes closes its sheet and is confirmed by a toast. The month headline needs spending and income in the home currency, so the month view carries those two estimates next to the net.

## Delivery

The pipeline, the release procedure, rollback, and recovery are described in [operations](OPERATIONS.md). In short: the image that passed the tests, the self-check, and a real boot is the file that reaches the server, identified by its SHA-256 and its commit label, and it becomes current only after it reports healthy as that commit.

[Back to README](../README.md) · [Setup](SETUP.md) · [Operations](OPERATIONS.md)
