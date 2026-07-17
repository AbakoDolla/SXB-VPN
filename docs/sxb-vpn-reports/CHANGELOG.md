# SXB VPN — Changelog

## [2026-07-17] — Repair & Integration Mission

### PHASE 1 — Analyse du projet
- Cloné le repository GitHub `AbakoDolla/SXB-VPN`
- Analysé l'architecture complète : backend Express, dashboard React, mobile Expo, XNet panel
- Créé `PROJECT_ANALYSIS.md` avec architecture détaillée, tables DB, URLs de production

### PHASE 2 — Connexion VPS
- Diagnostiqué et corrigé le problème de connexion SSH (espace traînant dans `VPS_USERNAME`)
- Cartographié tous les services actifs : nginx, PM2, PostgreSQL, Redis, XNet, sing-box
- Créé `VPS_STATUS_REPORT.md` avec état complet du VPS

### PHASE 3 — Sauvegarde
- Créé backup préventif : `/home/ubuntu/backup-sxb-20260717-1119/`
  - `xnet-index.html` (original)
  - `xpanel-service/` (original)
  - `xpanel-route.ts` (original)
  - `nginx-xpanel-ip.conf` (original)

### PHASE 4 — XPanel (XNet) — Audit
- Identifié que "XPanel" = XNet Panel (binaire `/opt/xnet/xnet-server`)
- x-ui est installé mais inactive (désactivé)
- XNet écoute sur port 18790 (interne), exposé via nginx sur 8080 et 8443
- Créé `XPANEL_INSTALLATION.md`

### PHASE 5 — Fix Page Blanche XPanel

**Cause identifiée** : `index.html` modifié manuellement (code debug JS + suppression `crossorigin`)

**Correction** :
```bash
sudo cp /opt/xnet/dist/index.html.bak /opt/xnet/dist/index.html
sudo chown xnet:xnet /opt/xnet/dist/index.html
```

### PHASE 6 — Intégration Backend ↔ XNet

**Problème identifié** :
- Le service xpanel utilisait `XPANEL_TOKEN` (variable inexistante)
- L'auth XNet se fait via `POST /api/auth/login` (pas Bearer static)
- Route `/api/health` absente → backend renvoyait HTML (fallback SPA)

**Corrections** :
1. **Réécriture `server/services/xpanel/index.ts`** :
   - Authentification via `POST /api/auth/login` avec XPANEL_ADMIN_USERNAME/PASSWORD
   - Cache JWT 23h (token expire en 24h)
   - Auto-renouvellement sur erreur 401
   - Méthode `testConnection()` via `GET /api/system/info`
   - Fallback gracieux (retourne tableau vide si XNet inaccessible)

2. **Ajout route health dans `server.ts`** :
   ```
   GET /api/health → {"status":"ok","timestamp":"...","service":"sxb-vpn-backend"}
   ```

3. **Rebuild backend** : `npm run build` → `dist/server.cjs` (165.4KB)

4. **Redémarrage PM2** : `sxb-backend` ✅ online

### PHASE 7 — Tests Intégration

| Test | Résultat |
|------|---------|
| XNet login `POST /api/auth/login` | ✅ Token JWT 247 chars |
| XNet `GET /api/system/info` | ✅ CPU/RAM/disk réels |
| XNet `GET /api/v1/ping` | ✅ `{"status":"ok"}` |
| XNet `GET /api/inbounds` | ✅ `[]` (aucun VPN configuré) |
| XNet `GET /api/nodes` | ✅ Node local IP 141.95.112.93 |
| Backend `GET /api/health` | ✅ JSON `{"status":"ok"}` |
| Backend `POST /api/auth/login` | ✅ Validation fonctionne |
| Backend `GET /api/users` | ✅ 401 sans auth |
| Backend `GET /api/dashboard/stats` | ✅ 401 sans auth |

### PHASE 8-9 — Dashboard + RBAC Tests

**Comptes détectés en DB** :

| Email | Rôle | Statut |
|-------|------|--------|
| superadmin@sxbvpn.com | SUPER_ADMIN | active |
| test_super_admin_..@test.com | SUPER_ADMIN | active |
| admin@sxbvpn.com | ADMIN | active |
| evansabah2006@gmail.com | RESELLER | active |

**Crédentiels SUPER_ADMIN** :
- Email: `superadmin@sxbvpn.com`
- Password: `Admin@123456`

### Fichiers Modifiés

| Fichier | Type | Action |
|---------|------|--------|
| `/var/www/sxb-vpn/server.ts` | Backend | Ajout route `/api/health` |
| `/var/www/sxb-vpn/server/services/xpanel/index.ts` | Backend | Réécriture complète auth XNet |
| `/opt/xnet/dist/index.html` | XPanel | Restauration depuis backup |
| `PROJECT_ANALYSIS.md` | Doc | Créé |
| `VPS_STATUS_REPORT.md` | Doc | Créé |
| `XPANEL_INSTALLATION.md` | Doc | Créé |
| `CHANGELOG.md` | Doc | Créé |
| `API_TEST_REPORT.md` | Doc | Créé |
| `SXB_FINAL_SYSTEM_REPORT.md` | Doc | Créé |
