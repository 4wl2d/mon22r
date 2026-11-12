#!/usr/bin/env bash
# Installs one release and makes it current, or leaves the previous one running.
#
#   deploy.sh <commit sha> <directory with image.tar.gz, image.sha256, compose.yml, Caddyfile and these scripts>
#
# Order: verify the image file -> load it -> stop the old app -> back the database up -> switch -> wait for health.
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

# 2. Store the release's stack definition. Nothing is running differently yet.
mkdir -p "$ROOT/releases/$SHA" "$ROOT/backups"
# After the first release the backups belong to the application's user; that is fine.
chmod 700 "$ROOT/backups" 2>/dev/null || true
cp "$INCOMING/compose.yml" "$INCOMING/Caddyfile" "$ROOT/releases/$SHA/"
printf '%s\n' "$IMAGE" >"$ROOT/releases/$SHA/image"

# Preserve the actual running legacy image before the first cutover. Its original source directory
# and Caddy bind mount stay untouched, so both automatic and manual rollback can return to them.
preserve_legacy() {
  [[ -z "$PREVIOUS" && -f "$LEGACY_DIR/docker-compose.yml" && "$PROJECT" == "$(basename "$LEGACY_DIR")" ]] || return 0
  local running id tag
  running="$(running_app_image)"
  [[ -n "$running" ]] || return 0
  id="$(dock image inspect "$running" --format '{{.Id}}')" || return 1
  tag="$PROJECT:legacy"
  dock tag "$id" "$tag" || return 1
  mkdir -p "$ROOT/releases/legacy" || return 1
  cp "$LEGACY_DIR/docker-compose.yml" "$ROOT/releases/legacy/compose.yml" || return 1
  cp "$LEGACY_DIR/Caddyfile" "$ROOT/releases/legacy/Caddyfile" || return 1
  printf '%s\n' "$tag" >"$ROOT/releases/legacy/image" || return 1
  printf 'services:\n  app:\n    image: %s\n    pull_policy: never\n' "$tag" >"$ROOT/releases/legacy/image-override.yml" || return 1
  PREVIOUS=legacy
  log "preserved legacy image $id for automatic and manual rollback"
}
preserve_legacy || die "could not preserve the legacy release; nothing was stopped"

start_previous() {
  # A UID change must not take write access away from a process that is still shutting down.
  stop_app || return 1
  if [[ -n "$PREVIOUS" ]]; then
    own_data "$(release_image "$PREVIOUS")" || return 1
    activate "$PREVIOUS" || return 1
    compose up -d --no-build --remove-orphans || return 1
    reload_proxy || true
    wait_healthy "$PREVIOUS"
  else
    return 1
  fi
}

roll_back() {
  local reason="$1"
  log "ROLLING BACK: $reason"
  recent_logs 30 || true
  if [[ -z "$PREVIOUS" ]]; then
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

# Snapshot after the old process has stopped: a compatibility restore must also retain its last writes.
# A failed snapshot returns through roll_back, which resumes the previous service.
snapshot_database() {
  local result
  if database_exists "$IMAGE"; then
    result="$(tool "$IMAGE" backup pre-deploy)" || return 1
    BACKUP_FILE="$(printf '%s' "$result" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
    [[ -n "$BACKUP_FILE" ]] || return 1
    own_backups "$IMAGE" || return 1
    log "pre-deploy backup written: $(basename "$BACKUP_FILE")"
  else
    log "no database yet; skipping the pre-deploy backup"
  fi
}

# 4. Switch, and 5. accept the release only when it reports healthy as this exact version, inside the container
# and through the proxy. The steps run inside one function so that any failing step, expected or not, ends in
# roll_back instead of ending the script with the new release half started.
FAILURE="the stack did not start"
switch_and_verify() {
  FAILURE="the application could not be stopped"
  if [[ "$PREVIOUS" == "legacy" ]]; then
    # Legacy has no durable update IDs. Let the next poll confirm its handled batch.
    # Keep chat and Mini App writes idle during first cutover; never discard pending updates.
    local drain="${MON22R_LEGACY_DRAIN_SECONDS:-40}"
    [[ "$drain" =~ ^[0-9]+$ ]] || return 1
    log "draining legacy polling for ${drain}s before the first cutover"
    sleep "$drain"
  fi
  stop_app || return 1
  FAILURE="the pre-deploy backup failed"
  snapshot_database || return 1
  FAILURE="the stack did not start"
  own_data "$IMAGE" || return 1
  activate "$SHA" || return 1
  compose up -d --no-build --remove-orphans || return 1
  reload_proxy || true
  FAILURE="the application did not become healthy"
  wait_healthy "$SHA" || return 1
  FAILURE="the public address did not answer"
  wait_public "$SHA" || return 1
}
if ! switch_and_verify; then roll_back "$FAILURE"; fi

# The release is live. Bookkeeping from here on must not turn a good release into a failed run.
finish() {
  install_scripts "$SOURCE_DIR" || return 1
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
