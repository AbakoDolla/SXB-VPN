# SXB VPN — VPS Status Report
Generated: 2026-07-17 | VPS: 141.95.112.93

## Informations Système

| Paramètre | Valeur |
|-----------|--------|
| OS | Ubuntu 24.04.4 LTS (Noble) |
| Kernel | Linux 6.8.0-134-generic |
| CPU | Intel Core (Haswell) × 2 cores |
| RAM Total | 3.73 GB |
| RAM Utilisée | ~1.0 GB (27%) |
| Disk Total | 38 GB |
| Disk Utilisé | 15 GB (39%) |
| Uptime | 8 jours (stable) |

## Services Systemd

| Service | Statut | Note |
|---------|--------|------|
| nginx.service | ✅ active (running) | Reverse proxy |
| docker.service | ✅ active (running) | Installé mais 0 containers |
| postgresql | ✅ active (running) | Port 5432 local |
| redis | ✅ active (running) | Port 6379 local |
| xnet.service | ✅ active (running) | XNet Panel port 18790 |
| sing-box.service | ✅ active (running) | VPN engine |
| dropbear.service | ✅ active (running) | SSH alt port 444 |
| badvpn-udpgw.service | ✅ active (running) | UDP forward |
| grafana-server.service | ✅ active (running) | Monitoring |
| node_exporter.service | ✅ active (running) | Prometheus metrics |
| fail2ban.service | ✅ active (running) | Sécurité |
| x-ui.service | ⚠️ inactive (dead) | X-UI installé mais désactivé |

## PM2 Processes

| App | PID | Status | Restarts | RAM |
|-----|-----|--------|---------|-----|
| sxb-backend | 841628 | ✅ online | 1 | ~120MB |

## Bases de Données PostgreSQL

| Base | Propriétaire | Tables | Utilisation |
|------|-------------|--------|------------|
| sxb_vpn | postgres | 13 | ✅ Active (production) |
| sxbvpn | sxbvpn_user | ? | ⚠️ Secondaire (non utilisée) |
| postgres | postgres | - | Système |

### Tables sxb_vpn
```
admin_tokens, audit_logs, permissions, resellers, role_permissions,
roles, servers, support_tickets, tokens, users, vouchers,
vpn_clients, xpanel_configs
```

### Utilisateurs en DB (sample)
- Test Admin (testadmin_1784167841@sxbvpn.com) — ADMIN
- Evans (evansabah2006@gmail.com) — RESELLER
- Evansabah (evansabah@gmail.com) — RESELLER

**⚠️ IMPORTANT : Aucun compte SUPER_ADMIN détecté dans les 5 premiers résultats.**
Vérifier qu'un compte SUPER_ADMIN existe pour l'accès complet au dashboard.

## Nginx Sites Actifs

| Site | Domaine | Port | Backend |
|------|---------|------|---------|
| sxb-vpn | vpnsxb.afrihall.com | 443 SSL | localhost:4000 |
| xpanel-ssl | vpnsxb.afrihall.com | 8443 SSL | localhost:18790 |
| xpanel-ip | _ (any) | 8080 | localhost:18790 |
| apk-sxbvpn | - | - | /var/www/apk/ |
| sxb-api | api.sxbvpn.afrihall.com | 443 | localhost:4001 (inactif) |

## XNet Panel (Port 18790)

| Paramètre | Valeur |
|-----------|--------|
| Version | 1.0.0 |
| sing-box | 1.13.13 ✅ running |
| SSH daemon | ✅ running |
| Online users | 0 |
| Total active users | 0 |
| Traffic today | 0 bytes |
| DB size | 0.32 MB |
| Auth endpoint | POST /api/auth/login |
| System info | GET /api/system/info (Bearer token) |
| Ping | GET /api/v1/ping |

## Certificats SSL

- Domaine: vpnsxb.afrihall.com
- Fournisseur: Let's Encrypt
- Certificat: /etc/letsencrypt/live/vpnsxb.afrihall.com/

## Ports Ouverts (ss -tlnp)

```
0.0.0.0:22     OpenSSH
0.0.0.0:80     Nginx HTTP
0.0.0.0:443    Nginx HTTPS
0.0.0.0:444    Dropbear SSH
0.0.0.0:4000   Backend Express
0.0.0.0:8080   XNet (via nginx)
0.0.0.0:8443   XNet SSL (via nginx)
127.0.0.1:2222 SSH interne
127.0.0.1:5432 PostgreSQL
127.0.0.1:6379 Redis
127.0.0.1:7300 BadVPN UDPGW
127.0.0.1:20091 Sing-box
*:3001         Grafana
*:9090         Prometheus
*:9100         Node Exporter
*:18790        XNet server
```

## Statut Global

| Composant | Statut | Note |
|-----------|--------|------|
| VPS Connectivité | ✅ OK | SSH fonctionnel |
| Backend Express | ✅ OK | PM2 en ligne |
| Dashboard SPA | ✅ OK | Build déployé |
| XNet Panel | ✅ OK | API fonctionnelle |
| PostgreSQL | ✅ OK | 13 tables en prod |
| Redis | ✅ OK | Local |
| Nginx | ✅ OK | 4 sites actifs |
| SSL Certificates | ✅ OK | Let's Encrypt |
| sing-box (VPN) | ✅ OK | v1.13.13 |

## Sauvegardes effectuées

- `/home/ubuntu/backup-sxb-20260717-1119/` — Avant modifications
  - xnet-index.html (original)
  - xpanel-service/ (original)
  - xpanel-route.ts (original)
  - nginx-xpanel-ip.conf (original)
