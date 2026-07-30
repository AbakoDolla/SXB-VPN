#!/usr/bin/env bash
# remediation-vps.sh — Remédiation sécurité VPS (constats de l'audit Phase A)
# À EXÉCUTER PAR L'ADMINISTRATEUR SUR LE VPS, APRÈS la sauvegarde.
# Aucune action destructive : chaque étape demande confirmation.
# Aucun secret dans ce script.
set -uo pipefail

confirm() { read -r -p "$1 [o/N] " a; [ "${a:-N}" = "o" ] || [ "${a:-N}" = "O" ]; }
APP_DIR="${APP_DIR:-/var/www/sxb-vpn}"

echo "═══ Remédiation VPS SXB — audit du 2026-07-30 ═══"
echo "Prérequis : backup-sxb.sh exécuté et vérifié."
confirm "Continuer ?" || exit 0

# ── 1. PAT GitHub en clair dans l'URL du remote git ───────────────────────────
echo
echo "── 1. Nettoyage du remote git (un PAT historique y était lisible en clair) ──"
cd "$APP_DIR"
if git remote -v | grep -qE "https://[^/@]+@github.com"; then
  echo "   Remote actuel contient des credentials : $(git remote get-url origin | sed -E 's#https://[^/@]+@#https://***@#')"
  if confirm "   Remplacer par l'URL propre (repo public, pas de credential) ?"; then
    git remote set-url origin https://github.com/AbakoDolla/SXB-VPN.git
    echo "   ✅ Remote nettoyé."
  fi
else
  echo "   ✅ Remote déjà propre."
fi
echo "   Rappel : le PAT exposé a déjà été révoqué — aucune autre action requise."

# ── 2. Ports internes exposés publiquement ────────────────────────────────────
echo
echo "── 2. UFW : fermer Grafana(3001), Prometheus(9090), backend(4000) à Internet ──"
echo "   Ces services doivent rester accessibles en LOCAL (127.0.0.1) derrière Nginx,"
echo "   pas directement depuis le WAN."
for port in 3001/tcp 9090/tcp 4000/tcp; do
  if sudo ufw status | grep -qE "^${port%%/*}.*ALLOW"; then
    if confirm "   Fermer le port $port au WAN (ufw delete allow $port) ?"; then
      sudo ufw delete allow "$port"
      echo "   ✅ Port $port fermé au WAN."
    fi
  else
    echo "   ✅ $port déjà non exposé."
  fi
done
echo
echo "   ⚠️  Option renforcée : binder Grafana/Prometheus sur 127.0.0.1 dans leur"
echo "   configuration respective (grafana.ini http_addr, prometheus --web.listen-address)."

# ── 3. XNet arrêté (cause du 502 en :8443) ────────────────────────────────────
echo
echo "── 3. XNet (port 18790) est ARRÊTÉ — d'où le 502 derrière Nginx :8443 ──"
echo "   Deux options :"
echo "   a) Si XNet est encore utilisé : le relancer"
echo "        sudo systemctl enable --now xnet   (adapter au nom réel du service)"
echo "   b) Sinon : retirer le bloc nginx :8443 puis  sudo nginx -t && sudo systemctl reload nginx"
echo "   → Décision produit à prendre par vous. Aucune action automatique ici."

# ── 4. pnpm-lock.yaml modifié localement ─────────────────────────────────────
echo
echo "── 4. pnpm-lock.yaml local modifié sur le VPS ──"
echo "   Information : le workflow deploy-vps fait déjà 'git reset --hard origin/main'"
echo "   à chaque déploiement — la divergence sera écrasée proprement au prochain run."
echo "   Si le changement local était volontaire, sauvegardez-le AVANT le merge :"
echo "        cp $APP_DIR/pnpm-lock.yaml /var/backups/sxb-vpn/"

echo
echo "🟢 Remédiation interactive terminée."
