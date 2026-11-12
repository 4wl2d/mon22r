# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/4wl2d/mon22r/security/advisories/new). Include the affected commit, the impact, and a minimal reproduction with made-up data. Keep tokens, Telegram launch data, statements, and ledger entries out of public issues, pull requests, and workflow logs.

Only the latest `main` receives fixes. This is a personal project with no guaranteed response time and no independent audit.

## Deployment boundary

- The bot token is a credential. It lives in `.env` on the server, mode 600, and nowhere else. Rotate it through BotFather if it leaks.
- `ALLOWED_TELEGRAM_IDS` decides who may use the bot and the Mini App. An empty value admits nobody. The Mini App accepts only launch data signed by this bot within the last 24 hours.
- The SQLite database and its backups are financial data. On the server they sit in a Docker volume and a directory readable by the service user only. With the default settings a compressed backup is also sent to the owner's own Telegram chat once a week; set `BACKUP_TO_TELEGRAM=off` to keep backups on the server only.
- The application container runs as an unprivileged user with a read-only root filesystem and no Linux capabilities. Only Caddy is reachable from outside.
- Host access, operating-system patching, and the firewall are the operator's responsibility. Telegram carries messages, files, and launch data; this is not an end-to-end encrypted ledger.
- CSV statements are files you send yourself. The project connects to no bank and stores no banking credentials.

## Pipeline

- Workflows run on GitHub-hosted runners with read-only tokens and actions pinned by commit.
- Tests and the image boot check use made-up data and a local stand-in for the Bot API. The pipeline never holds the bot token or the database.
- The release job holds one credential: an SSH key for the production server, stored as a secret of the `production` environment, which only `main` may use. Pull requests from forks cannot read it. The server address is a secret as well, so it stays out of public logs.
- Release logs are public. The release scripts print no settings, mask anything shaped like a bot token, and the application does not log message text or amounts.
- Dependency, base-image, and action updates arrive as pull requests and pass the same checks before they can be released.

GitHub secret scanning detects supported patterns. It does not guarantee detection of every credential or financial record.
