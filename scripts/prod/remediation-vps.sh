#!/usr/bin/env bash
# Production diagnostics. Read-only unless --clean-git-remote is provided.
set -Eeuo pipefail

APP_DIR="${SXB_APP_DIR:-/var/www/sxb-vpn}"
MODE="${1:-}"

[ -d "$APP_DIR/.git" ] || {
  echo "Application checkout not found: $APP_DIR" >&2
  exit 1
}

redact_remote() {
  sed -E 's#(https?://)[^/@]+@#\1***@#'
}

echo "SXB VPN production diagnostics"
echo
echo "Git"
git -C "$APP_DIR" status --short --branch
git -C "$APP_DIR" remote get-url origin | redact_remote

REMOTE_URL="$(git -C "$APP_DIR" remote get-url origin)"
if [[ "$REMOTE_URL" =~ ^https?://[^/@]+@ ]]; then
  echo "WARNING: the Git remote embeds credentials."
  if [ "$MODE" = "--clean-git-remote" ]; then
    LATEST_BACKUP="$(readlink -f "$HOME/sxb-backups/latest" 2>/dev/null || true)"
    if [ -z "$LATEST_BACKUP" ] || [ ! -s "$LATEST_BACKUP/manifest.sha256" ]; then
      echo "A verified backup is required before changing the remote." >&2
      exit 1
    fi
    git -C "$APP_DIR" remote set-url origin https://github.com/AbakoDolla/SXB-VPN.git
    echo "Embedded Git credentials removed. Revoke the exposed token separately."
  else
    echo "Run with --clean-git-remote only after verifying repository access and a backup."
  fi
fi

echo
echo "PM2"
pm2 describe sxb-backend || true

echo
echo "Listening TCP ports"
ss -lntp 2>/dev/null | grep -E ':(3000|3001|4000|9090)\b' || true

echo
echo "Firewall"
sudo -n ufw status verbose 2>/dev/null || echo "UFW status requires administrator access."

echo
echo "Diagnostics complete. No service, firewall rule or database was changed."
