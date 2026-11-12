#!/usr/bin/env bash
# Fast deployment contract tests. No Docker daemon, network, credentials, or real ledger.
set -euo pipefail

# lib.sh probes Docker once to decide whether sudo is needed.
docker() { return 0; }
# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)/lib.sh"

sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
other=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
good="{\"ok\":true,\"version\":\"$sha\",\"polling\":\"ok\"}"

reject() {
  if "$@"; then
    printf 'FAIL: accepted an unhealthy or wrong-version response\n' >&2
    exit 1
  fi
}

healthy_response "$good" "$sha"
healthy_response '<!doctype html><title>preserved legacy</title>' legacy
reject healthy_response "$good" legacy
reject healthy_response '<!doctype html><title>old application</title>' "$sha"
reject healthy_response "$good" "$other"
reject healthy_response "{\"ok\":false,\"version\":\"$sha\",\"polling\":\"ok\"}" "$sha"
reject healthy_response "{\"ok\":true,\"version\":\"$sha\",\"polling\":\"starting\"}" "$sha"
reject healthy_response "{\"ok\":true,\"version\":\"$sha\",\"polling\":\"stale\"}" "$sha"

# Failed waits advance virtual time instead of sleeping.
sleep() { SECONDS=$((SECONDS + 61)); }
health_json() { printf '%s\n' "$answer"; }
setting() { printf 'ledger.test\n'; }
curl() { printf '%s\n' "$answer"; }
HEALTH_TIMEOUT=3
MON22R_PUBLIC_CHECK=on

answer="$good"
wait_healthy "$sha"
wait_public "$sha"
answer='<!doctype html><title>old application</title>'
reject wait_healthy "$sha"
reject wait_public "$sha"
answer="{\"ok\":true,\"version\":\"$other\",\"polling\":\"ok\"}"
reject wait_healthy "$sha"
reject wait_public "$sha"
answer="{\"ok\":true,\"version\":\"$sha\",\"polling\":\"starting\"}"
reject wait_healthy "$sha"
reject wait_public "$sha"

printf 'Deployment health contracts passed\n'
