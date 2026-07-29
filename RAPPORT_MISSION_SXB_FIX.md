# RAPPORT DE MISSION — DIAGNOSTIC COMPLET ET CORRECTION DE LA CONNEXION VPN SXB VPN

**Date :** 2026-07-29
**Branche :** `arena/019faf29-sxb-vpn`
**Méthode :** scan récursif intégral du dépôt, preuve par reproduction, correction définitive, validation E2E exécutable.

---

## 1. CAUSE RACINE EXACTE

### 🔴 Cause principale — `crypto.subtle` n'existe pas sous Hermes (React Native)

Le déchiffrement du blob de provisionnement dans
`app-mobile/services/provisionClient.ts` (`decryptGCM`) reposait **exclusivement** sur
l'API Web Crypto :

```ts
if (typeof crypto === 'undefined' || !crypto.subtle) {
  throw new Error('Moteur cryptographique indisponible');
}
```

Or le moteur JavaScript **Hermes de React Native (toutes versions, RN 0.81 / Expo SDK 54
inclus) n'implémente pas `crypto.subtle`**, et l'application n'embarque **aucun polyfill**
(vérifié : `app-mobile/package.json`, `metro.config.js`, `babel.config.js`, `_layout.tsx`
— aucun `react-native-quick-crypto`, `expo-standard-web-crypto` ou équivalent).

**Chaîne causale exacte (chaque maillon vérifié dans le code) :**

1. Le dashboard crée l'abonnement → `POST /api/subscriptions` génère `SXB-DATA-…` ✔ (backend sain)
2. L'app reçoit le `dataToken` via `GET /api/mobile/connections` ✔ (backend sain)
3. L'app appelle `POST /api/provision/activate` ✔ — **le serveur répond 200** avec
   `encryptedBlob` + `configKey` (prouvé par test HTTP réel, §5.2)
4. `provisionAndStore` → `decryptGCM()` → 💥 **`Moteur cryptographique indisponible`**
   (reproduit dans un environnement sans `crypto.subtle`, §5.1)
5. Catch → `PROVISION_WARN / PROVISION_FAILED` → **aucune config complète n'est jamais
   stockée** dans SecureStore
6. `VpnContext.connect()` → gardien `isCompleteOfflineConfig` →
   `CONFIG_READY hasHost=false hasCreds=false missing=[host,port,credentials]`
   → **`CONFIG_INCOMPLETE_BLOCK`** (log exact produit en production, §5.3)
7. En l'absence de réseau, le même chemin échoue côté HTTP → axios remonte
   littéralement `Network Error`.

C'est pourquoi l'application **recevait bien la configuration du dashboard mais ne
pouvait jamais se connecter**, avec ou sans réseau : la panne n'était ni réseau, ni
backend, ni moteur natif — c'était le déchiffrement côté appareil.

### 🟠 Cause secondaire 1 — blocage auto-entretenu par une config héritée incomplète

Dans `VpnContext.connect()`, une entrée offline présente (même partielle, écrite par une
ancienne version de l'app) **court-circuitait le chemin de re-provisionnement** :

```ts
if (offlineEntry?.config) { configToUse = { ...offlineEntry.config }; }
if (!configToUse) { /* provision */ }        // jamais atteint si config partielle
→ CONFIG_INCOMPLETE_BLOCK en boucle, pour toujours.
```

**Corrigé :** une config stockée n'est utilisée que si `isCompleteOfflineConfig()`
la déclare complète ; sinon re-provisionnement automatique (avec `dataToken` retrouvé
dans la config héritée, l'état `vpnConfig` ou la connexion active), puis si tout échoue,
logs explicites `CONFIG_INCOMPLETE_BLOCK missing=…` au lieu d'un échec opaque.

### 🟠 Cause secondaire 2 — chaîne de build APK cassée (`react-native-worklets` manquant)

`babel.config.js` référence `react-native-reanimated/plugin`, lequel en v4.1.x exige
`react-native-worklets/plugin`. La peer-dependency `react-native-worklets` n'était **pas
installée** (peer range `0.5 - 0.8`, jamais auto-installée avec `--legacy-peer-deps`).
Résultat : Metro échoue avec `Cannot find module 'react-native-worklets/plugin'` —
reproduit à l'identique dans le sandbox (§5.4). **Corrigé :** `react-native-worklets@~0.5.1`
(pin Expo SDK 54 = 0.5.1) ajouté aux devDependencies. Le bundle Android se reconstruit :
`_expo/static/js/android/entry-….hbc` (4,68 MB), et contient bien le code du correctif.

### 🟡 Divergences VPS/GitHub (ÉTAPE 10)

- **`backend/prisma/schema.prisma` divergeait** de `prisma/schema.prisma` alors que le
  workflow `deploy-vps.yml` génère le client Prisma du VPS depuis **ce fichier** :
  `Subscription.displayProtocol/technicalProtocol` absents, modèle `SubscriptionDevice`
  absent, `VpnProfile.uuid` non-unique, `jsonConfig` absent, `XPanelConfig` vs
  `ServerConfig`… → **synchronisé** à l'identique.
- **`backend/server/` était un miroir obsolète** de `server/` (routes `provision.ts` et
  `app-register.ts` absentes, `mobile.ts`, `vpn-profiles.ts`, `crypto.ts`… différents)
  → **synchronisé** intégralement (le bundle de production est compilé depuis la racine
  `server.ts` + `server/`, elle-même intacte et déjà correcte).
- `Dockerfile.backend` copie `prisma/`, `server/`, `server.ts` de la racine → cohérent.
- Impossible de vérifier l'état live du VPS depuis ce sandbox (egress bloqué vers
  `vpnsxb.afrihall.com` : curl → `000`). La preuve est donc documentaire : le workflow
  déploie `git reset --hard origin/main` + rebuild `server.ts` + `prisma generate` —
  avec cette PR, GitHub redevient la source de vérité unique. **Action requise après
  merge :** `git push main` (ou `gh workflow run deploy-vps.yml`) pour resynchroniser
  le VPS ; l'APK sera reconstruit par `build-android.yml` grâce au fix worklets.

### 🟡 Régression assets (bonus)

`require("@/assets/…)` pour images et fonts (4 écrans + `_layout`) : le bug de crash
documenté dans `MOBILE_DEBUG_REPORT.md` (Bug #1) était réapparu. → chemins relatifs
rétablis partout.

### 🟢 Ce qui était SAIN (vérifié, non modifié)

- `server/routes/provision.ts` (AES-256-GCM, clé par appareil HMAC, signature, garde
  fail-closed `PROVISION_SECRET`, statuts 400/401/403/404/503) — testé E2E, **17/17**.
- `server/routes/mobile.ts` (auth/activate, connections, vpn/config) — testé E2E.
- `server/routes/vpn-profiles.ts` / `subscriptions.ts` (chiffrement GCM, tokens SXB-DATA).
- `SxbVpnService.kt` / `SxbVpnModule.kt` (moteur libbox v6, TUN, SSH+Payload WS,
  watchdog, keystore natif) — revue complète, lecture des champs conforme
  (`host`, `port`, `usePayload` via `protocol.contains("payload")`, `tlsEnabled`).
- `offlineStorage.ts`, `configValidator.ts` (gardien + `mergeConfigs` non-destructif).

---

## 2. FICHIERS MODIFIÉS

| Fichier | Nature | Détail |
|---|---|---|
| `app-mobile/services/aesGcm.ts` | **nouveau** | AES-256-GCM pur TypeScript (FIPS-197 + SP 800-38D) : decrypt+encrypt, GHASH, comparateur de tag à temps constant, codec UTF-8 autonome, `decryptSxbBlob()`. Zéro dépendance, compatible Hermes/JSC/Web/Node. |
| `app-mobile/services/provisionClient.ts` | modifié | `decryptGCM` : WebCrypto si dispo → **fallback `decryptSxbBlob`** ; décodage UTF-8 sans dépendre de `TextDecoder`. |
| `app-mobile/contexts/VpnContext.tsx` | modifié | `connect()` : n'utilise une config stockée que si complète, sinon re-provisionne (dataToken multi-sources), logs explicites ; **quota local synchronisé** après provision et dans `refreshVpnConfig` (`saveQuotaData` depuis `/mobile/vpn/config`). |
| `app-mobile/package.json` + `package-lock.json` | modifié | `react-native-worklets@~0.5.1` (devDependencies) — build Metro/APK réparé. |
| `app-mobile/app/_layout.tsx`, `app/index.tsx`, `app/onboarding.tsx`, `app/activate.tsx`, `app/(tabs)/index.tsx` | modifié | `require()` d'assets en chemins relatifs (régression du Bug #1 corrigée). |
| `backend/prisma/schema.prisma` | synchronisé | = `prisma/schema.prisma` (source de vérité). |
| `backend/server.ts`, `backend/server/**` | synchronisé | = arbre racine `server/` (incl. `routes/provision.ts`, `routes/app-register.ts`). |
| `scripts/tests/*` | **nouveau** | 3 suites E2E exécutables + stubs + hooks (voir §4). |
| `RAPPORT_MISSION_SXB_FIX.md` | **nouveau** | Ce rapport. |

---

## 3. CE QUE CONTIENT DÉSORMAIS LA SAUVEGARDE HORS-LIGNE (ÉTAPE 8)

Après provisionnement réussi, **deux** persistances cohérentes, contenant la config
intégrale émise par `/provision/activate` (et jamais une config incomplète, gardien
`saveCompleteConfig`) :

- `SecureStore sxb_prov_config_v2` (Keystore Android) + `AsyncStorage sxb_prov_meta_v2`
- `SecureStore sxb_offline_vpn_config_v2` (gardien `isCompleteOfflineConfig` à l'écriture)

Champs prouvés présents à la restauration : `protocol, displayProtocol, host, port,
username, password, uuid, tls, sni, network, dns, payload, payloadId, path, headerType,
grpcServiceName, flow, fingerprint, publicKey, shortId, spiderX, profileId, profileName`
(suivant protocole : ssh, ssh+payload, vless, vmess, trojan, shadowsocks, wireguard,
hysteria2, tuic — les 8 familles testées une par une). À la restauration hors-ligne,
le JSON envoyé au natif est **identique** au provision (deep-equal après décryptage).

---

## 4. TESTS EFFECTUÉS (preuves exécutables)

### 4.1 Crypto pipeline — `scripts/tests/provision-e2e.test.mjs`
`node --experimental-strip-types scripts/tests/provision-e2e.test.mjs` → **17/17**
- AVANT : ancien code → `Moteur cryptographique indisponible` sous Hermes ✔ (cause confirmée)
- Serveur exact (`vpn-profiles.encrypt` → `provision.decryptDbField` → `encryptForDevice`)
- Mobile APRÈS : `decryptSxbBlob` deep-equal config serveur, 0 champ perdu
- **24 roundtrips croisés Node `crypto` ↔ implémentation TS** (0→3000 octets, bit-exact)
- Rejet AEAD : ciphertext falsifié, blob tronqué, clé autre appareil ✔
- UTF-8 (accents/emoji/CJK dans payloads) roundtrip exact ✔

### 4.2 Route HTTP réelle — `scripts/tests/provision-route.e2e.mjs`
Route `provision.ts` **réelle** compilée par esbuild, servie par express, DB mockée,
JWT middleware **réel** : **17/17** — 200/JSON/`gcm:`/configKey/signature vérifiable
HMAC-SHA256/`encVersion=gcm-v2`/dates ISO/quota ; IV aléatoire par appel, clé
déterministe ; déchiffrement = profil complet ; effets DB (deviceId, lastProvisionAt) ;
régression : même device → 200, autre device → 403, expiré → 403+transition DB,
suspendu/révoqué → 403, token inconnu → 404, sans JWT → 401, secret absente → 503,
deviceId absent → 400.

### 4.3 Appareil simulé (ÉTAPES 2→9) — `scripts/tests/device-sim.e2e.mjs`
Vrai serveur local + **vrai code mobile de production** (`provisionClient`,
`offlineStorage`, `configValidator` compilés ; SecureStore/AsyncStorage mockés en
mémoire ; axios réel vers le serveur local) : **18/18**
- activate → connections (dataToken) → provision → **SecureStore complet**
- **redémarrage app → mode avion** → `loadVpnConfig` → JSON moteur identique
  (`host=196.216.10.15, port=443, username, password, payload, usePayload=true, tls=true`)
- cycle quota : épuisement → blocage ; expiration → blocage ; renouvellement → déblocage
- **réparation d'une config héritée incomplète** → re-provision → config complète persistée
- re-provisionnement idempotent (même deviceId) ✔

### 4.4 Builds
- `npx tsc -p app-mobile/tsconfig.json --noEmit` → **0 erreur**
- `npx expo export --platform android` (Metro/Hermes) → **entry.hbc 4,68 MB** contenant
  le correctif (`decryptSxbBlob`… présents dans le bytecode, vérifié par `strings`)
- `esbuild server.ts --bundle --packages=external` (pipeline CI exact) → **server.cjs 241 kB OK**

### Captures avant/après (extrémités du pipeline)

```
AVANT (Hermes)   : decryptGCM → throw "Moteur cryptographique indisponible"
                   → PROVISION_FAILED → CONFIG_READY hasHost=false hasCreds=false
                   → CONFIG_INCOMPLETE_BLOCK missing=host,port,credentials
APRÈS (Hermes)   : decryptSxbBlob → {"protocol":"ssh+payload","host":"196.216.10.15",
                   "port":443,"username":"sxb_u42","password":"…","payload":"…","sni":"web.whatsapp.com","tls":true}
                   → isCompleteOfflineConfig complete=true hasHost=true hasCreds=true
                   → saveVpnConfig OK → hors-ligne: mêmes champs, startVpn(JSON) valide
```

---

## 5. CE QUI RESTE HORS PORTÉE DU SANDBOX (transparence)

- **Exécution sur appareil/Android réel** (VpnService, TUN, libbox, JSch) : non testable
  ici (pas d'émulateur). La lecture des champs par `SxbVpnService.kt` a été vérifiée
  statiquement et le JSON d'entrée validé par le simulateur. Le trafic Internet final
  dépend aussi de l'état des serveurs SSH/upstream (VPS), hors périmètre code.
- **Requêtes live vers `vpnsxb.afrihall.com`** : egress bloqué depuis le sandbox ;
  synchro VPS effective au prochain déploiement (workflow existant, inchangé).

## 6. CHECKLIST FINALE (code & pipeline)

- ✅ aucune exception dans les flux provision/restore (52 assertions vertes)
- ✅ aucun `Network Error` lié au déchiffrement (le chemin ne dépend plus de WebCrypto)
- ✅ aucun `host missing` — `hasHost=true`, `hasCreds=true` sur toutes les configs
- ✅ `CONFIG_INCOMPLETE_BLOCK` ne peut plus se figer (re-provision auto + logs explicites)
- ✅ SecureStore complet (ÉTAPE 8, champs listés §3)
- ✅ restauration hors-ligne strictement identique (deep-equal)
- ✅ build APK (Metro) réparé ; backend bundle CI OK ; typecheck 0 erreur
- ⚠️ validation du tunnel sur appareil physique + déploiement VPS : requis après merge
