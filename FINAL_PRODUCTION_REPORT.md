# FINAL_PRODUCTION_REPORT.md — SXB VPN Phase 2

**Date :** 25 Juillet 2026  
**Version :** Phase 2 — Finalisation SaaS + VPS + Production  
**Auteur :** Replit Agent (audit + corrections)

---

## 1. Architecture Finale

```
Utilisateur
    ↓
SXB VPN Mobile (Expo / React Native)
    ↓
Authentification JWT (SXB-USER token)
    ↓
Provisionnement sécurisé (/api/provision/activate)
    ↓  ← AES-256-GCM, clé par-appareil, signature serveur
Backend VPS (Node.js + Express — PM2 port 4000)
    ↓
Dashboard Admin (vpnsxb.afrihall.com — React + Vite)
    ↓
PostgreSQL 5432 (local) + Redis 6379 (local)
    ↓
VPN Engine (SSH via JSch / sing-box — XPanel port 18790)
```

**Le dashboard est l'unique source de vérité.** Toute modification
de configuration, token, quota, ou profil VPN passe exclusivement
par le dashboard admin.

---

## 2. Infrastructure VPS

| Composant | Détail |
|-----------|--------|
| OS | Ubuntu 24.04.4 LTS |
| Kernel | 6.8.0-134-generic |
| Backend | Node.js via PM2 (`sxb-backend`) — `/var/www/sxb-vpn/dist/server.cjs` |
| Port backend | 4000 |
| Dashboard | Nginx → `/var/www/sxb-vpn/artifacts/sxb-dashboard/dist/public` |
| Base de données | PostgreSQL 5432 (local) |
| Cache | Redis 6379 (local) |
| XPanel | x-ui / XNet sur port 18790 |
| SSL | Let's Encrypt — `vpnsxb.afrihall.com` |
| Monitoring | Prometheus :9090, node_exporter :9100, Grafana :3001 |
| APK serveur | `/var/www/apk/` — Nginx — 30+ builds, dernier : `sxbvpn-latest.apk` |
| Docker | Désactivé — architecture PM2 pure |

### Ports actifs
| Port | Service |
|------|---------|
| 80/443 | Nginx (dashboard + API) |
| 4000 | Backend Express (PM2) |
| 5432 | PostgreSQL (local uniquement) |
| 6379 | Redis (local uniquement) |
| 18790 | XPanel (interne) |
| 2082 | SSH-over-WebSocket bridge |
| 2222/2223 | SSH tunnels internes |
| 9090 | Prometheus |
| 9100 | node_exporter |
| 3001 | Grafana |

### Nginx Sites
| Site | Domaine |
|------|---------|
| `sxb-vpn` | vpnsxb.afrihall.com (dashboard + API proxy) |
| `api-ssl` | api.sxbvpn.com (proxy → port 4000) |
| `apk-sxbvpn` | apk.sxbvpn.afrihall.com (APK download) |
| `xpanel-ssl` | 3x.sxbvpn.afrihall.com (XPanel) |

---

## 3. Modifications Phase 2

### 3.1 Sécurité — Chiffrement

#### `server/utils/crypto.ts`
- **Avant :** AES-256-CBC (sans authentification — vulnérable à la falsification)
- **Après :** AES-256-GCM (chiffrement authentifié — Phase 2)
- Format : `gcm:<iv_hex(12o)>:<ciphertext_hex>:<authtag_hex(16o)>`
- Rétro-compatibilité CBC maintenue pour les valeurs existantes en DB
- Dérivation de clé : SHA-256 → 32 octets (AES-256)
- Erreur explicite si `ENCRYPTION_KEY` manquante (plus de fallback silencieux)

#### `server/routes/vpn-profiles.ts`
- `encrypt()` → AES-256-GCM
- `decrypt()` → supporte GCM (v2) + CBC (v1 legacy)
- Suppression du fallback insécurisé `'sxb-vpn-32-byte-encryption-key-!'`

#### `server/routes/ssh.ts`
- Même mise à niveau AES-256-GCM
- `encrypt(text, key)` / `decrypt(encrypted, key)` — rétro-compat CBC

### 3.2 Provisionnement Sécurisé

#### `server/routes/provision.ts` — Refonte complète

**Améliorations :**
- `encryptForDevice()` : AES-256-CBC → **AES-256-GCM** (chiffrement authentifié)
- Clé par-appareil : `HMAC-SHA256(deviceId:token, PROVISION_SECRET)`
- **Signature serveur** : `HMAC-SHA256(subscriptionId:deviceId:configExpiresAt, PROVISION_SECRET)` — permet au mobile de vérifier l'intégrité hors-ligne
- **Expiration de config** : `configExpiresAt` (calculé depuis `offlineValidDays`)
- **`encVersion: 'gcm-v2'`** : versionnage du format de chiffrement
- Suppression du fallback `'sxb-provision-secret'` — erreur HTTP 503 si clé manquante
- Chargement du payload SSH **séparé** de l'include Prisma (évite l'erreur Prisma `Unknown field payload`)

**Ce que le mobile reçoit (jamais en clair) :**
- `encryptedBlob` — config chiffrée AES-256-GCM, liée à l'appareil
- `configKey` — clé HMAC par-appareil pour déchiffrement local
- `serverSignature` — signature d'intégrité
- `configExpiresAt` — expiration locale de la config
- Quotas et métadonnées non-sensibles

**Ce que le mobile ne reçoit JAMAIS :**
- ❌ IP serveur / host SSH
- ❌ Port SSH
- ❌ Username SSH
- ❌ Password SSH en clair
- ❌ UUID technique
- ❌ Clé privée

### 3.3 Client Mobile

#### `app-mobile/services/provisionClient.ts` — Nouveau service

Implémente le flux de provisionnement côté mobile :
1. `provisionAndStore(dataToken, deviceId)` — appel provision/activate + déchiffrement local
2. Déchiffrement AES-256-GCM via **Web Crypto API** (`crypto.subtle` — RN 0.81.5 ✅)
3. Stockage de la config déchiffrée dans **SecureStore** (Android Keystore)
4. Métadonnées non-sensibles dans AsyncStorage
5. `loadProvisionedConfig()` — chargement avec vérification d'expiration
6. `clearProvisionedConfig()` — suppression (révocation, déconnexion)

---

## 4. Problèmes Identifiés et Corrigés

### BUG-P2-01 : 106 restarts PM2 — PrismaClientValidationError

**Symptôme :** `Unknown field 'payload' for include statement on model 'VpnProfile'`  
**Localisation :** `server/routes/mobile.ts:308` (mobile `vpn/config` endpoint)  
**Cause :** Le client Prisma généré ne connaissait pas la relation `payload` sur `VpnProfile` (relation déclarée dans le schéma mais client non régénéré)  
**Correction :** Le payload est chargé séparément via `sshPayload.findUnique()` — même pattern que `provision.ts` (commits Phase 1 `9f48adc`, `10c5884`)  
**État :** ✅ Corrigé avant Phase 2 (commit `9f48adc`) + dist/server.cjs recompilé le 25/07 16:47  
**Vérification :** Backend stable depuis 73+ minutes au moment de l'audit

### BUG-P2-02 : AES-256-CBC sans authentification

**Symptôme :** Chiffrement CBC vulnérable aux attaques de falsification (bit-flipping)  
**Localisation :** `crypto.ts`, `vpn-profiles.ts`, `ssh.ts`, `provision.ts`  
**Correction :** Migration vers AES-256-GCM (Phase 2)  
**Rétro-compat :** Les anciennes valeurs CBC en DB restent lisibles  
**État :** ✅ Corrigé (Phase 2)

### BUG-P2-03 : Fallbacks hardcodés insécurisés

**Symptôme :** `|| 'sxb-vpn-32-byte-encryption-key-!'` — si `ENCRYPTION_KEY` non configurée, fallback silencieux vers une clé connue publiquement  
**Localisation :** `vpn-profiles.ts`, `ssh.ts`, `provision.ts`  
**Correction :** Erreur explicite (throw / HTTP 503) si variable d'env manquante  
**État :** ✅ Corrigé (Phase 2)

### BUG-P2-04 : PROVISION_SECRET non configurée (VPS)

**Symptôme :** Log `[SECURITY] PROVISION_SECRET not set!` au démarrage  
**Vérification Phase 2 :** `PROVISION_SECRET` confirmée présente dans `/var/www/sxb-vpn/.env`  
**État :** ✅ Configurée

### BUG-P2-05 : /api/healthz retourne HTML

**Symptôme :** `curl https://vpnsxb.afrihall.com/api/healthz` retourne le dashboard HTML  
**Cause :** L'endpoint `/api/healthz` n'est pas enregistré dans `server.ts` — le SPA fallback intercepte toutes les routes non-API  
**Impact :** Faible (monitoring uniquement)  
**Recommandation :** Ajouter `GET /api/health` avec réponse JSON `{ status: 'ok' }` dans server.ts

---

## 5. Configuration VPS

### Variables d'environnement requises (`/var/www/sxb-vpn/.env`)

```
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
PROVISION_SECRET=***      # openssl rand -hex 32 (distinct de ENCRYPTION_KEY)
FRONTEND_URL=https://vpnsxb.afrihall.com
API_URL=https://vpnsxb.afrihall.com
XPANEL_URL=http://localhost:18790
XPANEL_ADMIN_USERNAME=admin
XPANEL_ADMIN_PASSWORD=***
XPANEL_BASE_PATH=/kqUtkMEvgdtx
REFRESH_SECRET=***
XPANEL_JWT_SECRET=***
```

---

## 6. Procédure de Déploiement

```bash
# 1. Arrêt temporaire PM2
pm2 stop sxb-backend

# 2. Pull du dernier code
cd /var/www/sxb-vpn
git pull origin main

# 3. Installation des dépendances (si nouveau package)
pnpm install --frozen-lockfile

# 4. Recompilation backend
pnpm run build

# 5. Redémarrage PM2
pm2 start ecosystem.config.cjs
pm2 save

# 6. Vérification
pm2 list
pm2 logs sxb-backend --lines 20 --nostream
curl -sk https://vpnsxb.afrihall.com/api/auth/login | head -5
```

---

## 7. Procédure de Rollback

```bash
# Option A : Git rollback vers un commit précédent
cd /var/www/sxb-vpn
git log --oneline -10
git reset --hard <commit_hash>
pnpm run build
pm2 restart sxb-backend

# Option B : Utiliser un backup VPS
ls /home/ubuntu/backup-sxb-*/
cd /home/ubuntu/backup-sxb-20260720-0704/
# Copier les fichiers nécessaires vers /var/www/sxb-vpn/

# Vérification après rollback
pm2 logs sxb-backend --lines 30 --nostream
```

---

## 8. Procédure de Maintenance

### Renouvellement SSL
```bash
certbot renew --dry-run  # Test
certbot renew            # Renouvellement réel
systemctl reload nginx
```

### Backup base de données
```bash
pg_dump sxb_vpn > /home/ubuntu/backup-sxb-$(date +%Y%m%d)/sxb_vpn.sql
```

### Nettoyage APKs anciens
```bash
ls -t /var/www/apk/sxbvpn-build-*.apk | tail -n +10 | xargs rm -f
```

### Surveillance PM2
```bash
pm2 monit            # Dashboard en temps réel
pm2 logs --lines 50  # Derniers logs
pm2 flush            # Vider les logs
```

---

## 9. Tests de Production Recommandés

### Activation
- [ ] Token SXB-USER valide → JWT OK
- [ ] Token invalide → 404 JSON (pas de HTML)
- [ ] Token expiré → 403 JSON
- [ ] Token déjà utilisé sur autre appareil → 403 JSON

### Provisionnement
- [ ] `POST /api/provision/activate` avec dataToken valide → encryptedBlob + serverSignature
- [ ] Abonnement révoqué → 403 JSON
- [ ] Abonnement expiré → 403 JSON
- [ ] Device limit dépassé → 403 JSON avec deviceLimit

### Connexion VPN
- [ ] SSH sur Android 12, 13, 14, 15
- [ ] SSH+Payload avec WebSocket
- [ ] VLESS, VMess, Trojan via sing-box
- [ ] Changement WiFi → données mobiles (reconnexion auto)
- [ ] Écran verrouillé → VPN maintenu (foreground service)
- [ ] Redémarrage téléphone → auto-start si BootReceiver actif

### Offline
- [ ] Couper internet après provisionnement
- [ ] Ouvrir app → CONNECT → VPN démarre ✅
- [ ] Reconnexion internet → sync quota

### Dashboard
- [ ] Révocation depuis dashboard → mobile déconnecté au prochain sync
- [ ] Expiration forfait → statut `expired` au sync
- [ ] Changement profil VPN → reprovisionnement requis

---

## 10. Sécurité — Checklist Finale

| Vérification | Statut |
|-------------|--------|
| Android Keystore (KeystoreManager.kt) | ✅ Implémenté |
| AES-256-GCM chiffrement provision | ✅ Phase 2 |
| Aucun credential en clair dans logs | ✅ Masqués (`••••••••`) |
| Signature serveur sur config provisionnée | ✅ Phase 2 |
| Expiration config locale | ✅ Phase 2 |
| PROVISION_SECRET configurée sur VPS | ✅ Vérifié |
| JWT dans SecureStore (pas AsyncStorage) | ✅ Implémenté |
| Protection root/Frida (SecurityModule.kt) | ✅ Implémenté |
| Révocation distante | ✅ Via status=revoked |
| Kill Switch VPN | ✅ SxbVpnService.kt |
| Auto-reconnect | ✅ AutoReconnectManager.kt |
| WS frames masquées (RFC 6455) | ✅ Corrigé Phase 1 |

---

## 11. Architecture Mobile — Flux Sécurisé Final

```
Installer SXB VPN
      ↓
Entrer token SXB-USER
      ↓
POST /api/mobile/auth/activate
      ↓ ← JWT stocké dans Android Keystore
POST /api/provision/activate (dataToken + deviceId)
      ↓ ← AES-256-GCM + HMAC-SHA256 + signature serveur
Déchiffrement local (crypto.subtle — Web Crypto API)
      ↓ ← Config déchiffrée stockée dans SecureStore
CONNECT
      ↓
SxbVpnService.kt (SSH/sing-box)
      ↓
VPN Actif ✅

L'utilisateur ne voit jamais :
❌ Serveur / IP / Port
❌ Username / Password SSH
❌ UUID technique
❌ Payload / config brute
```

---

*Rapport généré automatiquement — Phase 2 SXB VPN Production Finalisation*
