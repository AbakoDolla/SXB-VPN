# SXB VPN — API Test Report
## Date : 2026-07-16

---

## Backend API — Résultats Tests

| Endpoint | Méthode | Status | Résultat |
|---|---|---|---|
| /api/auth/login | POST | ✅ OK | JWT retourné + permissions |
| /api/auth/login (SUPPORT) | POST | ✅ OK | 16 permissions SUPPORT |
| /api/users | GET | ✅ OK | Liste utilisateurs |
| /api/users | POST (roleId vide) | ✅ OK | Erreur validation UUID |
| /api/users | POST (roleId valide) | ✅ OK | Compte ADMIN créé |
| /api/users | POST (roleId RESELLER) | ✅ OK | Compte RESELLER créé |
| /api/users/me | GET | ✅ OK | Profil utilisateur |
| /api/users/me | PATCH | ✅ OK | Mise à jour profil |
| /api/users/me/avatar | POST | ✅ OK | Upload photo profil |
| /api/rbac/roles | GET | ✅ OK | 5 rôles retournés |
| /api/xpanel/status | GET | ⚠️ offline | XPanel accessible, inbounds vides (normal) |
| /api/xpanel/sync | POST | ⚠️ partiel | Config XPanel vide |

---

## RBAC — Permissions par Rôle

| Rôle | Permissions | Bypass | Notes |
|---|---|---|---|
| SUPER_ADMIN | 38 perms | ✅ Auto-bypass middleware | Accès total |
| ADMIN | 36 perms | ✅ Bypass middleware | Accès complet sauf SUPER_ADMIN actions |
| SUPPORT | 16 perms | ❌ Contrôlé | view users, clients, tickets, audit |
| RESELLER | 10 perms | ❌ Contrôlé | Gestion propres clients |

---

## Architecture Communication

```
Mobile App (React Native/Expo)
   ↓ HTTPS (JWT Bearer)
Backend API (Express + Prisma — port 4000)
   ↓
PostgreSQL (sxb_vpn — port 5432)
   ↓
XPanel Engine (localhost:18790)
   ↓
VPN Protocols (VLESS, VMess, Trojan, Shadowsocks, SSH)
```

---

## URLs Système

| Service | URL | Statut |
|---|---|---|
| Dashboard Frontend | https://vpnsxb.afrihall.com | ✅ Accessible |
| Backend API | https://vpnsxb.afrihall.com/api | ✅ Online |
| XPanel | https://xpanel.vpnsxb.afrihall.com/kqUtkMEvgdtx/ | ✅ Accessible |
| APK Landing | https://apk.sxbvpn.afrihall.com | ✅ Configuré |

---

## Bugs Corrigés

1. ✅ Merge conflicts App.tsx + build-android.yml résolus
2. ✅ roleId validation UUID — plus de FK violation
3. ✅ SUPER_ADMIN bypass middleware permissions
4. ✅ SUPPORT permissions complétées (16 perms)
5. ✅ Routes /me et avatar upload ajoutées
6. ✅ XPanel URLs corrigées (/api/v1/... → /api/...)
7. ✅ SettingsView props currentUser passés

---

## Données Mockées Supprimées

- ✅ Analytics: données calculées depuis DB
- ✅ Mobile: toutes données depuis Backend via JWT
- ✅ Dashboard: métriques depuis Prisma
