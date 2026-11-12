# mon22r

Личный Telegram-бот и мини-приложение для учёта денег. Пароли банков и сессии интернет-банка не хранятся.

## Что в репозитории

- `apps/server` — бот на grammY и HTTP на Hono
- `apps/miniapp` — Telegram Mini App на React и Vite: месяц, следующий месяц, лента и счета
- `packages/domain` — счета, суммы и календарный месяц
- `packages/db` — SQLite через Drizzle
- `packages/importers` — чтение CSV
- `Dockerfile`, `docker-compose.yml` и `Caddyfile` — образ приложения и прокси

Нужны Node.js 22 или новее и pnpm 10.34.9. Шаблон переменных — `.env.example`. Локальный `.env` в репозиторий не входит. База по умолчанию: `./data/mon22r.sqlite`.

Из корня:

```sh
pnpm typecheck
pnpm test
```

Сборка сервера и мини-приложения:

```sh
pnpm --filter @mon22r/server build
pnpm --filter @mon22r/miniapp build
```
