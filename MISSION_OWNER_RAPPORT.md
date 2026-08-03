# MISSION OWNER — Rapport de livraison

> Branche : `arena/019fc804-sxb-vpn` · PR : « feat(admin): compte OWNER racine (stealth produit + audit sécurité dédié) + mode maintenance pilotable »
> Aucun secret n'est présent dans ce rapport : les identifiants OWNER proviennent exclusivement de variables d'environnement (`OWNER_EMAIL`, `OWNER_PASSWORD`), jamais du code ni du dépôt.

---

## 1. Rôle OWNER (racine, au-dessus de SUPER_ADMIN)

- **Seed** : `prisma/seed.ts`, `backend/prisma/seed.ts` et `seed-rbac.ts` créent le rôle `OWNER` (description : propriétaire racine) via `upsert` idempotent.
- **Migration SQL idempotente** (`prisma/migrations_manual.sql`, appliquée aussi dans `backend/prisma/`) :
  `INSERT INTO roles (id, name, description) SELECT gen_random_uuid(), 'OWNER', … ON CONFLICT (name) DO NOTHING;`
- **Bypass RBAC centralisé** : `backend/server/middleware/auth.ts` (`requireRole`, `requirePermission`) et `backend/server/middleware/rbac/index.ts` (`authorizeRole`, `authorizePermission`) — un seul point de bypass : `req.user.role === 'OWNER'` → accès total à tout endpoint. Le rôle réel est relu en base à chaque requête (`requireAuth` ne fait plus confiance au claim JWT seul).
- **Gardes hiérarchiques** (`backend/server/routes/users.ts`) :
  - non-OWNER ne peut ni voir, ni lire, ni modifier, ni supprimer un compte OWNER (`canSeeUser` → 404/403), ni créer un compte OWNER ;
  - OWNER peut suspendre/révoquer/réactiver **tout** compte, SUPER_ADMIN inclus (le blocage historique « Cannot delete Super Admin » est levé pour OWNER) ;
  - **garde-fou anti auto-bloquage** : le compte OWNER ne peut ni se suspendre, ni se démoter, ni se supprimer via l'API (403).
- **Création du compte** : `backend/scripts/create-owner.js` (JS ESM, exécutable avec `node`, jamais exécuté en CI), idempotent, lit `OWNER_EMAIL` / `OWNER_PASSWORD` depuis `process.env`, hash bcrypt coût 12 (même coût que le seed admin), `roleId` = rôle OWNER. Les 3 commandes VPS sont documentées dans le corps de la PR.

## 2. Invisibilité produit (stealth)

- Helper central `canSeeUser(requester, target) = target.role.name !== 'OWNER' || requester.role.name === 'OWNER'` (`backend/server/middleware/rbac/owner.ts`), appliqué aux :
  - listes users (`GET /api/users`, `GET /api/users/:id`),
  - listes clients VPN (`GET /api/clients`, `GET /api/clients/:id`),
  - listes revendeurs (`GET /api/resellers`),
  - sessions/connexions récentes (`GET /api/sessions`),
  - catalogue RBAC (`GET /api/rbac/roles` → rôle OWNER masqué),
  - KPIs et compteurs : `dashboard.ts` (stats, trafic, évolution users) et `analytics.ts` (users, overview, serveurs) excluent comptes/clients/revendeurs OWNER pour les non-OWNER.
- Filtrage à la lecture uniquement : aucune donnée supprimée.
- **Traçabilité de sécurité** : les authentifications OWNER réussies (`routes/auth.ts`) et les actions sensibles (suspension/révocation, bascule maintenance) écrivent un `AuditLog` normal **en plus** de `visibleOwnerOnly=true` (colonne ajoutée : `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "visibleOwnerOnly" BOOLEAN NOT NULL DEFAULT false`).
- Les routes audit-logs existantes excluent ces entrées pour les non-OWNER ; `GET /api/audit-logs/owner` (OWNER only) expose le journal.
- **Dashboard** : page « Journal propriétaire » visible uniquement si `role === 'OWNER'` (garde côté route React + filtre serveur).

## 3. Mode maintenance (pause/play du dashboard)

- Modèle `Setting` clé/valeur (`key String @id`, `value String`) + `CREATE TABLE IF NOT EXISTS settings …` idempotent.
- Endpoints (OWNER only) :
  - `POST /api/ops/maintenance { enabled: boolean }` → écrit `maintenance_mode` + audit `visibleOwnerOnly` ;
  - `GET /api/ops/maintenance` → état courant.
- Middleware global (`backend/server/middleware/maintenance.ts`, monté sur `/api/` avant les routes) : si `maintenance_mode='true'` → **503 `{ error: 'maintenance' }`** pour tout `/api/*` sauf `/api/auth/login`, `/api/auth/refresh`, `/api/health` ; un JWT valide du rôle OWNER traverse toujours (l'OWNER peut se connecter et basculer). `/api/ops/*` n'est pas exempté globalement → aucun indice pour les non-OWNER.
- Frontend public : page statique « Maintenance en cours » servie pour les routes non-API (hors `/login`), + page React propre dans le dashboard.
- Dashboard OWNER : carte « Exploitation » (état + « Mettre le dashboard en pause » / « Remettre en service ») + bannière rouge « MODE MAINTENANCE ACTIF » persistante.

---

## Vérifications marqueurs

| Marqueur | Résultat |
|---|---|
| `grep -c "'OWNER'" prisma/seed.ts` | **2** (≥ 1 ✓) |
| `grep -c 'visibleOwnerOnly' backend/server -r` | **21** occurrences, 5 fichiers (≥ 3 ✓) |
| `grep -c 'ops/maintenance' backend/server -r` | **9** occurrences, 2 fichiers (≥ 2 ✓) |
| `grep -c 'maintenance_mode' backend/server -r` | **3** occurrences, 2 fichiers (≥ 2 ✓) |
| `grep -c 'OWNER' artifacts/sxb-dashboard/src -r` | **46** occurrences, 7 fichiers (≥ 3 ✓) |
| Typecheck backend (`tsc --noEmit`, `backend/`) | ✅ 0 erreur |
| Build dashboard (`vite build`, `artifacts/sxb-dashboard`) | ✅ `dist/public` généré |
| Bundle production (`esbuild server.ts → server.cjs`, même commande que deploy-vps.yml) | ✅ + boot & smoke-test OK |

---

## Test logique obligatoire — résultats (exécuté en réel)

Backend Express réel (mêmes middlewares/routes que la production), base mémoire supportée par le projet ; la couche Prisma/PostgreSQL est validée par le typecheck. Identifiants de test générés aléatoirement à l'exécution (jamais commités).

**Résultat : 50 ✅ / 0 ❌**

| # | Scénario | Attendu | Obtenu |
|---|---|---|---|
| 1 | login SUPER_ADMIN → `GET /api/ops/maintenance` | 403 | ✅ 403 |
| 2 | login OWNER → `GET /api/ops/maintenance` | 200 | ✅ 200 (enabled:false) |
| 3a | OWNER `POST /api/ops/maintenance {enabled:true}` | 200 | ✅ 200 (enabled:true) |
| 3b | compte client (RESELLER) pendant maintenance : `GET /api/users`, `GET /api/dashboard/stats`, `GET /api/ops/maintenance` | 503 `{error:'maintenance'}` | ✅ 503 partout (aucune fuite) |
| 3c | OWNER pendant maintenance : `GET /api/users` | 200 | ✅ 200 (bypass) |
| 3d | page non-API `GET /dashboard` pendant maintenance | 503 + page statique | ✅ 503 + « Maintenance en cours » |
| 3e | login RESELLER pendant maintenance | 200 (login ouvert) | ✅ 200 |
| 4 | liste users vue par SUPER_ADMIN : compte OWNER absent ; `GET /api/users/:ownerId` → 404 ; présent pour OWNER | absent/404/présent | ✅ |
| 4b | rôle OWNER masqué du catalogue RBAC pour SUPER_ADMIN, visible pour OWNER | — | ✅ |
| 5 | OWNER suspend un SUPER_ADMIN → son login | 200 / 403 | ✅ suspendu → login 403 ; réactivé → login 200 |
| 6 | suspension du compte OWNER (par lui-même, par SUPER_ADMIN, par RESELLER) | 403 | ✅ 403 dans les 3 cas |
| 7 | audit : login OWNER absent des logs SUPER_ADMIN ; `GET /api/audit-logs/owner` 403 pour SUPER_ADMIN ; 200 pour OWNER avec login OWNER + bascules maintenance + suspension SUPER_ADMIN | — | ✅ |

---

## Migration à jouer sur le VPS

`prisma/migrations_manual.sql` (blocs idempotents) — ou simplement `prisma db push` via le workflow deploy-vps. Détails de déploiement : voir le corps de la PR.
