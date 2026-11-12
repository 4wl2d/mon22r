<p align="center">
  <img src="docs/assets/hero.svg" alt="mon22r. Self-hosted Telegram ledger." width="1280" />
</p>

<p align="center">
  <a href="https://github.com/4wl2d/mon22r/actions/workflows/ci.yml"><img src="https://github.com/4wl2d/mon22r/actions/workflows/ci.yml/badge.svg" alt="CI workflow status" /></a>
  <a href="https://github.com/4wl2d/mon22r/security/code-scanning"><img src="https://img.shields.io/badge/CodeQL-code%20scanning-a68445?style=flat&amp;labelColor=252820" alt="CodeQL code scanning" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-a68445?style=flat&amp;labelColor=252820" alt="TypeScript 5.9" />
  <img src="https://img.shields.io/badge/self--hosted-SQLite-a68445?style=flat&amp;labelColor=252820" alt="Self-hosted with SQLite" />
</p>

# mon22r

A small personal-finance ledger for Telegram. Capture everyday spending in chat, review a calendar month in a Mini App, and keep upcoming income in view. You run the server and own its SQLite storage.

The interface pairs warm brass, quiet dark surfaces, and serif typography. The ledger underneath keeps amounts in integer minor units and each currency separate.

**[Set up your instance](docs/SETUP.md)** · **[Explore the architecture](docs/ARCHITECTURE.md)**

## What it does

- **Capture in chat.** Rule-based text entry for expenses, income, transfers, and next-month income plans, with category/match actions and `/undo`.
- **Review the month.** Income, expenses, net movement, and category spending by currency, using your configured time zone.
- **Plan incoming money.** Monthly or one-off income plans with expected, partial, received, and skipped states.
- **Keep accounts organized.** Create, rename, archive, and restore currency-specific accounts. Correct transaction accounts and categories in the feed.
- **Handle ledger details.** Paired transfers stay outside income and spending totals. Refunds reduce spending.
- **Import deliberately.** Upload CSV, save column mappings, preview new, duplicate, and skipped rows, then confirm the import into a matching-currency account.
- **Host a private instance.** Telegram user-ID allowlisting applies to both the bot and Mini App API. An empty allowlist denies everyone.

## Quick start

Requires **Node.js 22+** and **pnpm 10.34.9**. Create a bot with BotFather and read the [setup guide](docs/SETUP.md) for configuration, HTTPS, and the Telegram menu.

```sh
corepack enable
corepack prepare pnpm@10.34.9 --activate
pnpm install --frozen-lockfile

pnpm typecheck
pnpm test
pnpm --filter @mon22r/server build
pnpm --filter @mon22r/miniapp build

# After creating and configuring .env; run from the repository root.
node --env-file=.env apps/server/dist/main.js
```

The server serves both `/api/*` and the built Mini App. For a public deployment, use the documented [manual Docker Compose setup](docs/SETUP.md#manual-docker-compose-deployment) with Caddy and a domain you control.

## A compact stack

```text
apps/miniapp       React 19 + Vite + Telegram Mini Apps SDK
apps/server        grammY bot + Hono HTTP API
packages/domain    Money, transactions, months, plans, FX estimates
packages/db        Drizzle + better-sqlite3 + versioned migrations
packages/importers CSV parsing, mapping, preview, duplicate handling
```

One Node process runs the HTTP server and a long-polling bot. SQLite persists the ledger; Caddy terminates HTTPS in the Compose deployment. See [architecture](docs/ARCHITECTURE.md) for the request and import paths.

## Early-stage boundaries

This is an early-stage, self-hosted project. Review it and test with synthetic data before relying on it for important records.

- The current bot copy, phrase grammar, and Mini App interface are primarily Russian.
- Entry is manual or CSV-based. There are no implemented bank integrations, automatic bank synchronization, or AI features.
- Home-currency totals are labeled estimates and need stored FX reference rates. There is no automatic rate feed or rate-management interface.
- A reminder preference exists in the model; scheduled reminder delivery is not implemented.
- Telegram transports bot messages and uploaded documents. Self-hosting controls the application server and database, not Telegram's infrastructure.
- The allowlist and signed Mini App authentication are implemented controls, not an audited-security claim. Deployment hardening and backups are the operator's responsibility.
- Keep one active polling instance per bot token. Never expose the Mini App development server publicly.

The commands above are the repository's verification steps. CI status is shown by the workflow badge; the CodeQL badge links to code-scanning results.

No open-source license has been selected. All rights reserved.
