#!/usr/bin/env bash
# Verified production backup. Run before every schema or application deployment.
set -Eeuo pipefail
umask 077

APP_DIR="${SXB_APP_DIR:-/var/www/sxb-vpn}"
BACKUP_ROOT="${SXB_BACKUP_ROOT:-${HOME}/sxb-backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_ROOT}/${TS}"

for command_name in pg_dump pg_restore psql sha256sum tar git; do
  command -v "$command_name" >/dev/null || {
    echo "Required command not found: $command_name" >&2
    exit 1
  }
done

[ -d "$APP_DIR/.git" ] || { echo "Application checkout not found: $APP_DIR" >&2; exit 1; }
[ -f "$APP_DIR/.env" ] || { echo "Environment file not found: $APP_DIR/.env" >&2; exit 1; }
mkdir -p "$BACKUP_ROOT"
mkdir "$DEST"
chmod 700 "$DEST"

set -a
# shellcheck disable=SC1091
. "$APP_DIR/.env"
set +a
: "${DATABASE_URL:?DATABASE_URL is required in $APP_DIR/.env}"

# Prisma's schema query parameter is not accepted by libpq clients.
PGLIB_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"

printf 'Created (UTC): %s\nHost: %s\nApp: %s\n' "$TS" "$(hostname)" "$APP_DIR" > "$DEST/README.txt"

pg_dump "$PGLIB_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-acl \
  --file="$DEST/db.dump"
pg_restore --list "$DEST/db.dump" > "$DEST/db.restore-list.txt"
TABLES="$(grep -c ' TABLE ' "$DEST/db.restore-list.txt" || true)"
[ "$TABLES" -gt 10 ] || {
  echo "Database dump verification failed: only $TABLES tables found" >&2
  exit 1
}

count_table() {
  local table="$1"
  local label="$2"
  psql "$PGLIB_URL" -Atqc "SELECT count(*) FROM \"$table\";" > "$DEST/${label}.count"
}

count_table users users
count_table vpn_clients vpn-clients
count_table vouchers vouchers
count_table resellers resellers
count_table roles roles
count_table permissions permissions
count_table subscriptions subscriptions
count_table vpn_profiles vpn-profiles

install -m 600 "$APP_DIR/.env" "$DEST/environment.env"

tar -czf "$DEST/runtime-dist.tar.gz" \
  --exclude='dist/download' \
  -C "$APP_DIR" dist
[ -s "$DEST/runtime-dist.tar.gz" ] || {
  echo "Runtime artifact backup failed" >&2
  exit 1
}

if [ -d "$APP_DIR/public/uploads" ]; then
  tar -czf "$DEST/uploads.tar.gz" -C "$APP_DIR" public/uploads
fi

if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
  redis-cli --rdb "$DEST/redis.rdb" >/dev/null
fi

for candidate in \
  "$APP_DIR/xpanel.db" \
  "$APP_DIR/data/xpanel.db" \
  "/etc/x-ui/x-ui.db" \
  "/etc/x-ui-english/x-ui.db"; do
  if [ -f "$candidate" ] && [ -r "$candidate" ]; then
    cp "$candidate" "$DEST/$(basename "$(dirname "$candidate")")-$(basename "$candidate")"
  fi
done

(
  cd "$APP_DIR"
  git rev-parse HEAD > "$DEST/git-head.txt"
  git status --short --branch > "$DEST/git-status.txt"
  git diff --binary HEAD -- . > "$DEST/tracked-changes.patch"
  git ls-files --others --exclude-standard -z > "$DEST/untracked-files.list0"
  if [ -s "$DEST/untracked-files.list0" ]; then
    tar --null --files-from="$DEST/untracked-files.list0" -czf "$DEST/untracked-files.tar.gz"
  fi
)

cat > "$DEST/restore-db.sh" <<'RESTORE'
#!/usr/bin/env bash
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
# shellcheck disable=SC1091
. "$HERE/environment.env"
set +a
: "${DATABASE_URL:?DATABASE_URL is required}"
URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
echo "This will replace database objects referenced by the backup."
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled"; exit 1; }
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$URL" "$HERE/db.dump"
RESTORE
chmod 700 "$DEST/restore-db.sh"

MANIFEST_TMP="$(mktemp)"
trap 'rm -f "$MANIFEST_TMP"' EXIT
(
  cd "$DEST"
  find . -type f ! -name manifest.sha256 -print0 \
    | sort -z \
    | xargs -0 sha256sum
) > "$MANIFEST_TMP"
mv "$MANIFEST_TMP" "$DEST/manifest.sha256"
trap - EXIT
(
  cd "$DEST"
  sha256sum --check manifest.sha256 >/dev/null
)

if [ -e "$BACKUP_ROOT/latest" ] && [ ! -L "$BACKUP_ROOT/latest" ]; then
  echo "Cannot replace non-symlink path: $BACKUP_ROOT/latest" >&2
  exit 1
fi
ln -sfn "$DEST" "$BACKUP_ROOT/latest"
echo "Backup complete and verified: $DEST"
