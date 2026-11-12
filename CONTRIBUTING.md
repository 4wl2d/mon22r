# Contributing

mon22r is a self-hosted Telegram ledger for one owner. Open a focused issue before proposing a large change. Public source availability does not grant a license; no open-source license has been selected.

## Local checks

Node.js 22 or 24 and pnpm 10.34.9, as pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm verify      # format and lint, typecheck, tests, builds
pnpm format      # apply formatting and safe lint fixes
```

Tests use made-up data, temporary databases, and a local stand-in for the Bot API. They never reach Telegram or a real ledger. `pnpm preview` serves the Mini App on a throwaway ledger for interface work.

## Pull requests

- Branch from `main`, keep the diff focused, and say how you checked the change.
- Keep currencies apart, money exact, transfers out of totals, users isolated, and months on the user's time zone.
- Add a regression test for changed behavior. Use made-up accounts, dates, and amounts in fixtures and screenshots.
- **Migrations are additive.** Add tables, columns with defaults, or indexes, so the previous release still runs on the new schema and a rollback needs no data change. If that is impossible, set `breaksOlderReleases` on the migration and say so in the pull request: rolling such a release back means restoring the pre-deploy backup.
- Keep `.env`, database files, statements, launch data, tokens, and server addresses out of the repository and out of logs.
- Update the docs when setup, operation, or behavior changes.
- Merging to `main` releases to production once the checks pass. A single maintainer may merge their own pull request.

See [setup](docs/SETUP.md), [operations](docs/OPERATIONS.md), [architecture](docs/ARCHITECTURE.md), and the [security policy](.github/SECURITY.md). Report suspected vulnerabilities privately, not in a public issue.
