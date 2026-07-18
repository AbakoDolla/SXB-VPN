# SXB VPN — RAPPORT D’AUDIT SYSTEME COMPLET
**Date :** 17 juillet 2026  
**Auditeur :** Agent technique (audit automatise + tests reels)  
**Serveur :** VPS 141.95.112.93 (OVH, Ubuntu 24.04.4 LTS)  
**Dashboard :** https://vpnsxb.afrihall.com

---

## 1. INFRASTRUCTURE VPS

| Composant | Statut | Details |
|-----------|--------|---------|
| OS | OK | Ubuntu 24.04.4 LTS |
| CPU | OK | 2 vCPUs, ~2-3% utilisation |
| RAM | OK | 3.73 GB total, ~27% utilise (1 GB) |
| Disque | OK | 37.7 GB total, 38% utilise (14 GB) |
| Uptime | OK | 9+ jours sans interruption |

### Services actifs (systemd)
| Service | Statut |
|---------|--------|
| nginx | ACTIF |
| postgresql (16) | ACTIF |
| redis | ACTIF |
| xnet (XNet panel) | ACTIF |
| sing-box | ACTIF |
| fail2ban | ACTIF |

---

## 2. BACKEND API

### Gestion du processus
- AVANT : Backend Node.js lance en root (PIDs 762737/762749/762750), hors PM2
- APRES : PM2 ubuntu (PID 767548), non-root, pm2 save effectue
- URL : http://localhost:4000 -> https://vpnsxb.afrihall.com

### Tests endpoints (authentifie SUPER_ADMIN)

| Endpoint | Methode | HTTP | Resultat |
|----------|---------|------|----------|
| /api/auth/login | POST | 200 | JWT access + refresh tokens |
| /api/users | GET | 200 | 23 utilisateurs |
| /api/clients | GET | 200 | 7 clients VPN |
| /api/tokens | GET | 200 | Liste tokens |
| /api/servers | GET | 200 | 1 serveur |
| /api/analytics/users | GET | 200 | totalUsers:23, activeVpnClients:7 |
| /api/dashboard/stats | GET | 200 | 7 actifs, 2 revendeurs |
| /api/xpanel/status | GET | 200 | status:online, synchronizedUsers:7 |
| /api/xpanel/sync | POST | 200 | synchronizedCount:0 |
| /api/rbac/roles | GET | 200 | 5 roles |
| /api/resellers | GET | 200 | 2 revendeurs |
| /api/vouchers | GET | 200 | 1 voucher actif |
| /api/audit-logs | GET | 200 | Logs en temps reel |
| /api/support | GET | 200 | 0 tickets |
| /api/devices | GET | 200 | 7 appareils |
| /api/vpn/stats | GET | 200 | uptime, sing-box, DB stats |
| /api/docs | GET | 200 | Swagger UI accessible |

### Securite API
| Test | Resultat |
|------|----------|
| Acces sans token | REFUSE (errors.auth.unauthorized) |
| Token invalide | REFUSE (errors.auth.invalid_token) |
| SUPPORT accede RBAC config | REFUSE |
| SUPPORT supprime utilisateur | REFUSE |
| SUPER_ADMIN cree utilisateur | AUTORISE |

---

## 3. BASE DE DONNEES POSTGRESQL

| Table | Enregistrements |
|-------|-----------------|
| users | 23 |
| roles | 5 |
| vpn_clients | 7 |
| servers | 1 |
| resellers | 2 |
| vouchers | 1 |
| audit_logs | Actifs |

---

## 4. XNET PANEL (XPanel)

| Test | Resultat |
|------|----------|
| Auth /api/auth/login | JWT token obtenu |
| /api/system/info | CPU:2.77%, RAM:25.4%, sing-box running |
| /api/core/status | sing-box 1.13.13 running |
| /api/inbounds | VIDE (aucun inbound VPN configure) |
| /api/nodes | 1 noeud "Local Server" (141.95.112.93) |
| Backend <-> XNet | status:online apres correction |

---

## 5. SING-BOX VPN

| Aspect | Etat |
|--------|------|
| Service | ACTIF |
| Version | sing-box 1.13.13 |
| Inbounds | NULL - aucun protocole VPN actif |
| Outbounds | direct, block |

ACTION REQUISE : configurer des inbounds VPN dans XNet (Shadowsocks 2022, VLESS-Reality, etc.)

---

## 6. APPLICATION MOBILE

| Element | Etat |
|---------|------|
| APK actuel /var/www/apk/ | Obsolete (14 juillet) |
| Build 35, 36, 37 | SUCCESS |
| Build 38, 39 | FAILURE (regression worklets 0.11.0) |
| Build 40 | EN COURS (correction appliquee) |

---

## 7. RBAC

| Role | Permissions | Tests |
|------|-------------|-------|
| SUPER_ADMIN | Toutes (37) | OK |
| ADMIN | Gestion complete | OK |
| SUPPORT | Lecture clients | OK |
| RESELLER | Propres clients | OK |
| CLIENT | Activation VPN | OK |

---

## 8. SERVICES SECONDAIRES

| Service | Port | Etat |
|---------|------|------|
| Grafana | 3001 | OK |
| Prometheus | 9090 | OK |
| Node Exporter | 9100 | OK |
| BadVPN UDP-GW | 7300 | OK |
| Dropbear SSH | 444 | OK |

---

## 9. SCORE GLOBAL

| Domaine | Score |
|---------|-------|
| Infrastructure | 10/10 |
| Backend API | 9/10 |
| Authentification | 10/10 |
| Base de donnees | 9/10 |
| XPanel/XNet | 7/10 |
| Sing-box | 5/10 |
| Application Mobile | 7/10 |
| **GLOBAL** | **8.1/10** |

*Rapport genere le 17/07/2026 - Tests effectues en production reelle*
