#!/usr/bin/env bash
# Replaces the database with a backup:  /opt/mon22r/bin/restore.sh <file in backups/ | latest>
#
# The application is stopped, the backup is verified, the database files that were there are moved aside
# (mon22r.sqlite.before-restore-<time> in the data volume), and the application is started again.
# Everything written after the backup was taken is no longer in the active database.

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

target="${1:-}"
[[ -n "$target" ]] || die "usage: restore.sh <backup file name | latest>"

lock
current="$(release_name current)" || die "no current release"
image="$(release_image "$current")"

if [[ "$target" == "latest" ]]; then
  target="$(backups_by_time "$image" | tail -n 1)"
  [[ -n "$target" ]] || die "no backups in $ROOT/backups"
fi
target="$(basename "$target")"
backups_by_time "$image" | grep -qxF "$target" || die "$ROOT/backups/$target is not a backup file"

log "verifying $target"
tool "$image" verify "/backups/$target" || die "the backup failed verification; nothing was changed"

log "stopping the application"
compose stop app
log "restoring $target"
if ! tool "$image" restore "/backups/$target"; then
  compose start app || true
  die "restore failed; the application was started again on the database it had"
fi
own_data "$image"
compose up -d
wait_healthy "$current" || die "the application did not become healthy after the restore"
printf '%s %s restored=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$current" "$target" >>"$ROOT/releases.log"
log "restored $target; release $current is healthy"
health_json || true
