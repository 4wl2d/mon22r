#!/usr/bin/env bash
# docker compose for the active release:  /opt/mon22r/bin/compose.sh logs -f app
# Use this instead of calling docker compose directly: it supplies the image of the current release.

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

compose "$@"
