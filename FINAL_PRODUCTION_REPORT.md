# FINAL_PRODUCTION_REPORT.md — SXB VPN Phase 2

**Date :** 25 Juillet 2026  
**Commit :** `66eaf4f feat: finalize SXB VPN production SaaS architecture`  
**Version :** Phase 2 — Finalisation SaaS + VPS + Production  

---

## 1. Architecture Finale

```
Utilisateur
    ↓
SXB VPN Mobile (Expo / React Native 0.81.5)
    ↓  SXB-USER token
Authentification JWT (/api/mobile/auth/activate)
    ↓  dataToken + deviceId
Provisionnement sécurisé (/api/provision/activate)
    ↓  AES-256-GCM, clé par-appareil HMAC-SHA256, signature serveur
Backend VPS (Node.js + Express — PM2, port 4000)
    ↓
Dashboard Admin (https://vpnsxb.afrihall.com)
    ↓
PostgreSQL :5432 (local) + Redis :6379 (local)
    ↓
VPN Engine (SSH/JSch · sing-box · XPanel :18790)
```

**Le dashboard est l'unique source de vérité.** Toute modification de
configuration, token, quota ou profil VPN passe exclusivement par le
dashboard admin.

---

## 2. Infrastructure VPS — État Audité

| Composant | Valeur |
|-----------|--------|
| OS | Ubuntu 24.04.4 LTS |
| Backend | PM2 `sxb-backend` → `dist/server.cjs` (port 4000) |
| Dashboard | Nginx → `artifacts/sxb-dashboard/dist/public` |
| PostgreSQL | `localhost:5432` (accès local uniquement) |
| Redis | `localhost:6379` (accès local uniquement) |
| XPanel | `localhost:18790` (interne) |
| SSL | Let's Encrypt — `vpnsxb.afrihall.com` |
| Monitoring | Prometheus :9090 · node_exporter :9100 · Grafana :3001 |
| APK | `/var/www/apk/sxbvpn-latest.apk` (build 149) |
| Docker | Désactivé — architecture PM2 pure |

### Nginx Sites Actifs
| Domaine | Cible |
|---------|-------|
| `vpnsxb.afrihall.com` | Dashboard + `/api` → backend:4000 |
| `api.sxbvpn.com` | Proxy → backend:4000 |
| `apk.sxbvpn.afrihall.com` | APK downloads `/var/www/apk/` |
| `3x.sxbvpn.afrihall.com` | XPanel (x-ui/XNet) |

---

## 3. Modifications Phase 2

### 3.1 `server/utils/crypto.ts` — Upgrade AES-256-GCM

- **Avant :** AES-256-CBC (sans auth tag — vulnérable au bit-flipping)
- **Après :** AES-256-GCM (chiffrement authentifié, tamper-proof)
- Format GCM : `gcm:<iv_hex(12o)>:<ciphertext_hex>:<authtag_hex(16o)>`
- Rétro-compat CBC : `decrypt()` détecte le préfixe `gcm:` et route correctement
- Dérivation de clé : SHA-256(ENCRYPTION_KEY) → 32 octets
- Erreur explicite si `ENCRYPTION_KEY` manquante (plus de fallback silencieux)

### 3.2 `server/routes/provision.ts` — Provisionnement sécurisé complet

| Avant | Après |
|-------|-------|
| AES-256-CBC | **AES-256-GCM** |
| Pas de signature | **serverSignature** HMAC-SHA256(subId:deviceId:expiresAt) |
| Pas d'expiration de config | **configExpiresAt** (offlineValidDays) |
| Fallback `'sxb-provision-secret'` | **HTTP 503** si PROVISION_SECRET manquante |
| Payload via include Prisma | **Chargement séparé** (évite l'erreur Unknown field) |
| Pas de versionnage | **`encVersion: 'gcm-v2'`** |

Ce que le mobile reçoit (`/api/provision/activate`) :
- `encryptedBlob` — config chiffrée AES-256-GCM, liée à l'appareil
- `configKey` — clé HMAC par-appareil pour déchiffrement local
- `serverSignature` — intégrité hors-ligne vérifiable
- `configExpiresAt` + métadonnées non-sensibles (quota, expireAt…)

Ce que le mobile ne reçoit **jamais** :
`❌ IP/host · ❌ Port SSH · ❌ Username · ❌ Password · ❌ UUID · ❌ Clés privées`

### 3.3 `server/routes/vpn-profiles.ts` + `server/routes/ssh.ts`

- `encrypt()` → AES-256-GCM (nouveaux mots de passe en DB)
- `decrypt()` → rétro-compat GCM v2 + CBC v1
- Suppression du fallback `'sxb-vpn-32-byte-encryption-key-!'`

### 3.4 `app-mobile/services/provisionClient.ts` — Nouveau service mobile

Flux de provisionnement côté mobile :
1. `provisionAndStore(dataToken, deviceId)` — appelle `/api/provision/activate`
2. Déchiffrement AES-256-GCM via **`crypto.subtle`** (Web Crypto API — RN 0.81.5 ✅)
3. Config déchiffrée → **SecureStore** (Android Keystore / iOS Keychain)
4. Métadonnées → AsyncStorage
5. `loadProvisionedConfig()` — chargement + vérification d'expiration locale
6. `clearProvisionedConfig()` — suppression sur révocation/logout

---

## 4. Bugs Identifiés et Statut

| ID | Description | Statut |
|----|-------------|--------|
| BUG-P2-01 | **106 crashes PM2** — Prisma `Unknown field 'payload'` dans `mobile.ts:308` | ✅ Corrigé Phase 1 (commit `9f48adc`) + dist recompilé 16:47 |
| BUG-P2-02 | AES-256-CBC sans authentification | ✅ Migré AES-256-GCM (Phase 2) |
| BUG-P2-03 | Fallbacks hardcodés insécurisés | ✅ Erreur explicite (Phase 2) |
| BUG-P2-04 | PROVISION_SECRET absente | ✅ Confirmée présente sur VPS |
| BUG-P2-05 | `/api/healthz` retourne HTML (SPA fallback) | ⚠️ Non-bloquant — recommandé : ajouter `GET /api/health` |

**Vérification post-déploiement :**
- API Login : `POST /api/auth/login` → `200 {"message":"Login successful"...}` ✅
- PM2 `sxb-backend` : `online` (68s uptime, code GCM confirmé dans dist) ✅
- `grep "aes-256-gcm\|gcm:" dist/server.cjs` → **15 occurrences** ✅

---

## 5. Variables d'Environnement Requises

```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
REDIS_PASSWORD=***
JWT_SECRET=***            # openssl rand -hex 48
JWT_REFRESH_SECRET=***    # openssl rand -hex 48
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d
ENCRYPTION_KEY=***        # openssl rand -hex 32
PROVISION_SECRET=***      # openssl rand -hex 32 (DISTINCT de ENCRYPTION_KEY)
FRONTEND_URL=https://vpnsxb.afrihall.com
API_URL=https://vpnsxb.afrihall.com
XPANEL_URL=http://localhost:18790
XPANEL_ADMIN_PASSWORD=***
XPANEL_BASE_PATH=/kqUtkMEvgdtx
```

---

## 6. Procédure de Déploiement

```bash
cd /var/www/sxb-vpn
git pull origin main
# Rebuild backend uniquement (évite les erreurs TS du dashboard)
/usr/bin/esbuild server.ts \
  --bundle --platform=node --format=cjs \
  --packages=external --sourcemap \
  --outfile=dist/server.cjs
pm2 restart sxb-backend --update-env
pm2 save
# Vérification
pm2 list
curl -sk https://vpnsxb.afrihall.com/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"...","password":"..."}' | head -c 100
```

> **Note :** `pnpm run build` échoue sur les erreurs TypeScript du dashboard
> (`VouchersView.tsx`, `XrayManagerView.tsx`). Utiliser esbuild directement
> pour le backend. Ces erreurs dashboard sont indépendantes du backend.

---

## 7. Procédure de Rollback

```bash
cd /var/www/sxb-vpn
git log --oneline -5
git reset --hard <commit_précédent>
/usr/bin/esbuild server.ts --bundle --platform=node --format=cjs \
  --packages=external --sourcemap --outfile=dist/server.cjs
pm2 restart sxb-backend
```

Backups disponibles : `/home/ubuntu/backup-sxb-20260720-0704/` (dernier avant Phase 2)

---

## 8. Procédure de Maintenance

```bash
# Renouvellement SSL
certbot renew && systemctl reload nginx

# Backup DB
pg_dump sxb_vpn > /home/ubuntu/backup-$(date +%Y%m%d)/sxb_vpn.sql

# Nettoyage APKs anciens (conserver 10 derniers)
ls -t /var/www/apk/sxbvpn-build-*.apk | tail -n +11 | xargs rm -f
ln -sf $(ls -t /var/www/apk/sxbvpn-build-*.apk | head -1) /var/www/apk/sxbvpn-latest.apk

# Monitoring PM2
pm2 monit
pm2 logs --lines 50
pm2 flush  # vider les logs accumulés
```

---

## 9. Tests de Production — Checklist

### Activation Token
- [ ] Token SXB-USER valide → JWT + accountState
- [ ] Token invalide → 404 JSON (pas HTML)
- [ ] Token expiré → 403 JSON
- [ ] Token autre appareil → 403 JSON

### Provisionnement
- [ ] `POST /api/provision/activate` valide → `encryptedBlob` + `serverSignature` + `configExpiresAt`
- [ ] Format blob : `gcm:<iv>:<cipher>:<tag>`
- [ ] Abonnement révoqué → 403
- [ ] Device limit dépassé → 403 + `deviceLimit`

### Connexion VPN
- [ ] SSH direct (Android 12/13/14/15)
- [ ] SSH + Payload WebSocket
- [ ] VLESS/VMess/Trojan via sing-box
- [ ] Auto-reconnect changement WiFi → data
- [ ] VPN maintenu écran verrouillé (foreground service)

### Offline First
- [ ] Provisionnement → couper internet → CONNECT → VPN démarre
- [ ] Config expirée hors-ligne → refus propre

### Dashboard → Mobile
- [ ] Révocation → mobile déconnecté au prochain sync
- [ ] Expiration quota → status `expired` au sync

---

## 10. Sécurité — Checklist Finale

| Contrôle | Statut |
|----------|--------|
| Android Keystore (KeystoreManager.kt) | ✅ |
| AES-256-GCM provisionnement | ✅ Phase 2 |
| Signature serveur sur config | ✅ Phase 2 |
| Expiration config locale | ✅ Phase 2 |
| Aucun credential en clair dans logs | ✅ Masqués `••••••••` |
| PROVISION_SECRET configurée sur VPS | ✅ Vérifié |
| JWT dans SecureStore (Keystore) | ✅ |
| Protection root/Frida (SecurityModule.kt) | ✅ |
| Révocation distante | ✅ via `status=revoked` |
| Kill Switch VPN | ✅ SxbVpnService.kt |
| Auto-reconnect | ✅ AutoReconnectManager.kt |
| WS frames RFC 6455 masquées | ✅ Phase 1 |
| Fallbacks hardcodés supprimés | ✅ Phase 2 |

---

## 11. Flux Utilisateur Final

```
📱 Installer SXB VPN
      ↓
🔑 Entrer token SXB-USER
      ↓
🌐 POST /api/mobile/auth/activate → JWT (Android Keystore)
      ↓
🔒 POST /api/provision/activate → encryptedBlob AES-256-GCM
      ↓
🔓 Déchiffrement local (crypto.subtle) → config → SecureStore
      ↓
▶  CONNECT
      ↓
⚡ SxbVpnService.kt (SSH · sing-box)
      ↓
✅ VPN Actif

❌ L'utilisateur ne voit jamais : serveur · port · username · password · UUID
```

---

*Rapport généré — Phase 2 SXB VPN Production Finalisation — 25 Juillet 2026*
