#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# audit-remote.sh — AUDIT VPS SXB STRICTEMENT LECTURE SEULE
# Exécuté SUR le VPS via : sshpass -e ssh ubuntu@VPS 'bash -s' < audit-remote.sh
# AUCUN redémarrage, AUCUNE migration, AUCUN git reset/fetch/pull, AUCUN write.
# Toutes les sorties passent par red() : tokens, secrets, DATABASE_URL masqués.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

red() {
  sed -E \
    -e 's#(postgres(ql)?://)[^:@/ ]+:[^@/ ]+@#\1***:***@#gi' \
    -e 's#(https?://)[^:@/ ]+:[^@/ ]+@#\1***MASQUÉ-CREDENTIALS***@#gi' \
    -e 's/gh[pousr]_[A-Za-z0-9]{20,}/***MASQUÉ-PAT***/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/***MASQUÉ-PAT***/g' \
    -e 's/(DATABASE_URL|ENCRYPTION_KEY|PROVISION_SECRET|JWT_SECRET|SESSION_SECRET|PASSWORD|PASSWD)[A-Za-z_]*(=|:)[^ ]+/\1\2***MASQUÉ***/gi' \
    -e 's/gcm:[0-9a-fA-F:]+/***MASQUÉ-GCM***/g' \
    -e 's/[0-9a-f]{32,}:[0-9a-f]{32,}/***MASQUÉ-HEX***/g' \
    -e 's/SXB-DATA-[A-Za-z0-9-]+/***MASQUÉ-TOKEN***/g' \
    -e 's/eyJ[A-Za-z0-9_.-]{20,}/***MASQUÉ-JWT***/g'
}

echo "════════════════════════════════ 4.1 IDENTITÉ SYSTÈME ════════════════════════"
id | red
hostname
grep -E 'PRETTY_NAME' /etc/os-release || true
date -u '+UTC %Y-%m-%d %H:%M:%S'
uptime
free -h
df -h / /var /tmp 2>/dev/null || df -h / || true

echo "════════════════════════════════ LOCALISATION PROJET ═════════════════════════"
ls -la /var/www/ 2>/dev/null | red || true
ls -la /opt/ 2>/dev/null | head -15 || true
ls -la /home/ubuntu/ 2>/dev/null | head -15 || true

echo "════════════════════════════════ ÉTAT GIT (lecture seule) ════════════════════"
if cd /var/www/sxb-vpn 2>/dev/null; then
  git status --short 2>&1 | head -10 || true
  echo "--- branche : $(git branch --show-current 2>&1)"
  echo "--- HEAD    : $(git rev-parse HEAD 2>&1)"
  git remote -v 2>&1 | red || true
  git log -10 --oneline --decorate 2>&1 || true
  echo "--- référence attendue origin/main : 852551a316224e88f7573250c1ef3641d5269307"
else
  echo "⚠️ /var/www/sxb-vpn introuvable"
fi
cd / || true

echo "════════════════════════════════ PROCESSUS / SUPERVISEURS ════════════════════"
echo "--- PM2 status ---"
pm2 status 2>&1 | red || true
echo "--- PM2 describe sxb-backend ---"
pm2 describe sxb-backend 2>&1 | grep -Ei 'script path|exec cwd|status|uptime|restarts|memory|watching|exec mode' | head -20 | red || true
echo "--- systemd unités actives pertinentes ---"
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -Ei 'ssh|drop|nginx|xnet|sing|xray|v2ray|badvpn|udpgw|postgres|docker|pm2|fail2ban|cron' | red || true
echo "--- systemd unités pertinentes (fichiers) ---"
systemctl list-unit-files --no-pager 2>/dev/null | grep -Ei 'ssh|drop|nginx|xnet|sing|xray|v2ray|badvpn|udpgw|postgres' | red || true
echo "--- Docker ---"
docker ps --no-trunc 2>&1 | head -15 | red || echo "(docker absent)"

echo "════════════════════════════════ 4.2 RÉSEAU & PARE-FEU ═══════════════════════"
echo "--- ss -lntup ---"
sudo -n ss -lntup 2>&1 | red || true
echo "--- ufw ---"
sudo -n ufw status verbose 2>&1 | red || true
echo "--- nftables ---"
sudo -n nft list ruleset 2>&1 | head -100 | red || echo "(nft indisponible)"
echo "--- iptables ---"
sudo -n iptables-save 2>&1 | head -100 | red || echo "(iptables-save indisponible)"
echo "--- fail2ban ---"
sudo -n fail2ban-client status 2>&1 | red || echo "(fail2ban absent)"
sudo -n fail2ban-client status sshd 2>&1 | head -20 | red || true

echo "════════════════════════════════ ÉTAT SERVICES CŒUR ══════════════════════════"
for u in ssh sshd dropbear nginx xnet xpanel sing-box xray v2ray badvpn-udpgw postgresql; do
  st=$(systemctl is-active "$u" 2>&1)
  en=$(systemctl is-enabled "$u" 2>&1)
  echo "[$u] actif=$st activé=$en"
done | red
echo "--- statuts détaillés ---"
sudo -n systemctl status ssh sshd dropbear nginx --no-pager 2>&1 | head -60 | red || true
sudo -n systemctl status xnet xpanel sing-box --no-pager 2>&1 | head -40 | red || true

echo "════════════════════════════════ JOURNAUX (2 dernières heures) ═══════════════"
sudo -n journalctl -u ssh -u sshd -u dropbear -u nginx -u xnet -u sing-box _COMM=sshd --since "2 hours ago" --no-pager -n 150 2>&1 | red || true
echo "--- erreurs nginx récentes ---"
sudo -n tail -n 30 /var/log/nginx/error.log 2>&1 | red || true

echo "════════════════════════════════ 4.3 NGINX -T (extrait) ══════════════════════"
sudo -n nginx -T 2>&1 | grep -Ev '^# (configuration file|.*:$)' | sed -n '1,320p' | red || true

echo "════════════════════════════════ SONDES LOCALES ══════════════════════════════"
for p in 3000 3001 4000 18790; do
  echo "--- 127.0.0.1:$p /api/health ---"
  curl -sv --max-time 6 "http://127.0.0.1:$p/api/health" 2>&1 | tail -4 | red || true
  echo "--- 127.0.0.1:$p /api/v1/ping ---"
  curl -sv --max-time 6 "http://127.0.0.1:$p/api/v1/ping" 2>&1 | tail -4 | red || true
done
echo "--- 8443 TLS (Host vpnsxb.afrihall.com) ---"
curl -skv --max-time 8 "https://127.0.0.1:8443/api/v1/ping" -H 'Host: vpnsxb.afrihall.com' 2>&1 | tail -8 | red || true

echo "════════════════════════════════ 4.4 BASE DE DONNÉES (SELECT uniquement) ═════"
cd /var/www/sxb-vpn 2>/dev/null || true
DB_URL=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'')
if [ -z "$DB_URL" ]; then
  echo "⚠️ DATABASE_URL introuvable dans .env — section DB ignorée"
elif ! command -v psql >/dev/null 2>&1; then
  echo "⚠️ psql absent du VPS — section DB ignorée"
else
  echo "--- tables publiques ---"
  psql "$DB_URL" -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;" 2>&1 | red || true
  echo "--- migrations prisma (si présentes) ---"
  psql "$DB_URL" -tAc "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 8;" 2>&1 | red || true
  echo "--- ABONNEMENT CIBLE 83ea8954 (colonnes masquées) ---"
  psql "$DB_URL" -x -c "SELECT s.id AS subscription_id, s.status, s.\"profileId\", s.\"clientId\", s.\"lastProvisionAt\", s.\"lastSyncAt\", s.\"startAt\", s.\"expireAt\", s.\"createdAt\" AS sub_created, s.\"updatedAt\" AS sub_updated, s.\"deviceId\", s.\"technicalProtocol\", s.\"displayProtocol\", p.id AS profile_id, p.name AS profile_name, p.protocol, p.host, p.port, p.tls, p.sni, p.network, p.path, p.method, p.\"payloadId\", (p.username IS NOT NULL) AS has_username, (p.password IS NOT NULL) AS has_password_enc, (p.\"jsonConfig\" IS NOT NULL) AS has_json_config, length(p.\"jsonConfig\") AS json_config_length, p.\"offlineValidDays\", p.status AS profile_status, p.\"createdAt\" AS profile_created, p.\"updatedAt\" AS profile_updated, pl.name AS payload_name, pl.host AS payload_host, pl.sni AS payload_sni, pl.port AS payload_port, length(pl.content) AS payload_length, pl.status AS payload_status FROM subscriptions s LEFT JOIN vpn_profiles p ON p.id = s.\"profileId\" LEFT JOIN ssh_payloads pl ON pl.id = p.\"payloadId\" WHERE s.id='83ea8954-8be7-4fda-a3af-03e6e61d2161';" 2>&1 | red || true
  echo "--- INVENTAIRE vpn_profiles (masqué) ---"
  psql "$DB_URL" -c "SELECT id, name, protocol, host, port, tls, sni, network, status, (username IS NOT NULL) AS has_user, (password IS NOT NULL) AS has_pass, (\"jsonConfig\" IS NOT NULL) AS has_json, \"payloadId\" IS NOT NULL AS has_payload, \"updatedAt\" FROM vpn_profiles ORDER BY \"updatedAt\" DESC LIMIT 20;" 2>&1 | red || true
  echo "--- inventaire ssh_accounts (masqué) ---"
  psql "$DB_URL" -c "SELECT id, name, host, port, mode, status, \"expireAt\", \"payloadId\" IS NOT NULL AS has_payload, \"updatedAt\" FROM ssh_accounts ORDER BY \"updatedAt\" DESC LIMIT 15;" 2>&1 | red || true
  echo "--- inventaire ssh_payloads (longueurs seulement) ---"
  psql "$DB_URL" -c "SELECT id, name, host, sni, port, length(content) AS content_len, status, \"updatedAt\" FROM ssh_payloads LIMIT 15;" 2>&1 | red || true
  echo "--- doublons profils ---"
  psql "$DB_URL" -c "SELECT host, port, protocol, count(*) FROM vpn_profiles GROUP BY 1,2,3 HAVING count(*)>1;" 2>&1 | red || true
  echo "--- devices liés aux abonnements ---"
  psql "$DB_URL" -c "SELECT \"subscriptionId\", \"deviceId\", \"activatedAt\", \"lastSeenAt\" FROM subscription_devices ORDER BY \"lastSeenAt\" DESC NULLS LAST LIMIT 10;" 2>&1 | red || true
  echo "--- enregistrements app récents ---"
  psql "$DB_URL" -c "SELECT \"deviceId\", platform, \"appVersion\", status, \"lastSeenAt\" FROM app_registrations ORDER BY \"lastSeenAt\" DESC LIMIT 10;" 2>&1 | red || true
fi

echo "════════════════════════════════ 4.5 TRANSPORT — VUE INTERNE VPS ═════════════"
for p in 22 444 443; do
  echo "--- bannière SSH 127.0.0.1:$p (5s) ---"
  timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$p && head -c 80 <&3" 2>&1 | red || true
  echo ""
done
echo "--- ssh-keyscan local 22/444/443 (clés publiques tronquées) ---"
ssh-keyscan -T 5 -p 22 127.0.0.1 2>&1 | awk '{print $1, $2, substr($3,1,24)"…"}' | red || true
ssh-keyscan -T 5 -p 444 127.0.0.1 2>&1 | awk '{print $1, $2, substr($3,1,24)"…"}' | red || true
ssh-keyscan -T 5 -p 443 127.0.0.1 2>&1 | awk '{print $1, $2, substr($3,1,24)"…"}' | red || true
echo "--- certificat TLS local 443 (SNI dashboard) ---"
echo | timeout 8 openssl s_client -connect 127.0.0.1:443 -servername vpnsxb.afrihall.com 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>&1 | red || true
echo "--- port BadVPN/UDPGW 7300 ---"
timeout 4 bash -c "exec 3<>/dev/tcp/127.0.0.1/7300 && echo TCP_7300_OUVERT || echo TCP_7300_FERMÉ" 2>&1 || true

echo "════════════════════════════════ FIN AUDIT INTERNE ═══════════════════════════"
exit 0
