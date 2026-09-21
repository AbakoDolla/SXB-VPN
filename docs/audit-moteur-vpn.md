# Audit du moteur VPN SXB — PHASE 1

> **Portée** : moteur VPN mobile uniquement (application React Native/Expo, natif Android,
> modules VPN, pont React Native, interface des journaux).
> **Méthode** : lecture seule. Chaque affirmation ci-dessous est rattachée à un fichier et,
> lorsque c'est utile, à une ligne. Ce qui n'a pas pu être vérifié est écrit
> **NON VÉRIFIÉ** — jamais deviné.
> **Ce document n'affirme aucun résultat de test.** Aucun test n'a été exécuté pendant
> cette phase ; la section 9 dit seulement quelles commandes existent.

---

## 1. Conclusion en une page

Le dépôt ne contient **pas** un moteur VPN embryonnaire à compléter. Il contient un moteur
multi-protocoles déjà largement implémenté, cohérent, et globalement bien construit du
point de vue sécurité.

Ce qui est **déjà là et fonctionne au niveau du code** :

| Famille | Statut | Support |
|---|---|---|
| SSH direct | Implémenté | JSch `com.github.mwiede:jsch:0.2.21` |
| SSH + Payload HTTP | Implémenté | `SxbPayloadProxy`, style HTTP Injector |
| SSH + TLS | Implémenté | `SxbTlsSocketFactory`, SNI + vérification d'identité |
| SSH + WebSocket | Implémenté | Vrai RFC 6455 : handshake **et** framing masqué |
| SSH + proxy HTTP CONNECT | Implémenté | Négociation CONNECT |
| SSH + SOCKS5 | Implémenté | Serveur SOCKS5 local → `direct-tcpip` JSch |
| UDP over SSH | Implémenté | SOCKS5 UDP ASSOCIATE → BadVPN udpgw |
| VLESS / VMess / Trojan / Shadowsocks | Implémenté | sing-box 1.12.9 (libbox) |
| WireGuard | Implémenté | sing-box, tag `with_wireguard` |
| Hysteria2 / TUIC | Implémenté | sing-box |
| DNSTT (tunnel DNS) | Implémenté | binaire `libdnstt.so` |
| Statistiques réelles | Implémenté | compteurs noyau TUN + `TrafficStats` |
| Reconnexion automatique | Implémenté | politique pure testée en CI |

**Conséquence directe sur la mission** : il ne faut **rien réécrire**, et surtout pas
ajouter Xray-core. Ce serait un second moteur redondant avec sing-box, un second binaire Go
de plusieurs Mo par ABI, pour des protocoles **déjà pris en charge**. La section 4 du
cahier des charges demande explicitement de ne pas sélectionner de moteurs redondants sans
justification ; il n'y en a pas.

Les vrais manques se situent ailleurs, et ils sont au nombre de trois :

1. **Un défaut de correction dans la machine à états** qui fait annoncer `connected` sans
   preuve de trafic — exactement ce que le cahier des charges interdit (§12). Détail en 6.1.
2. **L'interface des journaux ne montre pas ce que le moteur produit.** Le moteur émet
   une quarantaine de traces `[SXB_TRACE]` détaillées ; l'écran n'en affiche que dix, et
   il n'existe ni niveau de gravité, ni filtre, ni pause, ni copie. Détail en 6.2.
3. **AmneziaWG est absent** et ne peut pas être ajouté via le moteur actuel. Détail en 6.3.

---

## 2. Architecture réelle

### 2.1 Versions vérifiées

| Élément | Version | Source |
|---|---|---|
| React Native | `0.81.5` | `app-mobile/package.json` |
| Expo SDK | `54.0.36` | `app-mobile/package.json` |
| React | `19.1.0` | `app-mobile/package.json` |
| expo-router | `~6.0.17` | `app-mobile/package.json` |
| TypeScript | `~5.9.3` | `app-mobile/package.json` |
| Nouvelle architecture RN | **désactivée** (`newArchEnabled: false`) | `app-mobile/app.json:10` |
| compileSdk / targetSdk / minSdk | `36 / 36 / 24` | `plugins/withSxbVpn.js:578-583` |
| Java (CI) | `17` | `.github/workflows/build-android.yml:26-35` |
| NDK (CI) | `27.1.12297006` | `.github/workflows/build-android.yml:36-44` |
| Gradle | wrapper | `.github/workflows/build-android.yml:42-45` |
| sing-box | `v1.12.9` | `scripts/build-libbox.sh:7-13` |
| Go (libbox) | `>= 1.23` | `scripts/build-libbox.sh:16-23` |
| gomobile / gobind | `v0.1.8` (fork SagerNet) | `scripts/build-libbox.sh:92-101` |
| ABI livrées | `arm64-v8a`, `armeabi-v7a` | `build-android.yml:301-320`, `641-648` |

**NON VÉRIFIÉ** : versions Kotlin et AGP (fixées par `expo prebuild`, pas déclarées dans le
dépôt) ; champ `engines` absent des `package.json`.

`compileSdk/targetSdk/minSdk` ne sont injectés que dans la branche `extra.distribution === 'play'`
du plugin. Hors de ce cas, ce sont les valeurs par défaut d'Expo SDK 54 qui s'appliquent.

### 2.2 Chaîne de compilation — le point le plus important à comprendre

**Il n'y a aucun dossier `android/` versionné.** Le projet est en Expo *managed* et le
projet Android est régénéré intégralement à chaque build :

```
expo prebuild --platform android --clean --no-install    (build-android.yml:110-118)
        ↓
plugins/withSxbVpn.js  ← TOUT le natif est injecté ici
        ↓
android/  (éphémère, jamais commité)
```

`withSxbVpn.js` (28 Ko) copie les `.kt` de `modules/android-native/` vers
`android/app/src/main/java/com/sxbvpn/vpnmodule` (`withSxbVpn.js:203-215`), enregistre
`SxbVpnPackage` dans `MainApplication.kt` (`:251-337`), déclare le service VPN au manifeste
(`:102-146`), ajoute les dépendances Gradle (`:345-365`), le dépôt JitPack (`:377-381`), les
options de packaging (`:382-395`), les règles ProGuard (`:220-246`) et copie `libbox.aar`
(`:434-490`).

> **Règle qui en découle** : toute modification native doit passer par `withSxbVpn.js` ou par
> `modules/android-native/`. Écrire directement dans `android/` serait effacé au prochain
> `prebuild --clean`.

### 2.3 Chemin des données

```
Application Android
   │
   ▼
Interface TUN  (VpnService.Builder.establish → SxbVpnService.kt:2783)
   │
   ▼
sing-box / libbox  (pile TCP/IP gVisor, in-process, openTun → :2670-2835)
   │
   ├─── SSH ────────► SOCKS5 local 127.0.0.1  ──► JSch direct-tcpip ──► serveur SSH
   │                  (:4629-4795)                 (:4718-4730)
   │                         └── UDP ──► SxbUdpGateway ──► BadVPN udpgw
   │                                     (SxbUdpGateway.kt:23-39, 113-171)
   │
   └─── VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC
        outbound sing-box natif  (:3211-3218)
```

Le fait que **sing-box porte le TUN dans les deux cas** est la meilleure nouvelle de cet
audit : il n'y a qu'une seule interface VPN système, quel que soit le protocole. La
contrainte du §7 du cahier des charges (« une seule session VPN système active à la fois »)
est donc déjà respectée par construction.

---

## 3. Protocoles réellement disponibles

### 3.1 Famille SSH — complète

Tous les modes du §5 du cahier des charges sont présents.

| Mode | Preuve |
|---|---|
| Direct | `SxbVpnService.kt:1692-1999`, JSch importé `:76-79` |
| Payload HTTP | `SxbPayloadProxy` `:295-375`, envoi `:414` |
| TLS | `SxbTlsSocketFactory` `:718`, usage `:1865-1876` |
| WebSocket | handshake `:1064-1113`, `WsOutputStream` `:140-177`, `WsInputStream` `:179-277` |
| Proxy HTTP CONNECT | `:1727-1728`, `:1763-1764`, `:1852-1863` |
| SOCKS5 | `:4629-4795` |
| UDP | `:4700-4708` → `SxbUdpGateway.kt` |

**Le WebSocket est un vrai RFC 6455**, ce qui mérite d'être souligné parce que c'est
rarement le cas dans ce type d'application :

- `Sec-WebSocket-Key` aléatoire, en-têtes `Upgrade` / `Connection` / `Sec-WebSocket-Version: 13` (`:1076-1084`) ;
- contrôle du statut `101` (`:454-457`, `:607-612`) ;
- **framing complet** en écriture (FIN, opcode 0x2, masque client 4 octets obligatoire,
  longueurs 7 / 7+16 / 7+64 bits) dans `WsOutputStream` (`:140-177`) ;
- framing complet en lecture avec réponse automatique aux `ping` dans `WsInputStream` (`:179-277`).

Le moteur distingue même un `101` « cosmétique » (serveur qui répond 101 mais parle SSH en
clair) d'un vrai WebSocket, et classe le transport en conséquence : `TRANSPORT_SELECTED
mode=SSH_RAW reason=101_then_ssh_banner` (`:607`) contre `mode=WEBSOCKET_RFC6455
reason=http_101_upgrade` (`:612`). C'est un niveau de finesse qu'il ne faut pas casser.

### 3.2 Famille V2Ray / sing-box — complète

`SxbVpnService.kt:1482-1483` route `vless`, `vmess`, `trojan`, `shadowsocks`, `wireguard`,
`hysteria2`, `tuic` vers `startSingBoxTunnel`. Les outbounds sont construits en
`:3211-3218` et `:4299-4386`. REALITY, uTLS/fingerprint, gRPC, WebSocket, flow XTLS et
`packetEncoding` sont gérés (`:3150-3210`).

`SxbEngineSchema.kt` (26 Ko) modernise les configurations anciennes vers le schéma
sing-box 1.12.9 avant démarrage (`SxbEngineSchema.kt:57`, appel `SxbVpnService.kt:2317-2325`).
C'est ce qui permet aux profils provisionnés il y a des mois de continuer à fonctionner —
il ne faut surtout pas contourner cette porte.

### 3.3 Ce qui n'existe pas

| Élément | Statut | Remarque |
|---|---|---|
| Xray-core / libXray | **Absent du natif** | Recherche dépôt entière : aucun binding natif |
| AmneziaWG | **Absent** | sing-box amont ne le gère pas |
| Hysteria v1 | Absent | listé en `:4087-4088` comme type accepté, pas d'outbound dédié |

Il existe du code Xray côté serveur (`server/services/xray-translate.ts`) mais c'est un
**traducteur Xray → sing-box**, pas un moteur. C'est d'ailleurs la bonne architecture : les
liens `vless://` / `vmess://` des clients sont convertis vers sing-box, un seul moteur
tourne sur le téléphone.

---

## 4. Système de journalisation existant

### 4.1 Côté natif — riche

`SxbSecureLogger.kt` masque IP, IPv6, UUID, base64, noms d'hôtes, ainsi que les clés
`password`, `token`, `secret`, `username` (`:35-45`, `:81-111`), et reste **silencieux en
release** (`:1-21`, `:35-74`). Les journaux partent vers React Native par
`DeviceEventEmitter` sous trois noms : `onVpnStateChange`, `onVpnLog`, `onAccessStateChange`
(`SxbVpnModule.kt:567`, `575`, `585`).

Le moteur émet **une quarantaine de traces structurées** `[SXB_TRACE] stage=… clé=valeur`.
Inventaire vérifié :

```
WS_FRAME_OUT · WS_FRAME_IN · WS_CLOSE · WS_PONG_SENT · WS_FRAME_TIMEOUT
SOCKET_CREATED · SOCKET_PROTECT · DNS_RESOLVE · TCP_CONNECTED
TLS_HANDSHAKE_SUCCESS · PAYLOAD_NORMALIZED · PAYLOAD_SENT
HTTP_RESPONSE · HTTP_HEADERS · MODE_CLASSIFIED · TRANSPORT_SELECTED
POST_HEADER_PEEK · SSH_BANNER_WAIT · ENDPOINT_RESOLVED
TRANSPORT_MODE_CACHED · TRANSPORT_MODE_CACHE_PURGED · ATTEMPT_STRATEGY
SSH_TUNNEL_START · SSH_HANDSHAKE_START · SSH_HANDSHAKE_SUCCESS · SSH_CONNECTED
SSH_TUNNEL_IGNORED · SSH_SESSION_SUPERSEDED · STEP_12_SOCKS_STARTED · SOCKS5_READY
AUTO_RECONNECT_TRIGGERED · RECONNECT_RELEASE_TUNNEL
STEP_6_TUN_CREATING · TUN_CREATED · LIBBOX_STARTED · TUNNEL_READY
SOCKS5_CLIENT_ACCEPT · SOCKS5_REQUEST · SOCKS5_TARGET_RESOLVED
SSH_DIRECT_TCPIP_CONNECTED · SOCKS5_RELAY_CLOSED · SOCKS5_ERROR
```

### 4.2 Côté application — beaucoup plus pauvre que la source

`services/journalTechnique.ts` applique une **liste blanche à deux verrous** : seules les
étapes citées sont lues, et pour chaque étape seules les clés citées le sont, chaque valeur
devant satisfaire un validateur de forme strict. C'est une excellente conception de sécurité
— un nom d'hôte ne peut pas fuir, non pas parce qu'on l'a filtré, mais parce qu'aucune
étape ni aucune forme ne l'accepte.

Mais cette liste blanche ne retient que **10 étapes sur ~40** :

```
SOCKET_CREATED · DNS_RESOLVE · TCP_CONNECTED · TLS_HANDSHAKE_SUCCESS
PAYLOAD_SENT · HTTP_RESPONSE · TRANSPORT_SELECTED · SSH_BANNER_WAIT
LIBBOX_STARTED · SOCKS5_RELAY_CLOSED
```

Sont donc invisibles alors qu'elles sont émises et **sans danger** : `SOCKET_PROTECT`,
`MODE_CLASSIFIED`, `SSH_HANDSHAKE_START`, `SSH_HANDSHAKE_SUCCESS`, `SSH_CONNECTED`,
`STEP_12_SOCKS_STARTED`, `SOCKS5_READY`, `TUN_CREATED`, `TUNNEL_READY`,
`SSH_DIRECT_TCPIP_CONNECTED`, `AUTO_RECONNECT_TRIGGERED`, `ATTEMPT_STRATEGY`,
`WS_CLOSE`, `WS_FRAME_TIMEOUT`, `SOCKS5_ERROR`…

C'est le cœur du problème : **le client croit que l'application ne journalise rien, alors
qu'elle journalise beaucoup et ne l'affiche pas.**

### 4.3 L'écran `app/journal.tsx`

C'est une **chronologie d'étapes**, pas une console. Il offre l'horodatage, la durée par
étape, le marquage des étapes lentes et le partage. Il lui manque tout ce que le §8.D du
cahier des charges demande :

| Exigence §8 | État |
|---|---|
| Affichage temps réel | Partiel — étapes seulement |
| Niveaux DEBUG / INFO / WARN / ERROR | **Absent** |
| Couleurs par niveau | Absent (couleurs par *statut d'étape*) |
| Filtrage par niveau | **Absent** |
| Filtrage par module | **Absent** |
| Pause / reprise du défilement | **Absent** |
| Effacement de l'affichage | **Absent** |
| Copie des journaux | Partiel — partage global uniquement |
| Limite mémoire | Présente côté `vpnLogs` |
| Réglage de verbosité | **Absent** |

---

## 5. Statistiques

Réelles, et correctement mesurées. `TrafficStatsManager.kt` préfère les compteurs noyau de
l'interface TUN (`/sys/class/net/<tun>/statistics/…`, `:274-325`) aux compteurs par UID
(`TrafficStats.getUidTxBytes/RxBytes`, `:240-271`), ce qui est le bon choix. Le débit est un
delta sur fenêtre d'une seconde (`:216-238`) — mesuré, pas simulé. Un compteur kilométrique
persistant survit au redémarrage (`:17-18`, `:43-66`, `:147-199`).

Exposé à React Native : `uploadBytes`, `downloadBytes`, `uploadSpeed`, `downloadSpeed`,
`tunAttached`, `lifetimeUploadBytes`, `lifetimeDownloadBytes`, `connectedSeconds`
(`SxbVpnModule.kt:304-335`).

**Aucune donnée fabriquée n'a été trouvée.**

---

## 6. Limitations identifiées

### 6.1 DÉFAUT CRITIQUE — `connected` est annoncé sans preuve de trafic

C'est le manquement le plus grave au cahier des charges (§9 et §12 : « Ne pas annoncer
CONNECTED tant que les critères réels de connexion ne sont pas satisfaits »).

Le code exprime pourtant la bonne intention, deux fois :

- `openTun()` passe délibérément en `handshaking` et non `connected`, avec ce commentaire
  (`SxbVpnService.kt:2804-2810`) :
  > « Pour V2Ray/Xray, on passe en état "handshaking" au lieu de "connected". On attendra
  > que le moteur sing-box confirme le flux réel dans `writeLog()`. »

- `writeLog()` exige une preuve venant de l'outbound **proxy**, en écartant explicitement
  les outbounds locaux `direct` / `dns` / `block` (`:2968-2988`, prédicat
  `isProxyHandshakeProof` `:3106-3116`). Le commentaire est sans ambiguïté :
  > « DÉTECTION DU HANDSHAKE RÉELLEMENT ÉTABLI (§4 — ne jamais simuler). »

**Mais un repli annule les deux.** À la fin de `startLibboxService`, juste après le retour
de `service.start()` (`:2375-2382`) :

```kotlin
// On s'assure que l'état est bien "connected" (déjà fait normalement dans openTun)
if (currentState != "connected") {
    broadcastStatus("connected"); setCurrentState("connected")
    ...
}
```

Or `openTun()` est appelé **par** libbox pendant `service.start()`. Quand `service.start()`
rend la main :

- chemin sing-box : l'état vaut `handshaking` → différent de `connected` → **promu de force** ;
- chemin SSH : `openTun` n'a rien changé (`!isSshRelay` est faux) donc l'état vaut
  `connecting` → différent de `connected` → **promu de force**.

Dans les deux cas l'état devient `connected` alors que **le seul fait établi est que le
moteur a démarré**. Aucun octet n'a traversé le proxy. Pire, comme la garde de `writeLog()`
exige `currentState == "handshaking"`, elle ne peut plus jamais se déclencher : la
vérification honnête est rendue inatteignable.

Le commentaire « déjà fait normalement dans openTun » est faux depuis que `openTun` a été
corrigé pour émettre `handshaking` : les deux correctifs se sont neutralisés.

Conséquence visible pour l'utilisateur : l'application affiche « connecté » alors que le
réseau a pu refuser la connexion sortante. C'est exactement le reproche du client.

La couche JavaScript n'offre aucun rattrapage : `VpnContext.tsx:911-920` fait confiance à
l'événement natif. Son commentaire — « Seul `connected`, qui exige la preuve d'un flux réel
par le proxy, atteste que le réseau nous a acceptés » — décrit une garantie **que le natif
ne fournit plus**.

### 6.2 Journaux — la source est riche, l'affichage est pauvre

Voir 4.2 et 4.3. Aucune information n'a besoin d'être inventée : tout est déjà émis. Le
travail consiste à élargir la liste blanche aux étapes sûres, à porter un niveau de gravité,
et à donner à l'écran les commandes du §8.D.

### 6.3 AmneziaWG

Non intégrable en l'état : sing-box amont ne gère pas AmneziaWG, et l'ajouter imposerait un
second moteur natif (amneziawg-go), donc un second binaire Go par ABI. À rapporter comme
non retenu, avec la raison.

### 6.4 Points mineurs

- `SxbVpn.types.ts` liste `VpnProtocolType` sans `dnstt`, `anytls`, `ssh+websocket`,
  `ssh+tls`, `ssh+http-connect`, alors que le natif les gère. Le typage est en retard sur
  le moteur.
- `modules/expo-sxb-vpn/src/index.ts` n'expose ni `setKillSwitch`, ni `setAutoReconnect`,
  ni `checkSecurity`, ni `getBatteryOptimizationState`, qui existent pourtant côté natif
  (`SxbVpnModule.kt:451`, `457`, `469`, `288`).
- Aucun réglage de verbosité : `SxbSecureLogger` est binaire (debug ou silencieux).

---

## 7. Sécurité — état des lieux

Contrairement à ce qu'on pouvait craindre, cette partie est saine. Vérifications faites :

| Contrôle | Résultat |
|---|---|
| Clé d'hôte SSH | **Vérifiée.** Épinglage strict si le backend fournit une empreinte (`SxbHostKeyVerifier.kt:34-68`), sinon TOFU journalisé (`:71-90`). `StrictHostKeyChecking=no` n'est posé **que** dans le cas TOFU (`SxbVpnService.kt:1828-1830`). Seconde vérification de l'empreinte négociée après le handshake (`:2002-2014`). |
| Validation TLS | **Active.** `endpointIdentificationAlgorithm = "HTTPS"` (`:346-360`). |
| TrustManager permissif | **Aucun trouvé.** Pas de `X509TrustManager` maison, pas de `trustAllCerts`, pas de `HostnameVerifier` permissif dans tout `modules/android-native/`. |
| Masquage des secrets | Actif (`SxbSecureLogger.kt:35-45`, `81-111`) et renforcé par la liste blanche JS. |
| Session VPN unique | Garantie : un seul TUN, porté par sing-box. |

Un point d'attention : `SxbVpnService.kt:3145` lit `insecure` / `allowInsecure` depuis la
configuration et le transmet à sing-box. C'est un réglage **par profil, fourni par
l'exploitant**, pas un contournement global, et c'est un comportement standard des clients
sing-box. Il n'est pas modifié dans cette mission, mais il mérite d'être signalé.

---

## 8. Cartographie des fichiers

### 8.1 À modifier (périmètre mobile)

| Fichier | Nature |
|---|---|
| `app-mobile/modules/android-native/SxbVpnService.kt` | Corriger la promotion d'état 6.1 ; émettre un niveau de gravité sur les traces |
| `app-mobile/services/journalTechnique.ts` | Élargir la liste blanche ; porter le niveau |
| `app-mobile/app/journal.tsx` | Niveaux, filtres, pause, effacement, copie |
| `app-mobile/localization/fr.ts` / `en.ts` | Libellés des nouvelles étapes |
| `app-mobile/modules/expo-sxb-vpn/src/SxbVpn.types.ts` | Aligner `VpnProtocolType` sur le natif |
| `app-mobile/tests/*.test.ts` | Tests des nouveaux comportements |

### 8.2 À ne pas toucher

- `prisma/schema.prisma`, `server/routes/clients.ts`, `server/routes/vpn-profiles.ts`
  — **propriété d'une autre session**, interdiction stricte.
- Reste de `server/` et `backend/` — hors périmètre.
- `plugins/withSxbVpn.js`, `scripts/build-libbox.sh`, `.github/workflows/build-android.yml`
  — **aucune raison d'y toucher**, puisque aucun moteur n'est ajouté. C'est le principal
  bénéfice de la décision de ne pas intégrer Xray.
- Authentification, rôles, quotas, jetons, appareils : intacts.

---

## 9. Tests disponibles

Commandes existantes (**non exécutées à ce stade**) :

```bash
cd app-mobile && npm run typecheck          # tsc --noEmit
cd app-mobile && npm run test:regression    # tsx --test
node app-mobile/tests/run-access-policy.cjs        # Kotlin, requiert kotlinc
node app-mobile/tests/run-stability-policy.cjs     # Kotlin, requiert kotlinc
node app-mobile/tests/run-reconnect-recovery.cjs   # Kotlin, requiert kotlinc
```

`npm run test:regression` couvre aussi des tests de `../server/tests/`. Les tests Kotlin
compilent les sources natives avec `kotlinc` puis les exécutent avec `java` ; ils
nécessitent un JDK et Kotlin installés.

**Limite structurelle à annoncer au client** : aucune de ces commandes n'établit un tunnel
réel. Elles valident de la logique pure. La seule preuve de fonctionnement du moteur est un
APK installé sur un appareil réel, avec un vrai serveur. Il faut distinguer en permanence :

1. tests unitaires (exécutables ici) ;
2. tests simulés (exécutables ici) ;
3. tests réseau réels (**impossibles dans cet environnement**).

---

## 10. Risques, dépendances, licences

### 10.1 Licences

| Composant | Version | Licence |
|---|---|---|
| JSch (fork mwiede) | 0.2.21 | BSD 3-clauses |
| Bouncy Castle | 1.78.1 | MIT |
| kotlinx-coroutines-android | 1.7.3 | Apache 2.0 |
| firebase-messaging | 24.1.2 | Apache 2.0 |
| sing-box | 1.12.9 | **GPL-3.0** |
| dnstt | commit `17aa1fed` | Domaine public / CC0 |

> **Point d'attention sérieux, à remonter au client.** sing-box est sous **GPL-3.0**. Il est
> lié dans l'APK via `libbox.aar`. La GPL-3.0 exige que l'ensemble de l'œuvre distribuée
> soit offert sous GPL-3.0, sources incluses, aux destinataires du binaire. `assets/engine/NOTICE.txt`
> existe déjà dans le dépôt et devra être vérifié sur ce point. **Ce n'est pas un problème
> introduit par cette mission** — c'est l'état actuel du produit — mais il serait malhonnête
> de ne pas le signaler. Une décision juridique est requise ; elle sort de mon périmètre.

### 10.2 Risques techniques

| Risque | Gravité | Atténuation |
|---|---|---|
| Ajouter Xray-core (libXray) | Élevée | **Écarté** — redondant avec sing-box |
| Toucher à `withSxbVpn.js` | Élevée | Aucun changement nécessaire |
| Casser R8/ProGuard | Moyenne | Aucune classe nouvelle appelée par réflexion |
| Régression de la liste blanche des journaux | Moyenne | N'ajouter que des étapes sans donnée libre, validateurs de forme conservés |
| Modifier la machine à états | Moyenne | Corriger *un* repli, par ailleurs contraire à l'intention déjà écrite dans le code |
| Fuite de secrets | Faible | Double verrou conservé intégralement |

---

## 11. Ce que je ne peux pas affirmer

Par honnêteté, et parce que le client a été trompé par le passé :

- Je **n'ai exécuté aucun test** pendant cette phase.
- Je **n'ai pas compilé** l'APK ; aucun appareil Android n'est disponible ici.
- Je **n'ai établi aucune connexion réelle** vers un serveur.
- Le défaut 6.1 est établi **par lecture du code**, de façon documentée et reproductible,
  mais sa manifestation à l'écran n'a pas été observée sur appareil.
- Les versions Kotlin et AGP effectives ne sont pas déterminables depuis le dépôt seul.

---

*Rapport produit en phase 1 (lecture seule). Aucun fichier du dépôt n'a été modifié
pendant l'audit.*
