# SXB VPN — Rapport Final de Production

**Date :** 15 juillet 2026  
**Version :** 2.1.0  
**Statut :** ✅ PRODUCTION OPÉRATIONNELLE

---

## ✅ Tests de Production Vérifiés

| Test | Résultat |
|------|----------|
| `superadmin@sxbvpn.com` login | ✅ SUPER_ADMIN (37 permissions) |
| `admin@sxbvpn.com` login | ✅ ADMIN (36 permissions dont `tokens.manage`) |
| `support@sxbvpn.com` login | ✅ SUPPORT |
| `/api/admin-tokens` endpoint | ✅ Opérationnel (Auth JWT requis) |
| `tokens.manage` in admin perms | ✅ Présent |
| Frontend `https://vpnsxb.afrihall.com/` | ✅ HTTP 200 |
| API `https://vpnsxb.afrihall.com/api/auth/login` | ✅ HTTP 200 |
| PM2 `sxb-backend` | ✅ Online |
| GitHub push | ✅ `main` à jour |

---

## 🔑 Accès Production

### Dashboard (https://vpnsxb.afrihall.com)

| Email | Mot de passe | Rôle |
|-------|-------------|------|
| `superadmin@sxbvpn.com` | `SuperAdmin2026!` | SUPER_ADMIN |
| `admin@sxbvpn.com` | `Admin2026!` | ADMIN |
| `support@sxbvpn.com` | `Support2026!` | SUPPORT |

> ⚠️ **IMPORTANT :** Changez ces mots de passe immédiatement après la première connexion.

### VPS (141.95.112.93)
- Accès SSH : `ubuntu@141.95.112.93` (mot de passe dans VPS_PASSWORD)
- Projet : `/var/www/sxb-vpn/`
- Logs : `pm2 logs sxb-backend`

---

## 🔄 Nouveautés v2.1.0

### Système Admin Token (`SXB-ADMIN-XXXX-XXXX`)
```
POST /api/admin-tokens/generate   → Génère un token de première connexion
POST /api/admin-tokens/activate   → Connexion via token (pas de mot de passe)
GET  /api/admin-tokens            → Liste les tokens actifs
POST /api/admin-tokens/:id/revoke → Révoque un token
```

**Flow :**
1. Admin crée un compte depuis "Gestion des Comptes"
2. Système génère automatiquement un token `SXB-ADMIN-XXXX-XXXX` (valide 48h)
3. Admin transmet token + email au nouvel utilisateur
4. L'utilisateur se connecte via `POST /api/admin-tokens/activate` avec le token
5. Token marqué comme utilisé (usage unique)

### Section "Gestion des Comptes" (Dashboard)
- Accessible via la sidebar (ADMIN / SUPER_ADMIN uniquement)
- Créer des comptes avec génération auto de mot de passe
- Générer un admin token pour n'importe quel utilisateur
- Voir et révoquer les tokens admin actifs
- Supprimer des comptes (hors SUPER_ADMIN et compte propre)

---

## 🐛 Bugs Corrigés dans cette Version

1. ✅ PM2 crash loop (`dist/server.cjs` manquant) → Build complet effectué
2. ✅ DB vide (seed jamais exécuté, FK violations) → Seed complet avec tous les rôles
3. ✅ `tokens.manage` permission absente → Seedée et assignée
4. ✅ SUPER_ADMIN non seedé → Seedé avec password forcé à chaque re-seed
5. ✅ TokensView utilisait `tok.owner`/`tok.code` (inexistants) → Corrigé
6. ✅ `generateTokenCode()` côté client → Supprimé
7. ✅ `createToken()` mauvais params → Corrigé `{clientId, quotaGb, durationDays}`
8. ✅ `REFRESH_SECRET` absent du VPS .env (config attendait ce nom) → Ajouté

---

## ⚠️ Points d'Attention Restants

1. **XPanel** : le mot de passe XPanel (`XPANEL_ADMIN_PASSWORD`) est présent dans `.env` mais le path de login dans le service ne contient pas le bon base path. À tester manuellement.
2. **JWT_SECRET** : les secrets présents sont satisfaisants mais idéalement 64+ chars aléatoires. Actuellement : longueur suffisante.
3. **SSL** : certificat Let's Encrypt valide jusqu'au **29 septembre 2026** — à renouveler avant cette date (`certbot renew`).
4. **VPN tunnel mobile** : `VpnContext.tsx` — `connect()` simule toujours le succès. L'app mobile ne crée pas de vrai tunnel VPN.
5. **Traffic analytics** : données calculées algorithmiquement, pas de vraie télémétrie XPanel.
6. **Client role** : il existe un rôle `CLIENT` dans la DB (créé précédemment) qui n'est pas dans le schéma actuel. N'impacte pas le fonctionnement mais crée de la confusion.

---

## 📁 Fichiers Clés

```
/var/www/sxb-vpn/
├── dist/                    # Build production (server.cjs + frontend)
├── server.ts                # Entrée Express (production: dist/server.cjs)
├── server-api-only.ts       # Alternative API-only (pour nginx + static séparés)
├── prisma/
│   ├── schema.prisma        # Schéma DB + AdminToken (v2.1)
│   └── seed.ts              # Seed idempotent (upsert avec mise à jour password)
├── server/routes/
│   └── admin-tokens.ts      # Nouveau — routes SXB-ADMIN tokens
├── src/components/
│   ├── AccountsView.tsx     # Nouveau — Gestion des Comptes
│   ├── TokensView.tsx       # Corrigé — types alignés avec API
│   └── Layout.tsx           # Mis à jour — nav Gestion des Comptes
└── .env                     # Secrets production (REFRESH_SECRET ajouté)
```

---

## 🚀 Commandes Utiles (VPS)

```bash
# Voir les logs en temps réel
pm2 logs sxb-backend --lines 50

# Redémarrer après un changement de code
cd /var/www/sxb-vpn && git pull && npm run build && pm2 restart sxb-backend --update-env

# Re-seeder la base (idempotent — sans perte de données client)
cd /var/www/sxb-vpn && npx tsx prisma/seed.ts

# Renouveler SSL
certbot renew --nginx

# Voir l'état PM2
pm2 list && pm2 show sxb-backend
```

---

*Rapport généré le 15/07/2026 — SXB VPN v2.1.0*
