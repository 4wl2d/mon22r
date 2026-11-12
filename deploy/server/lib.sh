#!/usr/bin/env bash
# Shared pieces of the release scripts. Sourced, not run.
# Layout under $MON22R_ROOT (default /opt/mon22r):
#   .env                 application settings and the bot token, mode 0600, never replaced by a release
#   compose.yml          active stack definition, copied from the current release
#   Caddyfile            active proxy configuration, copied from the current release
#   releases/<sha>/      what each release shipped: compose.yml, Caddyfile, and the image tag
#   current, previous    names of the active release and the one before it
#   backups/             database backups, written by the application and by releases
#   bin/                 these scripts

set -euo pipefail

# MON22R_ROOT, MON22R_PROJECT and MON22R_PUBLIC_CHECK exist so the whole procedure can be rehearsed next to a
# live stack, under another directory and project name, without touching it.
ROOT="${MON22R_ROOT:-/opt/mon22r}"
PROJECT="${MON22R_PROJECT:-mon22r}"
DATA_VOLUME="${PROJECT}_sqlite"
APP_PATH_IN_IMAGE="apps/server/dist/tools.js"
HEALTH_TIMEOUT="${MON22R_HEALTH_TIMEOUT:-120}"
# Where the stack lived before releases were introduced. Used once, to roll the very first release back.
# shellcheck disable=SC2034  # read by the scripts that source this file
LEGACY_DIR="${MON22R_LEGACY_DIR:-$HOME/mon22r}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

# Docker needs root unless the user is in the docker group. Either way works.
if docker info >/dev/null 2>&1; then
  SUDO=()
else
  SUDO=(sudo -n)
fi

dock() {
  "${SUDO[@]}" docker "$@"
}

release_name() {
  local file="$ROOT/$1"
  [[ -f "$file" ]] || return 1
  tr -d '[:space:]' <"$file"
}

release_image() {
  local name="$1"
  tr -d '[:space:]' <"$ROOT/releases/$name/image"
}

# Runs docker compose for the active release. The image tag reaches compose through the environment.
compose() {
  local name image
  name="$(release_name current)" || die "no current release in $ROOT"
  image="$(release_image "$name")"
  "${SUDO[@]}" env "MON22R_IMAGE=$image" docker compose \
    --project-name "$PROJECT" --project-directory "$ROOT" -f "$ROOT/compose.yml" "$@"
}

# Copies a release's stack definition into place. The Caddyfile is overwritten in place, not replaced:
# the running proxy has that exact file mounted and must see the new content.
# Every step is checked explicitly: callers run these functions inside `if`, where bash does not stop on errors.
activate() {
  local name="$1"
  [[ -f "$ROOT/releases/$name/image" ]] || die "release $name is not installed"
  cp "$ROOT/releases/$name/compose.yml" "$ROOT/compose.yml" || return 1
  cat "$ROOT/releases/$name/Caddyfile" >"$ROOT/Caddyfile" || return 1
  printf '%s\n' "$name" >"$ROOT/current" || return 1
}

data_volume_exists() {
  dock volume inspect "$DATA_VOLUME" >/dev/null 2>&1
}

# Makes the database files belong to the user the image runs as. Releases changed that user once
# (root before, an unprivileged user since), and a rollback has to change it back.
own_data() {
  local image="$1" uid gid
  data_volume_exists || return 0
  uid="$(dock run --rm --network none --entrypoint id "$image" -u)" || return 1
  gid="$(dock run --rm --network none --entrypoint id "$image" -g)" || return 1
  dock run --rm --network none --user 0:0 -v "$DATA_VOLUME:/data" --entrypoint chown "$image" \
    -R "$uid:$gid" /data || return 1
  log "database files owned by $uid:$gid"
}

database_exists() {
  local image="$1"
  data_volume_exists || return 1
  dock run --rm --network none --user 0:0 -v "$DATA_VOLUME:/data" --entrypoint test "$image" -f /data/mon22r.sqlite
}

# Runs the operations tool of an image against the data volume, without the bot token and without network.
tool() {
  local image="$1"
  shift
  dock run --rm --network none --user 0:0 \
    -v "$DATA_VOLUME:/data" -v "$ROOT/backups:/backups" \
    -e DATABASE_PATH=/data/mon22r.sqlite -e BACKUP_DIR=/backups \
    "$image" node "$APP_PATH_IN_IMAGE" "$@"
}

# The tool runs as root so it can read any release's files; hand its output to the user the application runs as,
# which also writes the daily backups into the same directory.
own_backups() {
  local image="$1" uid gid
  uid="$(dock run --rm --network none --entrypoint id "$image" -u)" || return 1
  gid="$(dock run --rm --network none --entrypoint id "$image" -g)" || return 1
  dock run --rm --network none --user 0:0 -v "$ROOT/backups:/backups" --entrypoint chown "$image" \
    -R "$uid:$gid" /backups || return 1
}

# Container id of a service of the active release, or nothing when it does not exist.
service_container() {
  compose ps -q "$1" 2>/dev/null | head -n 1 || true
}

app_container() {
  service_container app
}

health_json() {
  local container
  container="$(app_container)"
  [[ -n "$container" ]] || return 1
  dock exec "$container" node -e \
    "fetch('http://127.0.0.1:3000/healthz').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))"
}

# Waits until the application reports healthy and, when a version is given, that it is that version.
# A release older than /healthz answers with the page instead of JSON; that counts as healthy, version unknown.
wait_healthy() {
  local expected="${1:-}" deadline=$((SECONDS + HEALTH_TIMEOUT)) body=""
  while ((SECONDS < deadline)); do
    if body="$(health_json 2>/dev/null)"; then
      if [[ -z "$expected" || "$body" != \{* ]]; then
        return 0
      fi
      if [[ "$body" == *"\"version\":\"$expected\""* && "$body" == *'"ok":true'* ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  log "not healthy after ${HEALTH_TIMEOUT}s. Last answer: ${body:0:300}"
  return 1
}

# The same check from outside the stack: through Caddy, with TLS, by the public name.
wait_public() {
  local domain deadline=$((SECONDS + 60))
  [[ "${MON22R_PUBLIC_CHECK:-on}" != "off" ]] || return 0
  domain="$(setting DOMAIN)"
  [[ -n "$domain" ]] || die "DOMAIN is not set in $ROOT/.env"
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  # The name is left out on purpose: this output can end up in a public pipeline log.
  log "the public address did not answer through the proxy"
  return 1
}

# Applies a changed Caddyfile without dropping connections. An invalid file is rejected and the old one stays active.
reload_proxy() {
  local container
  container="$(service_container caddy)"
  [[ -n "$container" ]] || return 0
  dock exec "$container" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || log "proxy reload skipped"
}

# Recent application log lines with anything shaped like a bot token masked.
recent_logs() {
  compose logs --no-color --tail "${1:-60}" app 2>&1 | sed -E 's/[0-9]{6,12}:[A-Za-z0-9_-]{30,}/[redacted]/g'
}

# Tells the owner in Telegram. The token is read from .env and never printed.
setting() {
  sed -n "s/^$1=//p" "$ROOT/.env" | head -n 1 | tr -d '[:space:]"'
}

notify() {
  local message="$1" token chat api
  token="$(setting BOT_TOKEN)"
  chat="$(setting ALLOWED_TELEGRAM_IDS | cut -d, -f1)"
  api="$(setting TELEGRAM_API_ROOT)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -fsS --max-time 10 -o /dev/null \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=$message" \
    "${api:-https://api.telegram.org}/bot${token}/sendMessage" 2>/dev/null || true
}

# Backup file names, oldest first by the time in the name. The label comes before the time, so sorting the plain
# names would put every pre-deploy backup after every daily one. The directory belongs to the application's user,
# which need not be the user running this script, so it is read through a container.
backups_by_time() {
  local image="$1"
  dock run --rm --network none --user 0:0 -v "$ROOT/backups:/backups:ro" --entrypoint ls "$image" -1 /backups 2>/dev/null |
    grep -E '^mon22r-.*[0-9]{8}T[0-9]{6}Z\.sqlite\.gz$' |
    sed -E 's/^(.*-)([0-9]{8}T[0-9]{6}Z)(\.sqlite\.gz)$/\2 &/' | sort | cut -d' ' -f2 || true
}

# Copies the release scripts into bin/. Running a script that already lives there is fine: nothing to copy.
install_scripts() {
  local from="$1"
  mkdir -p "$ROOT/bin"
  [[ "$(realpath "$from")" != "$(realpath "$ROOT/bin")" ]] || return 0
  install -m 755 "$from"/*.sh "$ROOT/bin/"
}

# Stops the application container of this project, whichever stack definition started it.
stop_app() {
  local -a ids
  mapfile -t ids < <(dock ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=app")
  ((${#ids[@]} == 0)) || dock stop -t 15 "${ids[@]}" >/dev/null
}

running_app_image() {
  dock ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=app" \
    --format '{{.Image}}' | head -n 1
}

lock() {
  exec 9>"$ROOT/release.lock"
  flock -n 9 || die "another release operation is running"
}
