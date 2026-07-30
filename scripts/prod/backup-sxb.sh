#!/usr/bin/env bash
# backup-sxb.sh — Sauvegarde vérifiable AVANT migration (mission §10.1)
# À EXÉCUTER PAR L'ADMINISTRATEUR SUR LE VPS (SSH ubuntu@141.95.112.93)
# AUCUN secret n'est écrit dans ce script — DATABASE_URL est lu depuis .env
# et n'est jamais affiché.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/sxb-vpn}"
# Par défaut dans $HOME : /var/backups exige root, or la mission s'exécute en ubuntu.
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/sxb-backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$TS"
mkdir -p "$DEST"

echo "═══ Sauvegarde SXB VPN — $TS ═══"
cd "$APP_DIR"

# 1. État git exact (preuve de version avant migration)
git rev-parse HEAD | tee "$DEST/git-head.txt"
git status --porcelain > "$DEST/git-status.txt" || true
echo "✅ 1/5 Version git enregistrée : $(cat "$DEST/git-head.txt")"

# 2. Dump PostgreSQL complet (compressé), sans jamais afficher le secret
set -a; # exporte les variables du .env sans les afficher
source "$APP_DIR/.env"
set +a
: "${DATABASE_URL:?DATABASE_URL absent de .env — sauvegarde impossible}"
# Prisma suffixe l'URI de "?schema=public", paramètre INCONNU de libpq (pg_dump/psql).
# On retire UNIQUEMENT « schema » (sslmode & co. préservés) ; la valeur n'est jamais affichée.
PGLIB_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
pg_dump "$PGLIB_URL" --format=custom --compress=9 --file="$DEST/db-$(date -u +%Y%m%d).dump"
echo "✅ 2/5 Dump PostgreSQL créé ($(du -h "$DEST"/db-*.dump | cut -f1))"

# 3. VÉRIFICATION du dump (obligatoire : une sauvegarde non vérifiable ne compte pas)
pg_restore --list "$DEST"/db-*.dump > "$DEST/db-manifest.txt"
TABLES=$(grep -c " TABLE " "$DEST/db-manifest.txt" || true)
[ "$TABLES" -gt 10 ] || { echo "❌ Dump suspect : seulement $TABLES tables listées"; exit 1; }
sha256sum "$DEST"/db-*.dump | tee "$DEST/db-sha256.txt"
echo "✅ 3/5 Dump vérifié : $TABLES tables, empreinte sha256 consignée"

# 4. Compteurs de contrôle (comparaison post-migration)
psql "$PGLIB_URL" -Atc "
  SELECT 'vpn_profiles='      || count(*) FROM vpn_profiles;
  SELECT 'subscriptions='     || count(*) FROM subscriptions;
  SELECT 'vpn_clients='       || count(*) FROM vpn_clients;
  SELECT 'users='             || count(*) FROM users;
" | tee "$DEST/db-counts.txt"
echo "✅ 4/5 Compteurs de contrôle : $(tr '\n' ' ' < "$DEST/db-counts.txt")"

# 5. Copie de .env (secrets → permissions strictes, hors git)
install -m 600 "$APP_DIR/.env" "$DEST/env.backup"
echo "✅ 5/5 .env sauvegardé (chmod 600)"

# 6. Script de restauration prêt à l'emploi (une sauvegarde n'a de valeur
#    que si sa restauration est éprouvée — voir §Rollback du runbook)
cat > "$DEST/restore.sh" <<'EOF'
#!/usr/bin/env bash
# Restauration d'urgence — ROLLBACK UNIQUEMENT (écrase la base courante)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$DIR/env.backup"; set +a
# Même nettoyage du paramètre Prisma « schema », inconnu de libpq
URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
pg_restore --clean --if-exists -d "$URL" "$DIR"/db-*.dump
echo "🟢 Restauration terminée depuis : $DIR"
EOF
chmod 700 "$DEST/restore.sh"

echo
echo "🟢 SAUVEGARDE COMPLÈTE ET VÉRIFIÉE : $DEST"
echo "   Restauration d'urgence : bash $DEST/restore.sh"
