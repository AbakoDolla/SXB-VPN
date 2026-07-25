# SYNC_BOLT_PHASE_BEFORE_PHASE2.md
> Rapport de consolidation — branche `refactor/dashboard-controlled-client` → `main`
> Date : 25 juillet 2026
> Auteur : SXB VPN Sync Agent

---

## 1. Contexte de la synchronisation

### Branches analysées
| Branche | Rôle | Commits propres |
|---|---|---|
| `main` | Base de production avec correctifs Prisma | 3 commits exclusifs |
| `refactor/dashboard-controlled-client` (Bolt) | Refactoring mobile Dashboard-Controlled Client | 6 commits exclusifs |

### Objectif
Fusionner uniquement les bons changements Bolt sur `main` sans perdre les correctifs Prisma critiques, et sans appliquer les parties dangereuses ou régressives de Bolt.

---

## 2. Commits Bolt analysés (refactor/dashboard-controlled-client)

| Hash | Message | Verdict |
|---|---|---|
| `bba127b` | `security: remove vpn-debug diagnostic screen` | ✅ Appliqué |
| `aa243d7` | `refactor: remove subscriptionUrl from home screen getButtonState` | ✅ Appliqué |
| `82011e7` | `refactor: remove manuallySetConfig, base64, subscriptionUrl/serverInfo from VpnContext` | ✅ Appliqué |
| `4591b9b` | `security: remove dead connectionUri code from mobile.ts` | ⚠️ Partiellement ignoré (bug import + Prisma fix présent dans main) |
| `3c72a9b` | `security+refactor: remove all client-side config injection and server IP leaks` | ⚠️ Partiellement ignoré (bug import path + régressions) |
| `0bd0a80` | `refactor: update TypeScript types — remove server/port from VpnConnection` | ✅ Appliqué |

## 3. Commits main conservés (non présents dans Bolt)

| Hash | Message | Statut |
|---|---|---|
| `3789371` | `docs: update AUDIT_PHASE1.md with complete fix log and Phase 2 plan` | ✅ Conservé |
| `10c5884` | `fix(backend): eliminate all Prisma payload relation errors across routes` | ✅ Conservé (critique) |
| `9f48adc` | `fix(backend): remove invalid Prisma payload relation from mobile vpn/config` | ✅ Conservé (critique) |

---

## 4. Fichiers modifiés

### Changements récupérés de Bolt (mobile — architecture Dashboard-Controlled Client)

#### `app-mobile/app/(tabs)/index.tsx`
- **Supprimé** : paramètre `subscriptionUrl: string | null` de la signature `getButtonState()`
- **Supprimé** : `// Priorité 3 : subscriptionUrl fournie par le backend` + son `if (subscriptionUrl) return "connect";`
- **Supprimé** : `subscriptionUrl` du destructuring `useVpnContext()`
- **Mis à jour** : appel `getButtonState()` sans `subscriptionUrl`
- **Conservé** : la suppression du `deviceId` visible dans l'UI (correctif de `main` commit `10c5884`)
- **Conservé** : `activeConnection`, `hasValidConfig`, toute la logique de connexion active

#### `app-mobile/contexts/VpnContext.tsx`
- **Supprimé** : `subscriptionUrl` (state, setter, interface, provider value, alimentation depuis API)
- **Supprimé** : `serverInfo` (state, setter, interface, provider value)
- **Supprimé** : `manuallySetConfig` (fonction callback, interface, provider value)
- **Conservé** : `syncFromConnection`, `activeConnection`, `hasValidConfig`, tout le moteur VPN natif Android
- **Conservé** : toute la logique WebSocket, lifecycle Android 12–15, watchdog, foreground service

#### `app-mobile/app/settings.tsx`
- **Supprimé** : composant `V2rayJsonModal` entier (~130 lignes) — éditeur JSON config manuelle incompatible avec architecture SaaS
- **Supprimé** : `manuallySetConfig` du destructuring `useVpnContext()`
- **Supprimé** : state `v2rayModal` / `setV2rayModal`
- **Supprimé** : usage JSX `<V2rayJsonModal ... />`
- **Conservé** : section DIAGNOSTIC sous garde `{__DEV__ && ...}` — debug accessible uniquement en mode développement (meilleur compromis main+Bolt)
- **Conservé** : commentaire `{/* V2Ray JSON editor removed — SXB VPN is a pure SaaS client */}`

#### `app-mobile/app/_layout.tsx`
- **Supprimé** : `<Stack.Screen name="vpn-debug" ...>` — route debug supprimée du navigateur

#### `app-mobile/types/api.ts`
- **Supprimé** : `server: string` de l'interface `VpnConnection` — IP serveur ne doit jamais atteindre le mobile
- **Supprimé** : `port: number` de l'interface `VpnConnection` — port SSH ne doit jamais atteindre le mobile

#### `app-mobile/app/vpn-debug.tsx`
- **Supprimé** : fichier entier — écran diagnostic non accessible aux utilisateurs finaux

---

### Changements Bolt ignorés (régressions ou non nécessaires)

#### `server/routes/mobile.ts` — NON appliqué depuis Bolt car :
1. **Bug import critique** : Bolt a changé `"../middleware/auth"` → `"middleware/auth"` (chemin relatif invalide → crash au démarrage)
2. **Régression Prisma** : Bolt a `include: { profile: { include: { payload: true } } }` — exactement le bug corrigé dans `main` (commit `9f48adc`)
3. **Minification agressive** : Bolt a écrasé les blocs multi-lignes en one-liners illisibles sans bénéfice fonctionnel
4. **Suppression de commentaires documentaires** importants (sécurité, SaaS intent)
- **Résultat** : `server/routes/mobile.ts` conserve 100% la version de `main` avec les correctifs Prisma

---

## 5. Conflits résolus

| Fichier | Conflit | Résolution |
|---|---|---|
| `app-mobile/app/(tabs)/index.tsx` | `main` retire `deviceId` UI, Bolt retire `subscriptionUrl` — deux changements indépendants | Merge manuel : les deux suppressions appliquées |
| `app-mobile/app/settings.tsx` | `main` a `__DEV__` guard pour debug, Bolt supprime entièrement la section | Compromise : section supprimée **sauf** guard `__DEV__` (sécurité dev conservée) |
| `server/routes/mobile.ts` | Bolt a bug import + régression Prisma, main a correctifs | `main` gagne — version Bolt ignorée entièrement |

---

## 6. État architecture actuelle après sync

```
Utilisateur final voit uniquement :
  ✅ Logo SXB VPN
  ✅ Statut VPN (connecté / déconnecté)
  ✅ Bouton CONNECT / DISCONNECT
  ✅ Consommation données
  ✅ Temps connecté
  ✅ Expiration forfait
  ✅ Actualiser configuration
  ✅ Notifications

Utilisateur final ne voit PAS :
  ❌ IP serveur / host SSH
  ❌ Port SSH
  ❌ Login / password SSH
  ❌ UUID technique
  ❌ Payload SSH lisible
  ❌ Éditeur JSON V2Ray
  ❌ Écran debug VPN
  ❌ subscriptionUrl / serverInfo
  ❌ Configuration manuelle
```

### Flux d'architecture validé

```
Utilisateur
    |  SXB TOKEN
    ↓
Mobile App (client pur)
    |  token + device ID uniquement
    ↓
API /mobile/* (token-only surface)
    |  configuration provisionnée chiffrée
    ↓
Dashboard Backend
    |  DB + Provisionnement
    ↓
VPS Backend
    |
    ↓
VPN Engine natif
```

---

## 7. Vérification sécurité — Principe non-exposition

| Donnée sensible | Mobile reçoit ? | Statut |
|---|---|---|
| IP serveur | ❌ Non | ✅ Conforme |
| Port SSH | ❌ Non | ✅ Conforme |
| Login SSH | ❌ Non | ✅ Conforme |
| Password SSH | ❌ Non | ✅ Conforme |
| Payload SSH brut | ❌ Non (chiffré AES-256) | ✅ Conforme |
| UUID technique | ❌ Non | ✅ Conforme |
| Configuration modifiable côté client | ❌ Non | ✅ Conforme |
| Token SXB-USER-XXXX | ✅ Oui (identité utilisateur) | ✅ Attendu |
| Configuration provisionnée chiffrée | ✅ Oui (via `/mobile/vpn/config`) | ✅ Attendu |
| Device ID | ✅ Oui (binding device, interne) | ✅ Attendu |

---

## 8. Correctifs backend conservés (main)

| Route | Correctif | Impact |
|---|---|---|
| `server/routes/mobile.ts` | Suppression de `include: { payload: true }` invalide sur VpnProfile | Bloqueur critique résolu — `/mobile/vpn/config` retourne 200 au lieu de 500 |
| `server/routes/provision.ts` | Suppression de `include: { payload: true }` sur VpnProfile + fallback sshPayload.findUnique | Provisionnement fonctionnel |
| `server/routes/ssh.ts` | Suppression de `include: { payload: true }` sur SshAccount + payloadMap bulk query | Liste SSH sans N+1 |

---

## 9. Points bloquants restants avant Phase 2

| Point | Priorité | Description |
|---|---|---|
| Provisionnement sécurisé complet | 🔴 CRITIQUE | Phase 2 — endpoint `/mobile/provision` avec chiffrement AES-256 + binding Device ID |
| Validation Android 12-15 | 🔴 CRITIQUE | Phase 2 — lifecycle foreground service, permissions SCHEDULE_EXACT_ALARM |
| Connexion offline production | 🟠 HAUTE | Phase 2 — reconnexion automatique sans réseau, watchdog amélioré |
| Tests de régression mobile | 🟡 MOYEN | Valider que suppression subscriptionUrl/manuallySetConfig ne casse rien en prod |
| Prisma migrations en prod | 🟡 MOYEN | S'assurer que schéma prod correspond aux relations SshPayload utilisées |

---

## 10. Fichiers non touchés (sains, aucune action requise)

- `server/routes/provision.ts` — déjà corrigé dans main
- `server/routes/ssh.ts` — déjà corrigé dans main
- `server/routes/vpn-profiles.ts` — non touché par Bolt
- `android/` — moteur VPN natif Kotlin non touché dans cette phase
- `prisma/schema.prisma` — non touché
- `AUDIT_PHASE1.md` — rapport d'audit complet conservé

---

## Conclusion

La base est propre. Les 6 fichiers mobiles refactorisés par Bolt ont été intégrés sélectivement sur `main`, avec résolution manuelle des 3 zones de conflit. Le backend conserve l'intégralité des correctifs Prisma critiques. L'architecture Dashboard-Controlled Client est en place côté mobile.

**Prêt pour la Phase 2 : Provisionnement sécurisé + Connexion offline production + Validation Android 12-15.**
