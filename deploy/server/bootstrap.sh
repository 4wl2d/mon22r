#!/usr/bin/env bash
# Prepares a server for releases. Run once, as the user that will own the service (it needs docker, with or
# without sudo):
#
#   bootstrap.sh [--deploy-key "<one line from the pipeline's public key>"]
#
# It creates the directory layout, installs these scripts, and reuses an existing .env if one is found in the
# legacy directory. It never overwrites .env, never touches containers or volumes, and can be run again.

# shellcheck source=deploy/server/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DEPLOY_KEY=""
while (($# > 0)); do
  case "$1" in
    --deploy-key)
      DEPLOY_KEY="${2:-}"
      shift 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

dock compose version >/dev/null 2>&1 || die "docker compose is not available"
command -v flock >/dev/null || die "flock is not installed"
command -v curl >/dev/null || die "curl is not installed"

if [[ ! -d "$ROOT" ]]; then
  "${SUDO[@]}" mkdir -p "$ROOT"
  "${SUDO[@]}" chown "$(id -u):$(id -g)" "$ROOT"
fi
mkdir -p "$ROOT/bin" "$ROOT/releases" "$ROOT/backups" "$ROOT/incoming"
chmod 750 "$ROOT"
# After the first release the backups belong to the application's user; that is fine.
chmod 700 "$ROOT/backups" 2>/dev/null || true
install_scripts "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$ROOT/.env" ]]; then
  if [[ -f "$LEGACY_DIR/.env" ]]; then
    install -m 600 "$LEGACY_DIR/.env" "$ROOT/.env"
    log "copied .env from $LEGACY_DIR"
  else
    log "create $ROOT/.env (mode 600) with BOT_TOKEN, ALLOWED_TELEGRAM_IDS, MINI_APP_URL and DOMAIN before the first release"
  fi
fi
[[ ! -f "$ROOT/.env" ]] || chmod 600 "$ROOT/.env"

if [[ -n "$DEPLOY_KEY" ]]; then
  [[ "$DEPLOY_KEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+ ]] || die "--deploy-key must be one public key line"
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
  if ! grep -qF "$(printf '%s' "$DEPLOY_KEY" | awk '{print $2}')" "$HOME/.ssh/authorized_keys"; then
    # The CD key needs commands and file transfers only, never forwarding, an agent, or a PTY.
    printf 'restrict %s\n' "$DEPLOY_KEY" >>"$HOME/.ssh/authorized_keys"
    log "deploy key added to authorized_keys"
  else
    log "deploy key already present"
  fi
fi

log "ready: $ROOT"
ls -la "$ROOT"
