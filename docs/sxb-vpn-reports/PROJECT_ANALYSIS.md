# SXB VPN — Project Analysis Report
Generated: 2026-07-17

## Architecture Actuelle

```
Internet
  │
  ├── vpnsxb.afrihall.com (nginx)
  │     ├── /api/*     → Backend Express (localhost:4000, PM2)
  │     ├── /xapi/*    → Backend Express (rewrite /xapi → /api)
  │     └── /*         → Dashboard SPA React (dist/index.html)
  │
  ├── vpnsxb.afrihall.com:8443 (nginx + SSL)
  │     └── /kqUtkMEvgdtx/* → XNet Panel (localhost:18790)
  │
  └── IP:8080 (nginx, sans SSL)
        └── /kqUtkMEvgdtx/* → XNet Panel (localhost:18790)

Backend Express (Port 4000) — /var/www/sxb-vpn/
├── server.ts              ← Entry point (Vite SPA + Express API)
├── server/
│   ├── routes/            ← 17 fichiers de routes API
│   │   ├── auth.ts        → /api/auth/*
│   │   ├── users.ts       → /api/users/*
│   │   ├── clients.ts     → /api/clients/*
│   │   ├── tokens.ts      → /api/tokens/*
│   │   ├── xpanel.ts      → /api/xpanel/*
│   │   ├── resellers.ts   → /api/resellers/*
│   │   ├── vouchers.ts    → /api/vouchers/*
│   │   ├── analytics.ts   → /api/analytics/*
│   │   ├── servers.ts     → /api/servers/*
│   │   ├── dashboard.ts   → /api/dashboard/*
│   │   ├── mobile.ts      → /api/mobile/*
│   │   ├── admin-tokens.ts→ /api/admin-tokens/*
│   │   ├── support.ts     → /api/support/*
│   │   ├── audit-logs.ts  → /api/audit-logs/*
│   │   ├── devices.ts     → /api/devices/*
│   │   ├── rbac.ts        → /api/rbac/*
│   │   └── vpn.ts         → /api/vpn/*
│   ├── services/
│   │   └── xpanel/        ← Intégration XNet
│   └── middleware/
│       └── auth.ts        ← JWT middleware

XNet Panel (Port 18790) — /opt/xnet/
├── xnet-server            ← Binaire Go (sing-box + SSH management)
├── dist/                  ← Frontend React SPA
│   ├── index.html
│   └── assets/
└── data/xnet.db           ← SQLite database

Database: PostgreSQL (localhost:5432)
├── sxb_vpn               ← Base principale (13 tables)
└── sxbvpn                ← Base secondaire (non utilisée)

Mobile App: https://vpnsxb.afrihall.com/api (base URL)
```

## Stack Technique

| Composant | Technologie |
|-----------|-------------|
| Backend | Node.js 22 + Express 4 + Prisma + PostgreSQL |
| Dashboard | React 19 + Vite + Tailwind CSS v4 |
| Mobile | Expo SDK 54 + React Native 0.81 |
| XPanel | XNet (binaire Go) + sing-box 1.13.13 |
| VPN Protocols | VLESS XTLS, SSH, Dropbear |
| Infra | Nginx (reverse proxy) + PM2 + Let's Encrypt |
| Monitoring | Prometheus + Grafana (port 3001) |

## Tables DB (PostgreSQL sxb_vpn)

| Table | Rôle |
|-------|------|
| users | Comptes dashboard (admin/support/reseller) |
| roles | SUPER_ADMIN, ADMIN, SUPPORT, RESELLER, CLIENT |
| permissions | Permissions granulaires |
| role_permissions | Many-to-many rôles ↔ permissions |
| vpn_clients | Clients VPN (token SXB-USER-XXXX) |
| tokens | Tokens SXB-DATA-XXXX |
| admin_tokens | Tokens SXB-ADMIN-XXXX (première connexion) |
| resellers | Informations revendeurs |
| servers | Serveurs VPS |
| vouchers | Codes voucher |
| support_tickets | Tickets support |
| audit_logs | Journal d'activité |
| xpanel_configs | Configurations XNet synchronisées |

## Problèmes Détectés

### CRITIQUE

| # | Problème | Statut |
|---|---------|--------|
| 1 | `GET /api/health` retourne HTML (fallback SPA) — route absente | ✅ CORRIGÉ |
| 2 | Xpanel service utilise `XPANEL_TOKEN` (inexistant) au lieu de login | ✅ CORRIGÉ |
| 3 | XNet index.html modifié (debug) → page blanche possible | ✅ CORRIGÉ |
| 4 | SSH username avec espace traînant → connexion VPS impossible | ✅ CORRIGÉ |

### MOYEN

| # | Problème | Statut |
|---|---------|--------|
| 5 | x-ui.service inactive (dead) — redondant avec XNet | INFO — xnet = seul panel |
| 6 | 2 bases DB (sxb_vpn + sxbvpn) — duplication | INFO — sxb_vpn est active |
| 7 | XPANEL_JWT_SECRET invalide (longueur 65 ≠ format xnet) | ✅ CORRIGÉ via login/password |

## Services Actifs sur le VPS

| Port | Service | Statut |
|------|---------|--------|
| 22 | OpenSSH | ✅ running |
| 80 | Nginx (http redirect + xnet ws) | ✅ running |
| 443 | Nginx (HTTPS sxb-vpn dashboard) | ✅ running |
| 444 | Dropbear SSH (xnet) | ✅ running |
| 4000 | Backend Express (PM2) | ✅ running |
| 5432 | PostgreSQL | ✅ running |
| 6379 | Redis | ✅ running |
| 7300 | BadVPN UDPGW | ✅ running |
| 8080 | Nginx → XNet Panel | ✅ running |
| 8443 | Nginx SSL → XNet Panel | ✅ running |
| 18790 | XNet server (interne) | ✅ running |
| 3001 | Grafana | ✅ running |
| 9090 | Prometheus | ✅ running |

## URLs de Production

| Service | URL |
|---------|-----|
| Dashboard SXB | https://vpnsxb.afrihall.com |
| API Backend | https://vpnsxb.afrihall.com/api |
| XPanel (XNet) | https://vpnsxb.afrihall.com:8443/kqUtkMEvgdtx/ |
| XPanel (IP) | http://141.95.112.93:8080/kqUtkMEvgdtx/ |
| Grafana | https://vpnsxb.afrihall.com/grafana/ |

## Corrections Nécessaires (Restantes)

1. Vérifier que tous les endpoints API retournent JSON (pas HTML)
2. Tester l'intégration XNet complète (create/delete/sync users)
3. Vérifier les permissions RBAC sur toutes les routes
4. Tester l'app mobile avec le backend réel
