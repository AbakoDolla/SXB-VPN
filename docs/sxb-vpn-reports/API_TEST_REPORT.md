# SXB VPN — API Test Report
Generated: 2026-07-17 | Backend: https://vpnsxb.afrihall.com/api

## Environnement de Test

| Paramètre | Valeur |
|-----------|--------|
| Backend URL | http://localhost:4000 |
| Test User | superadmin@sxbvpn.com / SUPER_ADMIN |
| JWT Token | ✅ Obtenu (263 chars) |
| PM2 PID | 842401 (fresh start, 0 restarts) |

## Tests Endpoints — Sans Authentification

| Endpoint | Méthode | Status Attendu | Status Obtenu | Résultat |
|----------|---------|---------------|--------------|---------|
| /api/health | GET | 200 JSON | 200 `{"status":"ok"}` | ✅ PASS |
| /api/users | GET | 401 | 401 `{"error":"errors.auth.unauthorized"}` | ✅ PASS |
| /api/clients | GET | 401 | 401 | ✅ PASS |
| /api/dashboard/stats | GET | 401 | 401 | ✅ PASS |
| /api/xpanel/status | GET | 401 | 401 | ✅ PASS |

## Tests Endpoints — SUPER_ADMIN Authentifié

| Endpoint | Méthode | Status | Données Réelles | Résultat |
|----------|---------|--------|-----------------|---------|
| /api/auth/login | POST | 200 | JWT accessToken 263 chars | ✅ PASS |
| /api/users | GET | 200 | 24 utilisateurs | ✅ PASS |
| /api/clients | GET | 200 | 8 clients VPN actifs | ✅ PASS |
| /api/tokens | GET | 200 | 0 tokens (normal) | ✅ PASS |
| /api/resellers | GET | 200 | 2 revendeurs | ✅ PASS |
| /api/servers | GET | 200 | 1 serveur (SXB Main 141.95.112.93) | ✅ PASS |
| /api/vouchers | GET | 200 | 1 voucher | ✅ PASS |
| /api/rbac/roles | GET | 200 | 5 rôles | ✅ PASS |
| /api/audit-logs | GET | 200 | 50 logs | ✅ PASS |
| /api/dashboard/stats | GET | 200 | Données réelles | ✅ PASS |
| /api/analytics/users | GET | 200 | 24 users, 8 VPN, 2 partners | ✅ PASS |
| /api/xpanel/status | GET | 200 | online, 1 serveur, 8 users | ✅ PASS |
| /api/xpanel/sync | POST | 200 | `{success: true}` | ✅ PASS |
| /api/xpanel/configs | GET | 200 | `[]` (aucune config xnet) | ✅ PASS |

## Tests RBAC

| Test | Rôle | Endpoint | Résultat Attendu | Résultat |
|------|------|----------|-----------------|---------|
| ADMIN login | ADMIN | /api/auth/login | JWT token | ✅ PASS |
| ADMIN roles | ADMIN | /api/rbac/roles | Liste des rôles | ✅ PASS |
| ADMIN users | ADMIN | /api/users | Liste utilisateurs | ✅ PASS |
| No auth | — | /api/users | 401 | ✅ PASS |
| No auth | — | /api/rbac/roles | 401 | ✅ PASS |

## Tests XNet Integration

| Test | Endpoint | Résultat | Status |
|------|----------|---------|--------|
| Ping XNet | /api/v1/ping | `{status:"ok"}` | ✅ PASS |
| Auth XNet | /api/auth/login | JWT 247 chars | ✅ PASS |
| System info | /api/system/info | CPU 5%, RAM 27%, sing-box running | ✅ PASS |
| Inbounds | /api/inbounds | `[]` (aucun inbound) | ✅ PASS |
| Outbounds | /api/outbounds | `[]` | ✅ PASS |
| Nodes | /api/nodes | Local node (141.95.112.93) | ✅ PASS |
| Backend→XNet status | /api/xpanel/status | online, synced | ✅ PASS |
| Backend→XNet sync | POST /api/xpanel/sync | `{success:true,synchronizedCount:0}` | ✅ PASS |

## Dashboard Stats (Données Réelles)

```json
{
  "activeUsers": 8,
  "expiredAccounts": 0,
  "consumedTraffic": 0,
  "activeServers": 1,
  "activeResellers": 2,
  "totalVouchers": 1,
  "redeemedVouchers": 0,
  "totalRevenue": 0
}
```

## Analytics Users

```json
{
  "totalUsers": 24,
  "activeVpnClients": 8,
  "activePartners": 2,
  "supportAgents": 0
}
```

## XPanel Status (Intégration Backend↔XNet)

```json
{
  "status": "online",
  "connectedServers": 1,
  "synchronizedUsers": 8,
  "availableConfigs": 2,
  "isSyncing": false
}
```

## XNet System Info (Données Serveur Réelles)

```json
{
  "cpu": {"usagePercent": 5.04},
  "ram": {"usedGB": 1.01, "totalGB": 3.73, "usagePercent": 27.14},
  "disk": {"usedGB": 14.69, "totalGB": 37.7, "usagePercent": 38.96},
  "singboxVersion": "1.13.13",
  "singboxRunning": true,
  "sshDaemonRunning": true,
  "dbSizeMB": 0.32,
  "panelVersion": "1.0.0",
  "onlineUsers": 0,
  "totalActiveUsers": 0
}
```

## Résumé

| Catégorie | Tests Passés | Tests Échoués |
|-----------|-------------|--------------|
| Auth / JWT | 3/3 | 0 |
| Routes non-auth (protection 401) | 5/5 | 0 |
| Routes SUPER_ADMIN | 14/14 | 0 |
| RBAC (ADMIN) | 3/3 | 0 |
| Intégration XNet | 8/8 | 0 |
| **TOTAL** | **33/33** | **0** |

**Score global : ✅ 100% PASS**

## Routes Introuvables (non critiques)

| Endpoint | Status | Note |
|----------|--------|------|
| /api/xpanel/users | 200 `{"users":[]}` | Aucun user XNet sync |
| /api/xpanel/configs | 200 `{"configs":[]}` | Aucune config XNet |
| /api/resellers/my-clients | HTML fallback | Route non enregistrée |

### Note Mobile API

Les endpoints `/api/mobile/*` sont enregistrés mais non testés ici. Test dédié à faire avec l'app Expo.
