# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/4wl2d/mon22r/security/advisories/new) for security issues. Include the affected commit, impact and a minimal reproduction using synthetic data. Keep tokens, Telegram init data, bank statements and personal ledger entries out of public issues, PRs and workflow logs.

Only the latest `main` branch receives security fixes. This is an early-stage personal project with no guaranteed response time or independent security audit.

## Deployment boundary

- The Telegram bot token is a credential. Keep it in a private `.env` or your secret manager and rotate it through BotFather if exposed.
- Set `ALLOWED_TELEGRAM_IDS` explicitly. An empty list grants access to nobody. The Mini App validates Telegram-signed init data and the allowlist; bot conversations are limited to private chats.
- The SQLite database, backups and bank CSVs contain sensitive financial information. Protect them on disk and keep them out of Git history, images, artifacts and issue attachments.
- HTTPS, host access, database backup/recovery and container patching remain the operator's responsibility. Telegram carries messages and Mini App authentication data; this is not an end-to-end encrypted ledger.
- CSV imports are operator-provided files. The project does not connect to an internet bank or store banking credentials.

## Repository checks

CI uses hosted runners, read-only default tokens, SHA-pinned Actions and synthetic/in-memory tests. It does not receive a live bot token, production database or server key. Dependency updates require review and passing checks; production deployment remains manual.

GitHub secret scanning detects supported patterns. It does not guarantee detection of every credential or financial record.
