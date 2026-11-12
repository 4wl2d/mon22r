# Architecture

A TypeScript pnpm workspace with a Telegram bot and a React Mini App sharing one ledger. The production runtime is one Node process plus SQLite; the supplied Compose deployment places Caddy in front of it.

## Actual roots

| Root                                            | Responsibility                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src`                               | Environment parsing, grammY bot, text capture, onboarding, Hono routes, Telegram authentication, month views, plans, and import orchestration.           |
| `apps/miniapp/src`                              | React screens for setup, month, next-month plans, feed, and accounts; API client and Telegram viewport/launch integration.                               |
| `packages/domain/src`                           | Money parsing, transaction invariants, calendar/time-zone calculations, totals, income expectations, FX estimation, and a future bank-adapter interface. |
| `packages/db/src`                               | SQLite connection, Drizzle schema, versioned SQL migrations, and user-scoped repository operations.                                                      |
| `packages/importers/src`                        | CSV parsing and mappings, header fingerprints, preview classification, and statement-line commit logic.                                                  |
| `apps/server/test`, `packages/*/test`           | Vitest tests for auth, capture, contracts, ledger operations, money/month semantics, imports, and undo.                                                  |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Build and manual deployment configuration.                                                                                                               |

The Mini App uses React 19, Vite, and the Telegram Mini Apps SDK. The bot uses grammY, HTTP uses Hono, and persistence uses Drizzle with `better-sqlite3`. UI fonts are Fraunces and IBM Plex Sans.

## Runtime paths

```text
Telegram chat -> grammY allowlist -> onboarding / phrase capture / CSV upload
                                      |
Telegram Mini App -> HTTPS -> Hono /api/* -> signed init data + allowlist
                                      |
                         user-scoped repository operations
                                      |
                        domain rules + SQLite / Drizzle
```

`apps/server/src/main.ts` reads configuration, creates the database directory, opens SQLite, and applies pending migrations. It starts Hono on `0.0.0.0`, configures the bot's web-app menu, and invokes `bot.start()` for long polling. Run a single polling instance per bot token.

The same HTTP application serves the built `apps/miniapp/dist` directory. Non-API GET routes fall back to its `index.html`; API misses return JSON 404s. The asset location defaults to the repository root's working directory. In Compose, Caddy terminates HTTPS and forwards to `app:3000`.

## Access boundary

- The bot middleware checks the sender's numeric Telegram ID against the configured allowlist before handling input.
- `/api/*` requires an `Authorization: tma ...` header. `@tma.js/init-data-node` validates the Telegram signature using the bot token and checks launch data against a 24-hour expiry.
- A valid launch signature still requires an allowed user ID. Missing allowlist configuration fails startup; an empty allowlist grants no access.
- Repository reads and writes are scoped to the internal user ID; ownership and account currency are checked on posting operations.
- Static interface assets are public. Ledger API access is authenticated separately.

These describe implemented controls. They do not constitute a security audit or a guarantee about hosting. Telegram remains part of the message/document transport, and application database encryption is not configured.

## Ledger rules

Money is stored as a safe integer count of currency minor units. Posting amounts are positive magnitudes, with direction and kind describing movement. Currency codes are three uppercase letters; exponent rules cover selected zero- and three-decimal currencies and default to two decimals.

- Transactions represent expense, income, refund, or transfer.
- Transfers are two linked rows written in a database transaction. Their legs are excluded from income, expense, and category-spending totals.
- Refunds reduce expense totals and, when categorized, that category's spending.
- Totals remain grouped by currency. Monthly boundaries are calculated in the user's configured time zone, then used as UTC instants for queries.
- Home-currency estimates use stored rational FX rates without changing original transactions. Missing or invalid rates suppress the estimate. No automatic FX feed or rate-management UI is implemented.

The domain includes a future bank-adapter port in `bank.ts`. It has no implemented bank connector, consent flow, or automatic synchronization in this runtime.

## Plans and capture

Onboarding stores a home currency, time zone, and starter-account choice. Progress is persisted so it can resume after restart.

The chat parser is deterministic and primarily Russian. It recognizes expenses, income, transfers, relative dates, and next-month plans. Category reuse is based on matching previously categorized descriptions. It does not call an AI service.

Income plans are monthly or one-off templates. Applicable plans materialize month-specific expectations, with expected, received, partial, and skipped states. Incoming records can offer an expectation match. The Mini App shows next-month planning and supports status/amount updates. A stored reminder preference has no scheduled delivery worker.

Undo deletes the latest ledger movement, including both linked transfer legs. The feed supports corrections to transaction accounts and categories.

## CSV flow

```text
Upload -> parse headers -> saved mapping or request a mapping
       -> preview new / duplicate / skipped rows
       -> choose a matching-currency account -> explicit commit
```

Column profiles are keyed by user and header fingerprint. Previews classify opening/closing balances, cashback points, and unparseable lines as skipped. Duplicate checks use the user, import source, and external key; a database uniqueness constraint protects the same identity at commit time.

A preview must contain a single currency and target an active matching-currency account. Commit runs transactionally and removes the stored preview. Original CSV file bytes are not stored in SQLite; parsed preview data, profiles, and pending header metadata are persisted.

## Storage and development

SQLite enables foreign keys, a 5-second busy timeout, and WAL for file-backed databases. Schema versions are tracked in `schema_migrations`; startup applies pending versioned SQL inside a transaction. The schema covers users, accounts, categories, transactions, plans, expectations, FX rates, import identities, column profiles, and import previews.

Build dependencies flow from the server's TypeScript project references to the domain, database, and importer packages. Root scripts run TypeScript checks and Vitest; the Mini App build separately typechecks and bundles with Vite. See [setup](SETUP.md) for exact commands, manual deployment, and WAL-aware backup guidance.

[Back to README](../README.md)
