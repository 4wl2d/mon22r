# Contributing

mon22r is an early-stage, self-hosted Telegram ledger. Open a focused issue before proposing a large change. Public source availability does not grant a license; no open-source license has been selected yet.

## Local checks

Use Node.js 22 or 24 and pnpm 10.34.9, as pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @mon22r/server build
pnpm --filter @mon22r/miniapp build
```

The automated tests use synthetic fixtures and temporary/in-memory databases. They do not verify a live Telegram account, internet banking or a production deployment.

## Pull requests

- Branch from `main` and keep the diff focused. Describe behavior changes and how you checked them.
- Preserve currency boundaries, exact money arithmetic, transfer semantics, user isolation and timezone-sensitive month behavior.
- Add regression tests for changed behavior. Use fabricated accounts, dates and transactions in fixtures and screenshots.
- Keep `.env`, database files, bank CSVs, Telegram init data, bot tokens and server identifiers out of the PR. Never paste real financial records into a public issue.
- Update docs when setup or behavior changes. Check both the Mini App and bot when a shared API or domain type changes.
- CI must pass and review conversations must be resolved before merge. A single maintainer can merge their own PR without an independent approval.

See [setup](docs/SETUP.md), [architecture](docs/ARCHITECTURE.md) and the [security policy](.github/SECURITY.md). Report suspected vulnerabilities through the private reporting route rather than a public issue.
