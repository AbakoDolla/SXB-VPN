# XPanel (XNet) — Documentation d'Installation et Configuration
Generated: 2026-07-17

## Vue d'ensemble

Dans SXB VPN, "XPanel" = **XNet Panel** — un panel de gestion VPN personnalisé qui gère :
- Protocoles VPN : VLESS XTLS via sing-box
- SSH/Dropbear management
- Utilisateurs VPN (inbounds/outbounds)
- Métriques et monitoring en temps réel

**XNet n'est PAS x-ui** — x-ui est installé sur le VPS (`/usr/local/x-ui/`) mais son service est inactif. XNet est le panel opérationnel.

## Service XNet

```
Service: xnet.service (systemd)
Binaire: /opt/xnet/xnet-server
Frontend: /opt/xnet/dist/ (React SPA)
DB: /opt/xnet/data/xnet.db (SQLite)
Port: 18790 (interne, non exposé directement)
```

## Accès XPanel

| URL | Accès |
|-----|-------|
| http://141.95.112.93:8080/kqUtkMEvgdtx/ | IP directe (HTTP) |
| https://vpnsxb.afrihall.com:8443/kqUtkMEvgdtx/ | SSL (HTTPS) |

## Nginx Configuration (port 8080)

```nginx
server {
    listen 8080;
    server_name _;

    location = / {
        return 301 /kqUtkMEvgdtx/;
    }
    location ~* ^/assets/ {
        proxy_pass http://127.0.0.1:18790;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:18790/api/;
        add_header Access-Control-Allow-Origin "*" always;
    }
    location /kqUtkMEvgdtx {
        proxy_pass http://127.0.0.1:18790/kqUtkMEvgdtx;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## API XNet

### Authentification
```bash
# Login
POST http://localhost:18790/api/auth/login
Body: {"username": "admin", "password": "<password>"}
Response: {"token": "<JWT>", "username": "admin", "role": "Super Admin"}

# JWT expire en 24h — token auto-renouvelé par le backend SXB
```

### Endpoints Vérifiés

| Endpoint | Méthode | Auth | Description |
|----------|---------|------|-------------|
| /api/auth/login | POST | Non | Authentification |
| /api/auth/verify-totp | POST | Non | 2FA TOTP |
| /api/v1/ping | GET | Non | Health check |
| /api/system/info | GET | Bearer | Infos système (CPU/RAM/disk/VPN) |
| /api/users | GET | Bearer | Utilisateurs VPN |
| /api/inbounds | GET | Bearer | Configurations VPN inbound |
| /api/outbounds | GET | Bearer | Configurations VPN outbound |
| /api/settings | GET | Bearer | Paramètres XNet |
| /api/settings/token | GET | Bearer | API token |
| /api/settings/token/regenerate | POST | Bearer | Regénérer API token |
| /api/v1/live/metrics | WebSocket | Bearer | Métriques en temps réel |

### Données Système (exemple réel)
```json
{
  "cpu": {"usagePercent": 5.04},
  "ram": {"usedGB": 1.01, "totalGB": 3.73, "usagePercent": 27.14},
  "disk": {"usedGB": 14.69, "totalGB": 37.7, "usagePercent": 38.96},
  "singboxVersion": "1.13.13",
  "singboxRunning": true,
  "sshDaemonRunning": true,
  "onlineUsers": 0,
  "totalActiveUsers": 0
}
```

## Intégration Backend SXB ↔ XNet

Le backend SXB communique avec XNet via le service `XPanelServiceClass` :

```typescript
// /server/services/xpanel/index.ts
// Authentification automatique via /api/auth/login
// Token mis en cache 23h (JWT dure 24h)
// Config dans .env :
//   XPANEL_URL=http://localhost:18790
//   XPANEL_ADMIN_USERNAME=admin
//   XPANEL_ADMIN_PASSWORD=<password>
```

### Routes Backend SXB → XNet

| Route SXB | Action XNet |
|-----------|------------|
| GET /api/xpanel/status | testConnection() → /api/system/info |
| GET /api/xpanel/users | getUsers() → /api/users |
| GET /api/xpanel/configs | getConfigs() → /api/configs |
| POST /api/xpanel/sync | sync() → /api/sync |
| POST /api/xpanel/configs | createConfig() → /api/configs |
| DELETE /api/xpanel/configs/:id | deleteConfig() → /api/configs/:id |

## Statut des Services VPN

```
sing-box 1.13.13 ✅ running
SSH OpenSSH port 22 ✅ running
SSH Dropbear port 444 ✅ running
BadVPN UDPGW port 7300 ✅ running
```

## Commandes de Gestion

```bash
# Statut xnet
systemctl status xnet.service

# Restart xnet
sudo systemctl restart xnet.service

# Logs xnet
journalctl -u xnet.service -f

# Restart sing-box
sudo systemctl restart sing-box.service

# PM2 backend
pm2 restart sxb-backend
pm2 logs sxb-backend
```

## Problème Page Blanche — Résolution

**Cause racine** : L'`index.html` de XNet avait été modifié manuellement (ajout de code de capture d'erreurs JS) ce qui avait introduit un script bloquant et supprimé l'attribut `crossorigin` du tag CSS.

**Correction** : Restauration du fichier original depuis la sauvegarde `.bak`.

```bash
sudo cp /opt/xnet/dist/index.html.bak /opt/xnet/dist/index.html
sudo chown xnet:xnet /opt/xnet/dist/index.html
```

**Vérification** : Le titre de la page doit être `"پنل مدیریت ورودی‌های Sing-box"` (original persan).
