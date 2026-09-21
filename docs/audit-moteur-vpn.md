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

---
---

# Rapport de livraison — PHASES 2 à 6

*Ce second rapport rend compte de ce qui a été fait après l'audit. Il est écrit
pour être opposable : chaque affirmation y est soit accompagnée de la commande
qui la prouve, soit explicitement marquée comme non vérifiée.*

---

## 12. Ce qui a changé, et pourquoi si peu

L'audit a établi un fait qui a déterminé toute la suite : **l'essentiel de ce que
la mission demandait existait déjà**. Dix-neuf protocoles dispatchés, une famille SSH
complète avec ses transports, sing-box intégré et compilé depuis les sources officielles,
un moteur qui émet une centaine de types de traces.

Le problème n'était donc pas l'absence de moteur, mais **l'écart entre ce que le moteur
sait et ce que l'application en montre** — et, plus grave, **deux endroits où l'application
affirmait quelque chose de faux**.

La stratégie retenue a été d'étendre et de corriger, jamais de reconstruire. Aucune
réécriture, aucune migration, aucun changement de navigation, de design ou de logo.
`plugins/withSxbVpn.js` n'a pas été touché. Le système d'authentification, les rôles,
les abonnements, les quotas et les règles d'accès n'ont pas été touchés.

**Aucun fichier de `server/`, `prisma/` ou `backend/` n'a été modifié.** Aucune
modification backend ne s'est révélée nécessaire ; il n'y a donc rien à remonter
sur ce point.

---

## 13. Les trois corrections de fond

### 13.1 `connected` annoncé sans preuve — corrigé

C'était le défaut 6.1, et la priorité absolue.

**Ce qui se passait.** Trois endroits décidaient de l'état. Deux garde-fous avaient été
posés par le passé, chacun correct isolément. Mais `startLibboxService()` contenait un
repli — `if (currentState != "connected") { setCurrentState("connected") }` — qui les
annulait tous les deux. **Deux correctifs successifs s'étaient neutralisés l'un l'autre**,
ce qui explique qu'un défaut apparemment traité ait survécu.

**Ce qui a été fait.** Une porte unique, `promoteToConnected()`, qui exige que le service
tourne *et* que l'état soit `handshaking`. La preuve retenue est la progression des
**octets reçus** (`rx_bytes`) de l'interface TUN.

> **Pourquoi les octets *reçus*, et pas les octets émis.** `tx_bytes` progresse dès qu'une
> application *tente* d'émettre — même vers un tunnel mort. S'en servir comme preuve
> reviendrait à confirmer une connexion parce que le téléphone a parlé dans le vide.
> Seul `rx_bytes` atteste qu'un correspondant a répondu. C'est le cœur du raisonnement.

**Le cas du délai.** Ne jamais annoncer `connected` sans preuve ne doit pas conduire à
laisser l'utilisateur devant un écran figé. L'attente est donc bornée à 60 s, au-delà du
chien de garde applicatif (45 s). À l'échéance, deux situations distinctes :

| Situation | Décision | Ce que voit l'utilisateur |
|---|---|---|
| Compteurs lisibles, rien reçu | `failVpn("TUNNEL_STALLED")` | Un échec franc, avec son motif |
| Compteurs illisibles | État **présumé**, journalisé comme tel | Un état honnête, pas un mensonge |

Le second cas est le compromis : plutôt qu'un `connected` mensonger ou qu'un blocage
indéfini, l'application dit ce qu'elle sait et ce qu'elle ignore.

**Vérification structurelle.** Il ne subsiste **qu'un seul** `setCurrentState("connected")`
dans tout le code natif. C'est ce qui empêche un troisième correctif de neutraliser
celui-ci comme les précédents se sont neutralisés.

### 13.2 Deux traces muettes — corrigées

Ces deux défauts n'avaient pas été repérés pendant l'audit. Ils sont apparus en
confrontant la liste blanche des étapes aux **formats réellement émis** par le code natif,
relevés un à un.

**Premier défaut — le préfixe.** Le motif de reconnaissance exigeait `stage=` collé au
marqueur `[SXB_TRACE]`. Or l'aide `trace()` intercale un compteur et une durée :
`[SXB_TRACE] seq=N elapsed_ms=M stage=X`. **Toutes** les étapes passant par cette aide
étaient donc invisibles — dont `LIBBOX_STARTED`, c'est-à-dire « Tunnel établi »,
l'étape la plus attendue de tout le journal.

**Second défaut — la valeur tronquée.** L'extraction d'un champ s'arrêtait à la clé
suivante, reconnue par `[a-z_]+=`. Cette expression ne reconnaît pas `connect200=`, qui
contient des chiffres. La valeur du champ précédent débordait dessus et se faisait
rejeter par son validateur. Conséquence : `MODE_CLASSIFIED` n'affichait jamais rien.

**Un piège évité au passage.** En admettant le préfixe, un champ `elapsed_ms` aurait pu
capter celui du préfixe — c'est-à-dire la durée depuis l'allumage de l'appareil, affichée
comme durée d'étape. L'extraction est donc restreinte au corps de la trace, après le nom
de l'étape.

> Ces deux défauts sont la meilleure preuve que la vérification a réellement eu lieu :
> ils ne se déduisent pas de la lecture du code, seulement de la confrontation entre
> ce que le journal attend et ce que le moteur émet.

### 13.3 Le Kill Switch ne tenait pas sa promesse — corrigé

Quand l'utilisateur active le Kill Switch, l'application affiche :
*« Toute connexion internet sera bloquée si le VPN se déconnecte. »*

C'est une promesse de sécurité, pas un réglage de confort.

**Ce qui se passait.** Les deux valeurs (Kill Switch, reconnexion automatique) voyagent
bien dans les options de `startVpn` : régler **avant** de connecter a toujours fonctionné.
Mais le contexte exposait `setKillSwitchState`, un simple `useState`. Changer d'avis
**pendant** une session ne prévenait personne — le service natif, qui tourne dans son
propre processus, gardait la valeur figée au moment de la connexion.

Deux conséquences opposées, toutes deux fâcheuses :

- **activer** en cours de session laissait le tunnel sans protection, alors que
  l'interface affirmait le contraire ;
- **désactiver** en cours de session laissait le « trou noir » en place, et l'utilisateur
  se retrouvait sans internet sans comprendre pourquoi.

**Ce qui a été fait.** `SxbVpnModule` exposait déjà `setKillSwitch` et `setAutoReconnect`,
qui agissent sur `SxbVpnService.instance` — la session vivante. **Personne ne les
appelait.** C'est désormais fait, sans rien retirer du chemin existant.

---

## 14. Le journal — ce qui a été ajouté

Le moteur émet une centaine de types de traces ; le journal en exposait dix.

**Liste blanche portée de 10 à 18 étapes.** Chaque format a été relevé par lecture du
code natif, jamais deviné. Les vocabulaires fermés (`mode=`, `reason=`) ont été relevés
de la même façon — on y découvre par exemple que `TRANSPORT_SELECTED mode=` possède
**deux** vocabulaires distincts selon l'endroit qui l'émet.

**Une étape a été retirée après analyse.** Un garde-fou existant a rejeté
`SSH_DIRECT_TCPIP_CONNECTED`. Examen fait, le garde-fou avait raison : cette étape se
rouvre à chaque destination visitée. Le rythme des lignes aurait trahi l'activité de
navigation de l'utilisateur, et le journal aurait été noyé. **Elle a été retirée plutôt
que le garde-fou contourné.**

**L'écran.** Filtres par niveau (problèmes / réussites) et par source (application /
moteur), gel de l'affichage, effacement avec confirmation, partage suivant les filtres.

Deux points méritent d'être signalés :

- La distinction application / moteur n'est pas une catégorie inventée : elle s'appuie
  sur le préfixe `moteur:` que `inscrireFaitMoteur` est seul à poser. Un contrôle vérifie
  que les deux restent d'accord, faute de quoi le filtre « Moteur » se viderait en silence.
- Un journal vidé **par un filtre trop étroit** ne se dit pas comme un journal
  **réellement vide**. L'un demande de relâcher le filtre, l'autre de patienter. Les
  confondre enverrait l'utilisateur chercher une panne qui n'existe pas.

**Protection contre les fuites — inchangée.** L'écran ne lit que des clés de traduction
choisies dans le code ; le champ de détail n'est affiché que s'il ressemble à un code
(majuscules, chiffres, tirets bas). Un texte libre est ignoré plutôt que rendu. Le double
verrou existant a été conservé intégralement.

**Mémoire.** Vérification faite, la rotation était déjà en place (journaux plafonnés à 300,
file d'attente 400→200, étapes dédupliquées par clé). **Aucun code redondant n'a été ajouté.**

---

## 15. Protocoles — état à la livraison

### 15.1 Intégrés et dispatchés par le moteur

| Famille | Valeurs acceptées |
|---|---|
| SSH | `ssh`, `ssh+payload`, `ssh+tls`, `ssh+ssl`, `ssh+payload+tls`, `ssh+payload+ssl`, `ssh+http`, `ssh+proxy`, `ssh+http-connect`, `ssh+slowdns`, `slowdns`, `ssh+udp` |
| sing-box | `vless`, `vmess`, `trojan`, `shadowsocks`, `wireguard`, `hysteria2`, `tuic` |
| Brut | `singbox` (configuration sing-box native transmise telle quelle) |

**Une correction de type.** `singbox` était reconnu par le validateur et dispatché par le
moteur, mais absent de `VpnProtocolType` : un profil valide était refusé par le typage.
Corrigé.

**Ce qui reste volontairement absent des types.** Les variantes de saisie (`ssh+tls`,
`ssh+slowdns`…) ne figurent dans aucun des deux types TypeScript, et c'est correct :
`configValidator` les ramène à `ssh` ou `ssh+payload` avant l'envoi, en reportant le
détail dans des champs dédiés (`tls`, `slowDns`, `udpMode`). Les faire figurer serait
réclamer une redondance que le code a justement supprimée.

> **Correction d'une note d'audit.** Une note intermédiaire signalait `dnstt` et
> `ssh+websocket` comme manquants dans les types. Vérification faite dans le répartiteur
> natif, **ces deux valeurs n'y existent pas** : les ajouter aurait inventé une capacité.
> Seul `singbox` manquait réellement.

**Un garde-fou a été ajouté** pour comparer les trois vocabulaires — validateur, pont et
répartiteur natif. Ils vivent dans trois fichiers, deux langages et deux processus, et rien
ne les obligeait jusqu'ici à rester d'accord.

### 15.2 Non intégré — Xray-core, et pourquoi

**Xray-core n'a pas été ajouté, délibérément.** Cet arbitrage a été validé par le
coordinateur.

Xray-core apporterait VLESS, VMess, Trojan et Shadowsocks. **Ces quatre protocoles sont
déjà dispatchés par sing-box**, compilé depuis les sources officielles et déjà lié dans
l'APK. L'ajouter reviendrait à :

- embarquer un second moteur Go complet (plusieurs dizaines de Mo par architecture) ;
- maintenir deux convertisseurs de configuration là où un seul suffit ;
- faire coexister deux moteurs susceptibles de revendiquer l'interface TUN, alors que la
  règle est **une seule session VPN système active à la fois** ;
- doubler la surface de mise à jour et de sécurité.

Pour un gain fonctionnel nul. La seule différence pratique serait le support de REALITY
dans certaines variantes — que sing-box 1.12.9 prend également en charge.

### 15.3 Non intégré — AmneziaWG

Non intégré. `wireguard` est dispatché via sing-box, mais les extensions anti-DPI
d'AmneziaWG (`Jc`, `Jmin`, `Jmax`, `S1`, `S2`, `H1`–`H4`) ne sont pas reconnues.
Les intégrer supposerait un second moteur ou un fork de sing-box — le même raisonnement
qu'en 15.2 s'applique.

---

## 16. Licences — obligation à traiter

Le tableau de la section 10.1 reste valable. Un point demandait vérification ; elle a été
faite, et la part qui relevait du code a été corrigée.

**Le constat initial : `app-mobile/assets/engine/NOTICE.txt` ne couvrait pas sing-box.**
Ce fichier documentait correctement la base de domaines `geosite.db` (données MIT de
v2fly, converties par un outil GPL non embarqué). Il ne disait **rien de sing-box
lui-même**.

Or sing-box v1.12.9 est cloné depuis le dépôt officiel `SagerNet/sing-box`, compilé par
`gomobile bind` et lié dans l'APK sous forme de `libbox.aar`. **sing-box est sous
GPL-3.0-or-later.**

### 16.1 Ce qui a été corrigé

L'attribution manquante a été ajoutée au fichier livré avec l'application : composant,
version 1.12.9 — celle que `build-libbox.sh` compile réellement —, source amont, licence,
notice amont reproduite telle quelle (clause de nom comprise) et texte intégral de la
GPL-3.0. Une entrée a également été ajoutée pour `libdnstt.so` (`Mygod/dnstt`, CC0 1.0) :
aucune obligation juridique ici, mais aucune bibliothèque native livrée ne reste désormais
sans origine traçable.

Les textes de licence ne sont pas retapés. Ils proviennent des sources officielles : la
notice sing-box du `LICENSE` au tag `v1.12.9`, et le texte GPL-3.0 de gnu.org, recoupé
octet pour octet avec le `COPYING` de GNU coreutils. Un texte de licence approximatif
vaudrait moins que pas de licence du tout — il donnerait l'apparence de la conformité sans
en avoir la substance. `tests/attribution-licences.test.ts` fige donc son empreinte
SHA-256 ; **la capacité de ce contrôle à échouer a été prouvée** en modifiant une seule
lettre du texte, ce qui l'a bien fait échouer, puis en restaurant le fichier.

Le contrôle d'artefact `scripts/android-artifact.mjs` ne vérifiait l'attribution que pour
geosite. Il vérifie désormais aussi celle de sing-box **sur l'APK construit** : seul ce
qui est empaqueté atteint l'utilisateur.

### 16.2 Ce qui reste ouvert — et n'appartient pas au code

| Point | État |
|---|---|
| Origine du moteur | Dépôt officiel, version épinglée `v1.12.9` — vérifiable |
| Mention de la licence GPL-3.0 dans l'app | **Présente** depuis cette livraison |
| Texte de la GPL-3.0 distribué | **Présent**, vérifié verbatim |
| Attribution de dnstt (CC0) | **Présente** |
| Mise à disposition des sources correspondantes | **Toujours absente** |

L'attribution ne règle pas l'obligation de fond. L'article 6 de la GPL-3.0 demande que les
sources correspondantes accompagnent le binaire distribué ; ce point demeure entier.

**Aucune promesse n'a été inscrite dans le fichier** : ni offre de sources, ni engagement
de publication, ni lien vers un dépôt. Déclarer une licence est un constat ; mettre le code
à disposition est une décision commerciale, qui n'est pas celle du dépôt.

Deux voies restent donc ouvertes, et **le choix appartient au client seul** : se conformer
en publiant les sources correspondantes, ou remplacer le moteur par une brique sous licence
permissive. Ce rapport ne tranche pas.

**Ce n'est pas un problème introduit par cette mission** — c'est l'état du produit depuis
l'intégration de sing-box. Mais il aurait été malhonnête de ne pas le signaler une fois la
vérification faite, et la part qui relevait du code a été traitée sans préjuger de la suite.

---

## 17. Tests — ce qui a été exécuté, et ce qui ne l'a pas été

Cette section est écrite en réponse directe au reproche du client : *les livraisons
précédentes n'auraient pas été testées.* La distinction demandée est donc faite
explicitement.

### 17.1 Tests réellement exécutés

| Vérification | Commande | Résultat |
|---|---|---|
| Suite complète | `npm run test:regression` | **761 / 761**, 0 échec |
| Typage | `npm run typecheck` | **exit 0** |
| Politique de preuve (Kotlin, sur JVM) | `node tests/run-handshake-proof.cjs` | **11 / 11** |
| Syntaxe Kotlin du code ajouté | `kotlinc` | **0 erreur de syntaxe, 0 erreur citant un symbole ajouté** |

Point de départ avant toute modification : **692 tests**. À la livraison : **761**.
**69 contrôles ajoutés.**

La politique de preuve du `connected` a été extraite dans une classe Kotlin pure
(`SxbHandshakeProofPolicy`) précisément pour pouvoir être **exécutée** sur JVM, sans
appareil ni SDK Android. Ce n'est pas une relecture : c'est une exécution.

### 17.2 Un garde-fou dont la capacité à échouer a été prouvée

Un contrôle qui ne peut pas échouer ne vaut rien. Le garde-fou de concordance des
protocoles a donc été mis à l'épreuve : en retirant `singbox` du type du pont, il produit
**2 échecs**, comme attendu. Le fichier a ensuite été restauré et la suite rejouée.

### 17.3 Nature des tests — sans ambiguïté

| Nature | Présent ? | Détail |
|---|---|---|
| **Tests unitaires** | Oui | Logique pure : filtres, analyse de traces, politique de preuve |
| **Tests structurels** | Oui | Lecture du code source (JS et Kotlin) pour vérifier un câblage que l'on ne peut pas exécuter hors appareil |
| **Tests simulés** | Partiels | Pont natif simulé dans quelques contrôles existants |
| **Tests réseau réels** | **NON — aucun** | Voir 17.4 |

### 17.4 Ce qui n'a pas été vérifié — à lire avant toute mise en production

**Aucun tunnel réel n'a été établi.** Ni appareil Android, ni serveur de test, ni SDK
Android n'étaient disponibles dans cet environnement.

En conséquence, **je n'affirme pas** :

- que l'APK compile (`SxbVpnService.kt` ne compile pas hors Gradle, faute de SDK) ;
- qu'un tunnel s'établit réellement vers un serveur ;
- que la preuve par `rx_bytes` se déclenche comme prévu sur un vrai tunnel ;
- que les nouvelles étapes apparaissent réellement à l'écran pendant une connexion ;
- que le Kill Switch bloque effectivement le trafic sur un appareil.

Les correctifs sont établis par lecture documentée du code et par exécution de la logique
extractible. **Leur manifestation sur appareil reste à observer.**

### 17.5 Comment vérifier sur appareil réel

Dans l'ordre, sur un appareil de test et **jamais sur des données de production** :

1. `cd app-mobile && npx expo prebuild --platform android`
   *(construit `libbox.aar` si absent — compter ~10 min, Go ≥ 1.23 et NDK requis)*
2. `npx expo run:android --variant release`
3. Connecter un profil SSH, puis un profil VLESS. Ouvrir le journal.
4. **Vérifier que « Tunnel établi » apparaît** — c'est la trace qui était muette (§13.2).
5. **Vérifier qu'aucun `connected` n'est annoncé avant un octet reçu.** Le cas le plus
   parlant : un serveur joignable mais dont les identifiants sont faux. L'application doit
   signaler un échec, jamais une réussite.
6. Couper le réseau en cours de session : vérifier `TUNNEL_STALLED` plutôt qu'un état figé.
7. Connecter, puis **activer** le Kill Switch pendant la session. Couper le VPN.
   Vérifier qu'aucun trafic ne passe (§13.3).
8. Refaire l'opération en **désactivant** le Kill Switch pendant une session blackholée :
   vérifier que l'internet revient.
9. Filtrer le journal sur « Problèmes », partager : vérifier que le texte partagé ne
   contient **aucune adresse de serveur ni identifiant**.

---

## 18. Ce qui reste ouvert

| Point | Nature | Qui décide |
|---|---|---|
| Mise à disposition des sources de sing-box (§16.2) | Juridique | Le client |
| Validation sur appareil réel (§17.5) | Technique | À planifier |
| AmneziaWG (§15.3) | Fonctionnel | Le client, si le besoin se confirme |
| `isProxyHandshakeProof()` | Code mort en pratique | Sans effet — le moteur tourne en niveau `warn` et n'émet jamais la trace attendue |

---

*Rapport de livraison. Les chiffres cités proviennent d'exécutions réelles, dont les
commandes sont indiquées. Les points non vérifiés sont signalés comme tels en §17.4.*
