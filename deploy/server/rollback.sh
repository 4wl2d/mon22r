#!/usr/bin/env bash
# Switches to the previous release without changing the database.
# If it cannot run on the current schema, resume the saved current release and fail visibly.

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

lock
current="$(release_name current)" || die "no current release"
previous="$(release_name previous)" || die "no previous release is installed"
[[ "$previous" != "$current" ]] || die "the previous release is already current"

switch_to() {
  local target="$1"
  stop_app || return 1
  own_data "$(release_image "$target")" || return 1
  activate "$target" || return 1
  compose up -d --no-build --remove-orphans || return 1
  reload_proxy || true
  wait_healthy "$target" && wait_public "$target"
}

log "rolling back from $current to $previous"
if ! switch_to "$previous"; then
  recent_logs 60 || true
  log "rollback target failed; resuming $current"
  if switch_to "$current"; then
    notify "mon22r: откат на $previous не прошёл проверку. Продолжает работать $current."
    die "rollback target failed; $current is healthy again. Check schema compatibility before restoring a backup"
  fi
  notify "mon22r: откат не удался, и текущая версия не восстановилась. Нужна ручная проверка сервера."
  die "rollback and recovery both failed; the service needs attention"
fi
printf '%s\n' "$current" >"$ROOT/previous"
printf '%s %s rollback-from=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$previous" "$current" >>"$ROOT/releases.log"
log "release $previous is live"
health_json || true
