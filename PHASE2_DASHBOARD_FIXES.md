# PHASE2_DASHBOARD_FIXES.md
> Corrections Dashboard — Flux SSH Manager → VPN Profiles → Forfaits → Clients
> Date : 25 juillet 2026

---

## Bugs corrigés

### 🔴 BUG CRITIQUE — SubscriptionsView : mauvais sélecteur de profil
**Fichier** : `src/components/SubscriptionsView.tsx`
**Symptôme** : La liste de profils dans le formulaire "Nouveau Forfait" utilisait `fetchUnifiedConfigs()` qui retourne des IDs de `SshAccount`, `XrayAccount` et `SingboxAccount` — pas de `VpnProfile`. Or `Subscription.profileId` est une FK vers la table `vpn_profiles`. Résultat : toute création de forfait aurait échoué avec `404 — Profil VPN introuvable`.
**Correction** : Remplacé par `fetchVpnProfiles()` qui retourne les bons IDs.

### 🟠 VPN Profiles : protocoles manquants + champ JSON
**Fichiers** : `src/components/VpnProfilesView.tsx`, `src/api/vpnProfiles.ts`, `server/routes/vpn-profiles.ts`, `prisma/schema.prisma`
- Ajouté `wireguard` à la liste des protocoles
- Ajouté couleur badge `ssh+payload` (teal) et `wireguard` (green)
- Ajouté champ `jsonConfig` optionnel (textarea monospace) visible pour les protocoles non-SSH
- Mis à jour backend CREATE + UPDATE pour accepter et stocker `jsonConfig`
- Ajouté `jsonConfig String?` dans le modèle Prisma `VpnProfile`
- Créé `prisma/migrations_manual.sql` avec migration SQL idempotente

### 🟠 VPN Profiles backend : uuid null pour SSH
**Fichier** : `server/routes/vpn-profiles.ts`
- Correction : `protocol !== 'ssh'` → `!['ssh', 'ssh+payload'].includes(protocol)`
- Évite d'assigner un UUID aléatoire aux profils SSH+Payload (qui n'en ont pas besoin)

---

## Analyse PRIORITÉ 3 : SSH Manager vs VPN Profiles

### SSH Manager (`SshAccount` table)
- **Rôle** : Gestion de comptes SSH côté serveur (user/pass/host vers un serveur SSH)
- **Protocoles** : SSH uniquement
- **Connexions** : Pas lié à `Subscription`, pas lié au provisionnement mobile
- **Ce qu'il gère** : Infrastructure SSH (les serveurs, pas les clients)
- **Payload** : Intégré via onglet "Payloads" dans la même vue

### VPN Profiles (`VpnProfile` table)
- **Rôle** : Templates de configuration VPN pour les clients mobiles
- **Protocoles** : SSH, SSH+Payload, VLESS, VMess, Trojan, Shadowsocks, Sing-box, **WireGuard** (ajouté)
- **Connexions** : `Subscription.profileId → VpnProfile.id` → **Chaîne complète vers le mobile**
- **Ce qu'il gère** : Configurations livrées aux clients via provisionnement
- **Payload** : Lié via `payloadId → SshPayload` (même table que SSH Manager utilise)

### Verdict

| Critère | SSH Manager | VPN Profiles |
|---|---|---|
| Protocoles | SSH seulement | Tous (7+) |
| Lié aux Forfaits | ❌ Non | ✅ Oui |
| Lié au Mobile | ❌ Non | ✅ Via Subscription → Provision |
| Lié aux Payloads | ✅ Oui (intégré) | ✅ Oui (via payloadId) |
| Chiffrement AES | ✅ GCM v2 | ✅ GCM v2 |
| Complet | Partiel | ✅ Complet |

**Décision : Conserver VPN Profiles. SSH Manager peut être progressivement masqué.**

Les deux modules ne font PAS exactement la même chose : SSH Manager gère l'infrastructure SSH (côté serveur), VPN Profiles gère les templates clients (côté mobile). Cependant, VPN Profiles peut remplacer SSH Manager pour le flux Dashboard → Mobile puisqu'il supporte `ssh` et `ssh+payload` et est l'unique lien avec le provisionnement.

**Action immédiate** : Rien à supprimer — risque trop élevé. SSH Manager reste visible mais n'est plus dans le flux principal.
**Phase suivante** : Quand VPN Profiles gère 100% des configs, masquer SSH Manager dans le menu latéral.

---

## Analyse PRIORITÉ 7 : Clients vs Appareils (Devices)

### Clients (`/api/clients` → `VpnClient`)
- CRUD complet : créer, modifier, supprimer, suspendre, activer, renouveler
- Génère le token `SXB-USER-XXXX-XXXX-XXXX`
- Lié aux `Subscription` (forfaits)
- Utilisé dans `SubscriptionsView` pour le sélecteur client
- Source de vérité pour la liste des utilisateurs VPN

### Appareils (`/api/devices` → même `VpnClient`)
- Vue centrée sur le Device ID : génère un token pour un appareil spécifique
- Pas de CRUD complet (pas de création manuelle de client)
- Fonctions : generate-token, revoke, renew
- Pas utilisé comme source de vérité dans d'autres modules

### Verdict

| Critère | Clients | Appareils |
|---|---|---|
| CRUD complet | ✅ Oui | ❌ Partiel |
| Lié aux Forfaits | ✅ Oui | ❌ Non |
| Génère token | ✅ Oui | ✅ Oui (device-centric) |
| Source de vérité | ✅ Oui | ❌ Redondant |
| Utilisé par d'autres modules | ✅ Oui | ❌ Non |

**Décision : Conserver Clients. Appareils peut être masqué progressivement.**

`DevicesView` offre une interface rapide pour générer un token à partir d'un Device ID — utile pour les cas de support. Mais tout ce qu'il fait, `ClientsView` le fait aussi et mieux.

**Action immédiate** : Rien à supprimer. `DevicesView` reste accessible mais n'est pas dans le flux principal.

---

## État après corrections

### Flux Dashboard validé (théorique — à tester sur VPS)
```
1. Créer un Payload             → SSH Manager > Payloads
2. Créer un Profil VPN          → VPN Profiles (SSH+Payload ou autre protocole)
                                  ✅ wireguard ajouté
                                  ✅ jsonConfig optionnel ajouté
3. Créer un Client              → Clients
4. Créer un Forfait             → Forfaits (profil VPN correct maintenant)
                                  ✅ sélecteur profil corrigé (était fetchUnifiedConfigs)
5. Provision                    → /api/provision (non touché)
6. Import Token Mobile          → App SXB VPN
7. Connexion                    → Moteur VPN natif
```

### Fichiers modifiés dans cette phase
| Fichier | Modification |
|---|---|
| `src/components/SubscriptionsView.tsx` | `fetchUnifiedConfigs` → `fetchVpnProfiles` |
| `src/components/VpnProfilesView.tsx` | +wireguard, +jsonConfig textarea, +couleurs badges |
| `src/api/vpnProfiles.ts` | +`jsonConfig` dans interface VpnProfile |
| `server/routes/vpn-profiles.ts` | +jsonConfig CREATE+UPDATE, fix uuid pour ssh+payload |
| `prisma/schema.prisma` | +`jsonConfig String?` sur VpnProfile |
| `prisma/migrations_manual.sql` | Migration SQL idempotente pour jsonConfig |

---

## Points bloquants restants

| Point | Priorité | Action requise |
|---|---|---|
| Migration `json_config` sur prod | 🔴 CRITIQUE | Appliquer `migrations_manual.sql` sur DB prod avant de tester jsonConfig |
| Test flux complet sur VPS | 🟠 HAUTE | Vérifier avec une vraie connexion client |
| Config existante MTN 150Mo / 50Mo | 🟡 MOYEN | Tester que provision retourne config correcte |
| Masquer SSH Manager et Devices | 🟡 MOYEN | Après validation VPN Profiles = seule source de vérité |

---

## Commits

- `fix(subscriptions): use vpn-profiles instead of unified-configs for profile selector`
- `fix(vpn-profiles): add wireguard protocol + jsonConfig optional field + backend support`
- `docs(phase2): dashboard flow analysis + fixes report`
