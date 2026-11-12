#!/usr/bin/env bash
# One screen about the service:  /opt/mon22r/bin/status.sh [log lines]

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

echo "current:  $(release_name current || echo none)"
echo "previous: $(release_name previous || echo none)"
echo
compose ps || true
echo
echo "health:   $(health_json 2>/dev/null || echo unavailable)"
echo
echo "backups (newest last):"
if current="$(release_name current)"; then
  backups_by_time "$(release_image "$current")" | tail -n 8 | sed 's/^/  /'
fi
echo
echo "disk:"
df -h "$ROOT" | sed 's/^/  /'
echo
echo "last releases:"
tail -n 5 "$ROOT/releases.log" 2>/dev/null | sed 's/^/  /'
echo
echo "application log:"
recent_logs "${1:-30}" || true
