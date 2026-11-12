#!/usr/bin/env bash
# Makes the previous release current again. Run it on the server:  /opt/mon22r/bin/rollback.sh
# The database is not touched. A release whose migration made the schema unusable for the previous one
# refuses to start and says so; in that case restore the pre-deploy backup with restore.sh.

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

lock
current="$(release_name current)" || die "no current release"
previous="$(release_name previous)" || die "no previous release is installed"
[[ "$previous" != "$current" ]] || die "the previous release is already current"

log "rolling back from $current to $previous"
own_data "$(release_image "$previous")"
activate "$previous"
compose up -d --remove-orphans
reload_proxy
if ! wait_healthy "$previous"; then
  recent_logs 60 || true
  die "release $previous did not become healthy. Check the log above; if it mentions the schema version, run restore.sh with the pre-deploy backup"
fi
printf '%s\n' "$current" >"$ROOT/previous"
printf '%s %s rollback-from=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$previous" "$current" >>"$ROOT/releases.log"
log "release $previous is live"
health_json || true
