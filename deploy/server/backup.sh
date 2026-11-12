#!/usr/bin/env bash
# Writes a verified backup now and prints its name:  /opt/mon22r/bin/backup.sh
# Safe while the application is running.

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

lock
current="$(release_name current)" || die "no current release"
image="$(release_image "$current")"
tool "$image" backup manual
own_backups "$image"
