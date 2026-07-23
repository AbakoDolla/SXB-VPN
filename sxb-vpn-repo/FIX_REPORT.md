# SXB VPN — FIX REPORT
## Date : 2026-07-16
## Analyste : Senior Full Stack Engineer

---

## BUGS CRITIQUES (BLOQUANTS)

### BUG-001 — Merge conflict non résolu dans src/App.tsx
- **Fichier** : src/App.tsx  
- **Cause** : git merge laissé en état UU (conflit entre HEAD et origin/main)  
- **Impact** : vite build échoue, dashboard inutilisable  
- **Fix** : checkout --theirs src/App.tsx + patch SettingsView props

### BUG-002 — Merge conflict dans .github/workflows/build-android.yml
- **Fichier** : .github/workflows/build-android.yml  
- **Cause** : conflit entre EAS Cloud (HEAD) et Gradle local (origin/main)  
- **Impact** : GitHub Actions CI cassé  
- **Fix** : workflow unifié Gradle local (sans EXPO_TOKEN requis)

### BUG-003 — Foreign key violation lors de la création de compte
- **Fichier** : server/routes/users.ts  
- **Cause** : roleId validé comme z.string() mais pas z.string().uuid() → chaîne vide passée  
- **Impact** : Prisma rejette la création avec P2003  
- **Fix** : validation z.string().uuid() + message d'erreur clair côté frontend

---

## BUGS SECONDAIRES

### BUG-004 — SUPER_ADMIN non bypass des permissions
- **Fichier** : server/middleware/auth.ts  
- **Cause** : seul 'ADMIN' bypass les permissions, pas SUPER_ADMIN  
- **Fix** : ajouter SUPER_ADMIN dans la condition

### BUG-005 — SUPPORT manque permissions maintenance
- **DB** : rôle SUPPORT sans tickets.manage, audit.view, clients.manage  
- **Fix** : seed + requête SQL pour ajouter les permissions manquantes

### BUG-006 — SettingsView sans props currentUser
- **Fichier** : src/App.tsx (origin/main version)  
- **Cause** : composant rendu sans passer currentUser/onUserUpdated  
- **Fix** : passer currentUser et handler depuis l'état de MainApp

### BUG-007 — XPanel configs retourne tableau vide
- **Fichier** : server/services/xpanel.ts  
- **Cause** : XPANEL_ADMIN_PASSWORD est dans .env mais getConfigs() échoue silencieusement  
- **Fix** : vérifier la route /api/v1/inbounds sur XPanel

---

## FICHIERS À MODIFIER
1. src/App.tsx
2. .github/workflows/build-android.yml
3. server/routes/users.ts
4. server/middleware/auth.ts
5. prisma/seed.ts (ajout permissions SUPPORT)

## STATUT
- [ ] Merge conflicts résolus
- [ ] Backend roleId validation fixé
- [ ] RBAC middleware corrigé
- [ ] SUPPORT permissions complètes
- [ ] Frontend rebuild
- [ ] Commit + Push
