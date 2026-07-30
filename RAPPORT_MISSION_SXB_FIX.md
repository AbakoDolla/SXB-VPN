# RAPPORT DE MISSION — CORRECTION VPN ET BUILD ANDROID CI DE SXB VPN

**Dates :** 2026-07-29 — 2026-07-30
**Branche finale :** `arena/019fb122-sxb-vpn`
**Méthode :** scan du dépôt, reproduction, instrumentation ciblée, correction minimale,
validation E2E exécutable et preuve sur le pipeline GitHub Actions de production.

---

## 1. CAUSES RACINES EXACTES

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
   `encryptedBlob` + `configKey` (prouvé par test HTTP réel, §4.2)
4. `provisionAndStore` → `decryptGCM()` → 💥 **`Moteur cryptographique indisponible`**
   (reproduit dans un environnement sans `crypto.subtle`, §4.1)
5. Catch → `PROVISION_WARN / PROVISION_FAILED` → **aucune config complète n'est jamais
   stockée** dans SecureStore
6. `VpnContext.connect()` → gardien `isCompleteOfflineConfig` →
   `CONFIG_READY hasHost=false hasCreds=false missing=[host,port,credentials]`
   → **`CONFIG_INCOMPLETE_BLOCK`** (log exact produit en production, §4.3)
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

### 🔴 Cause du build Android CI — Reanimated 4 exige la nouvelle architecture

Le run instrumenté
[`30492141052`](https://github.com/AbakoDolla/SXB-VPN/actions/runs/30492141052)
a fourni, via l'annotation `SXB-GRADLE-FAILURE`, la chaîne de causes Gradle exacte :

```text
app-mobile/node_modules/react-native-reanimated/android/build.gradle:298
Execution failed for task ':react-native-reanimated:assertNewArchitectureEnabledTask'.
[Reanimated] Reanimated requires new architecture to be enabled.
Please enable it by setting newArchEnabled to true in gradle.properties.
```

Le projet construit volontairement avec l'ancienne architecture React Native. La panne
était donc déclenchée par `react-native-reanimated@4.1.7` **avant**
`:app:createBundleReleaseJsAndAssets`. Cela élimine comme causes de ce run Metro,
Hermes, CMake/NDK, Kotlin et Node 24. Le dernier build antérieur vert utilisait
Reanimated 3.19.5 ; l'application n'utilise Reanimated dans aucun écran actif.

**Correctif minimal (PR #12) :** retour à `react-native-reanimated@3.19.5` et suppression
de `react-native-worklets`, dépendance de Reanimated 4 devenue inutile. Il n'a pas été
nécessaire d'activer la nouvelle architecture ni de modifier le workflow.

**Preuve CI après correction :** le run
[`30512255502`](https://github.com/AbakoDolla/SXB-VPN/actions/runs/30512255502)
est vert en **14 min 37 s** sous Node **24.18.0**. Les étapes build release, localisation
APK, upload de l'artefact, GitHub Release, déploiement SCP et installation dans le
dossier de distribution VPS sont toutes vertes. La release
[`apk-164`](https://github.com/AbakoDolla/SXB-VPN/releases/tag/apk-164) contient
`sxb-vpn.apk` (63 892 693 octets).

### 🟠 Correctif Metro préalable — nécessaire et conservé

`expo/metro-config` ajoute `<racine-repo>/node_modules` à `watchFolders`, mais ce dossier
n'existe pas sur le runner qui installe seulement `app-mobile/node_modules`. Metro
appelle `verifyRootExists` sur chaque entrée et échoue alors avec `ENOENT`. Ce défaut a
été reproduit puis corrigé en PR #9 en filtrant uniquement les `watchFolders` existants
dans `app-mobile/metro.config.js`. Ce correctif pérenne est conservé ; il était
nécessaire au bundling, mais distinct de l'échec Gradle Reanimated 4 prouvé ci-dessus.

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
- Le sandbox ne peut toujours pas joindre directement `vpnsxb.afrihall.com`
  (`curl` → `000`). En revanche, les runners autorisés ont validé les déploiements :
  `deploy-vps` run `30488286589` vert pour le backend, puis `build-android` run
  `30512255502` vert jusque dans les étapes SCP et installation de l'APK sur le VPS.

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
| `app-mobile/package.json` + `package-lock.json` | modifié | Reanimated ramené à `~3.19.5` ; Worklets supprimé — compatibilité avec l'ancienne architecture restaurée. |
| `app-mobile/metro.config.js` | modifié | Filtre les `watchFolders` inexistants (fix Metro CI conservé) ; sonde temporaire retirée après diagnostic. |
| `app-mobile/app.json`, `plugins/withCiGradleAnnotations.js`, `react-native.config.js` | nettoyé | Instrumentation CI temporaire supprimée une fois la cause acquise et le premier run vert obtenu. |
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
- `NODE_ENV=production npx expo export --platform android` avec Reanimated 3.19.5 et
  sans Worklets → **succès**, bundle Hermes `entry-0b8d6a4e….hbc` de **4 419 423 octets**
- `npm ls react-native-reanimated react-native-worklets --all` → Reanimated 3.19.5,
  aucun paquet Worklets
- `esbuild server.ts --bundle --packages=external` (pipeline CI exact) → **server.cjs 241 kB OK**
- GitHub Actions `30512255502` → **succès complet**, artefact CI
  `sxb-vpn-android-apk-164` (32 502 986 octets compressés) et release APK #164 publiée

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
- **Requêtes live vers `vpnsxb.afrihall.com`** : egress bloqué depuis le sandbox.
  La validation distante disponible est celle du runner GitHub : déploiements backend
  et APK réussis, sans prétendre remplacer un test fonctionnel depuis un appareil.

## 6. CHECKLIST FINALE (code & pipeline)

- ✅ aucune exception dans les flux provision/restore (52 assertions vertes)
- ✅ aucun `Network Error` lié au déchiffrement (le chemin ne dépend plus de WebCrypto)
- ✅ aucun `host missing` — `hasHost=true`, `hasCreds=true` sur toutes les configs
- ✅ `CONFIG_INCOMPLETE_BLOCK` ne peut plus se figer (re-provision auto + logs explicites)
- ✅ SecureStore complet (ÉTAPE 8, champs listés §3)
- ✅ restauration hors-ligne strictement identique (deep-equal)
- ✅ build APK release réparé sur le vrai runner CI sous Node 24.18.0
- ✅ artefact et GitHub Release `apk-164` publiés ; APK copié et installé sur le VPS
- ✅ backend déployé par `deploy-vps` ; backend bundle CI OK ; typecheck 0 erreur
- ✅ sondes de diagnostic retirées après acquisition de la cause ; fix Metro conservé
- ⚠️ validation du tunnel et du trafic Internet sur appareil physique encore requise

---

# PHASE B — REFONTE « INTERMÉDIAIRE SÉCURISÉ » (2026-07-30)

Suite au verdict de la Phase A (causes prouvées dans `AUDIT_PHASE_A_FINAL_2026-07-30.md`),
le produit a été refondu selon l'architecture impérative : **le dashboard SXB ne crée,
n'installe et ne configure aucun serveur — il importe, stocke chiffré et provisionne
sans altération technique des configurations obtenues auprès de fournisseurs externes.**

## B.1 Cause principale du SSH_TIMEOUT (rappel — prouvée)

Le profil « Evans new » (`protocol=ssh, port=443, tls=true, sni=yamo.mtn.cm`) pointait
un serveur **SSH-over-WebSocket en clair** (sonde décisive : 101 → trames
`SSH-2.0-BugSleuth_0.1.9`). Or le moteur natif en SSH direct ouvre un socket **TCP brut**
et ignore silencieusement TLS (`SxbLoggingSocketFactory`). Config correcte =
`ssh+payload`, `tls=false`, payload WS Host. Refonte : cette combinaison est désormais
**rejetée à l'import (backend 422) et à la validation (mobile)**, et le natif
journalise `TLS_IGNORED_SSH_DIRECT` si une vieille config y parvenait encore.

## B.2 Flux cible implémenté

```
Fournisseur externe (URI/JSON)
  → Import admin (dashboard, assistant dédié)
  → Parsing/validation (server/services/canonical-config.ts)
  → Config CANONIQUE chiffrée AES-256-GCM + hash sha256 déterministe (JSON normalisé)
  → Abonnement → Provision chiffrée par appareil (/provision/activate)
  → Déchiffrement mobile → JSON moteur TECHNIQUEMENT IDENTIQUE (preuve §8.1 deepEqual)
```

- **Champs administratifs éditables** : nom, description, displayName, statut,
  validité offline, quota/durée (abonnement).
- **Champs techniques immuables** hors réimport explicite (backend 409) : protocol,
  host, port, credentials, TLS/SNI, transport, path, payload, crypto.
- **Formats d'import** : ssh/ssh+payload JSON, vless://, vmess://, trojan://, ss://,
  WireGuard (conf), Hysteria2, TUIC, sing-box JSON, canonique SXB.
- **jsonConfig en clair : supprimé** — tout import est redirigé vers canonicalConfig
  chiffré, colonne legacy stockée NULL.

## B.3 Préflight « Tester la configuration importée » (§7)

`POST /api/config-test` (importConfig OU profileId) — transport-only, **aucune
authentification tentée**, aucun serveur créé/configuré :
`DNS_RESOLVED → TCP_CONNECTED (+LATENCY_MS) → [TLS_HANDSHAKE_OK|TLS_FAILED] →
SSH_BANNER_RECEIVED|SSH_BANNER_MISSING → HTTP 101/200/UNEXPECTED`.
Verdicts : `transport_ok` 🟢 · `invalid` 🔴 · `unreachable_from_probe` 🟠
(≠ invalide : géo/opérateur-restreinte possible) · `unsupported`.
Profils stockés : validatedAt/validationStatus/validationMessage mis à jour.

## B.4 Mobile (fusion et frontière native)

- **Allowlist métadonnées uniquement** depuis `/mobile/connections` et
  `/mobile/vpn/config` : displayName, ids, dataToken, quota, dates, configVersion,
  configHash. Jamais protocol/host/port/tls/sni/payload/path/network/credentials
  (`mergeConnectionMetadata`). Le provisionné est la SEULE source technique
  (`mergeProvisionedConfig`).
- **`/mobile/connections` n'expose plus `server`(host) ni `port`**.
- **Invalidation de cache** : comparaison configHash (serveur vs cache) et
  changement d'abonnement → **purge atomique + re-provisionnement**.
- **Frontière native nettoyée** (`sanitizeEngineConfig`) : aucun null n'atteint
  Android — fin du `payload="null"` (AOSP `optString` → chaîne "null",
  payload_len=4 de l'incident).
- **Natif** : `optStringOrNull` partout, WARN `TLS_IGNORED_SSH_DIRECT`, codes
  erreur différenciés alignés sur le préflight (AUTH_FAILED, TLS_FAILED,
  SSH_BANNER_MISSING, HTTP_UNEXPECTED, TCP_TIMEOUT, DNS_FAILED).

## B.5 Preuves (toutes VERTES au 2026-07-30)

| Suite | Résultat |
|---|---|
| provision-e2e (pipeline crypto) | 17 groupes ✅ |
| provision-route (route réelle + doublures) | 17 ✅ |
| device-sim (cycle vie appareil E2E) | 18 ✅ |
| canonical-config (parseurs/chiffrement) | 10 ✅ |
| transport-probe (sondes simulées) | 9 ✅ |
| **incident-repro** (5 défauts prouvés rouges AVANT) | **13/13 ✅** |
| mirror-parity (anti-divergence + fidélité §8.1 ×6 formats) | 10 ✅ |
| tsc app-mobile `--noEmit` | 0 erreur ✅ |
| `expo export --platform android` | bundle 4.42 MB ✅ |
| `vite build` dashboard | 1836 modules ✅ |

Total : **94 assertions/groupes vertes, 0 régression sur les 52 historiques.**

## B.6 Déploiement — EN ATTENTE DE VALIDATION EXPLICITE

Avant migration prod (ordre mission §10) :
1. Sauvegarde vérifiable DB (`pg_dump`) + `git rev-parse HEAD` VPS.
2. `prisma db push` (colonnes additives : canonicalConfig, canonicalConfigHash,
   configVersion, sourceFormat, importedAt, validatedAt, validationStatus,
   validationMessage) — pas de perte de données ; profils existants = legacy,
   continuent de fonctionner, réimport possible pour les passer en canonique.
3. Déploiement backend (miroir `backend/` synchronisé — test anti-divergence).
4. Re-import du profil incident en ssh+payload/tls=false (payload WS) si choisi.
5. Remédiation VPS validée séparément : nettoyage remote URL (PAT), UFW
   3001/9090/4000, `pnpm-lock.yaml` modifié, XNet (502/8443).
6. Compilation APK à valider via pipeline (toolchain Android hors sandbox).
