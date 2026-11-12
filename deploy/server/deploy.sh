#!/usr/bin/env bash
# Installs one release and makes it current, or leaves the previous one running.
#
#   deploy.sh <commit sha> <directory with image.tar.gz, image.sha256, compose.yml, Caddyfile and these scripts>
#
# Order: verify the image file -> load it -> back the database up -> switch -> wait for health.
# If the new release is not healthy in time, the previous release is started again and the script exits non-zero.
# If the previous release cannot use the database any more (a migration raised the compatibility floor),
# the backup taken in step three is restored first. The replaced database files are kept next to it.

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/server/lib.sh
source "$SOURCE_DIR/lib.sh"

SHA="${1:-}"
INCOMING="${2:-$SOURCE_DIR}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "usage: deploy.sh <40-character commit sha> [directory]"
[[ -f "$ROOT/.env" ]] || die "$ROOT/.env is missing. Run bootstrap.sh first"
for file in image.tar.gz image.sha256 compose.yml Caddyfile; do
  [[ -f "$INCOMING/$file" ]] || die "$INCOMING/$file is missing"
done

lock
IMAGE="mon22r:$SHA"
# The release to return to. When this commit is already current (a re-run), that is the one recorded before it.
PREVIOUS="$(release_name current || true)"
if [[ "$PREVIOUS" == "$SHA" ]]; then PREVIOUS="$(release_name previous || true)"; fi
BACKUP_FILE=""

log "release $SHA starting; the release to return to is ${PREVIOUS:-none}"

# 1. The file must be the one the pipeline built and tested.
(cd "$INCOMING" && sha256sum --check --status image.sha256) || die "image.tar.gz does not match image.sha256"
dock load --input "$INCOMING/image.tar.gz" >/dev/null
revision="$(dock image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[[ "$revision" == "$SHA" ]] || die "loaded image is labeled $revision, expected $SHA"
log "image $IMAGE loaded and verified"

# 2. Install the scripts and the release's stack definition. Nothing is running differently yet.
mkdir -p "$ROOT/releases/$SHA" "$ROOT/backups"
# After the first release the backups belong to the application's user; that is fine.
chmod 700 "$ROOT/backups" 2>/dev/null || true
install_scripts "$SOURCE_DIR"
cp "$INCOMING/compose.yml" "$INCOMING/Caddyfile" "$ROOT/releases/$SHA/"
printf '%s\n' "$IMAGE" >"$ROOT/releases/$SHA/image"

# 3. A verified backup before anything touches the database. No backup, no release.
if database_exists "$IMAGE"; then
  result="$(tool "$IMAGE" backup pre-deploy)" || die "pre-deploy backup failed: $result"
  BACKUP_FILE="$(printf '%s' "$result" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
  own_backups "$IMAGE"
  [[ -n "$BACKUP_FILE" ]] || die "pre-deploy backup did not report a file: $result"
  log "pre-deploy backup written: $(basename "$BACKUP_FILE")"
else
  log "no database yet; skipping the pre-deploy backup"
fi

# The stack as it ran before releases existed: built on the host and started from its source directory.
# It counts only for the project it actually is, and only while no release has ever been recorded.
legacy_available() {
  [[ -z "$PREVIOUS" && -f "$LEGACY_DIR/docker-compose.yml" && "$PROJECT" == "$(basename "$LEGACY_DIR")" ]]
}

start_previous() {
  if [[ -n "$PREVIOUS" ]]; then
    own_data "$(release_image "$PREVIOUS")" || return 1
    activate "$PREVIOUS" || return 1
    compose up -d --remove-orphans || return 1
    reload_proxy || true
    wait_healthy "$PREVIOUS"
  elif legacy_available; then
    rm -f "$ROOT/current"
    local legacy_image
    legacy_image="$(cd "$LEGACY_DIR" && "${SUDO[@]}" docker compose config --images | grep -v caddy | head -n 1)" || return 1
    [[ -n "$legacy_image" ]] || return 1
    own_data "$legacy_image" || return 1
    (cd "$LEGACY_DIR" && "${SUDO[@]}" docker compose up -d --no-build --remove-orphans) || return 1
    sleep 10
    # Running, and running the old image: a container of the failed release must not pass for a rollback.
    [[ "$(running_app_image)" == "$legacy_image" ]]
  else
    return 1
  fi
}

roll_back() {
  local reason="$1"
  log "ROLLING BACK: $reason"
  recent_logs 30 || true
  if [[ -z "$PREVIOUS" ]] && ! legacy_available; then
    notify "mon22r: выпуск ${SHA:0:7} не прошёл проверку ($reason), а прежней версии нет. Нужна ручная проверка сервера."
    die "release $SHA is not healthy and there is no previous release to return to; it was left as it is"
  fi
  if start_previous; then
    log "previous release ${PREVIOUS:-legacy} is running again"
    notify "mon22r: выпуск ${SHA:0:7} не прошёл проверку ($reason). Работает прежняя версия."
    exit 1
  fi
  if [[ -n "$BACKUP_FILE" ]]; then
    log "previous release did not start on the migrated database; restoring $(basename "$BACKUP_FILE")"
    # Nothing may have the database open while its file is replaced.
    stop_app || die "the application could not be stopped, so nothing was restored; the service needs attention"
    tool "$IMAGE" restore "/backups/$(basename "$BACKUP_FILE")" || die "restore failed; the service needs attention"
    if start_previous; then
      log "previous release ${PREVIOUS:-legacy} is running on the restored database"
      notify "mon22r: выпуск ${SHA:0:7} отменён, база восстановлена из копии перед выпуском."
      exit 1
    fi
  fi
  notify "mon22r: выпуск ${SHA:0:7} не удался и прежняя версия не запустилась. Нужна ручная проверка сервера."
  die "rollback failed; the service needs attention"
}

# 4. Switch, and 5. accept the release only when it reports healthy as this exact version, inside the container
# and through the proxy. The steps run inside one function so that any failing step, expected or not, ends in
# roll_back instead of ending the script with the new release half started.
FAILURE="the stack did not start"
switch_and_verify() {
  own_data "$IMAGE" || return 1
  activate "$SHA" || return 1
  compose up -d --remove-orphans || return 1
  reload_proxy || true
  FAILURE="the application did not become healthy"
  wait_healthy "$SHA" || return 1
  FAILURE="the public address did not answer"
  wait_public || return 1
}
if ! switch_and_verify; then roll_back "$FAILURE"; fi

# The release is live. Bookkeeping from here on must not turn a good release into a failed run.
finish() {
  if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$SHA" ]]; then printf '%s\n' "$PREVIOUS" >"$ROOT/previous"; fi
  printf '%s %s previous=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" "${PREVIOUS:-none}" >>"$ROOT/releases.log"
  # 6. Keep the current and the previous release; drop older images and their directories.
  local keep directory name
  keep="$SHA $(release_name previous || true)"
  for directory in "$ROOT"/releases/*/; do
    name="$(basename "$directory")"
    [[ " $keep " == *" $name "* ]] && continue
    dock image rm "mon22r:$name" >/dev/null 2>&1
    rm -rf "$directory"
  done
  rm -f "$INCOMING/image.tar.gz"
}
finish || log "bookkeeping after the release did not complete"

log "release $SHA is live"
health_json || true
