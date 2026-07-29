# Correctif moteur VPN — pourquoi l'app ne se comportait pas comme un vrai client VPN

> Diagnostic et correction du problème : l'app ne montait aucun tunnel et la clé VPN
> n'apparaissait jamais dans la barre d'état Android (à côté de la batterie / du réseau).

## TL;DR

La configuration envoyée par le dashboard arrivait **correctement** jusqu'au module natif.
Le problème était entièrement dans le moteur Android : il tentait de piloter `sing-box`
comme un binaire externe, ce qui **ne peut pas fonctionner sur Android**. Le moteur a été
migré vers `libbox` (sing-box embarqué in-process), l'architecture qu'utilisent SocksIP,
HA Tunnel Plus, NPV Tunnel, HTTP Custom et le client officiel sing-box.

---

## Les 4 causes identifiées

### 1. `file_descriptor` n'existe pas dans le JSON de sing-box — cause fatale

`SxbVpnService.buildSingBoxConfig()` et `buildSshSocksRelayConfig()` généraient :

```json
{ "type": "tun", "tag": "tun-in", "file_descriptor": 42, "auto_route": false }
```

puis lançaient `sing-box run -c config.json`.

**Preuve** — dans le binaire qui était embarqué (`assets/sing-box-arm64`) :

```
strings sing-box-arm64 | grep -c file_descriptor   →  0
strings sing-box-arm64 | grep -c auto_route        →  1
```

Le champ est **absent du binaire**, et `option/tun.go` en amont ne définit aucun
`FileDescriptor`. Ce champ n'est peuplé **que** par l'API Go `libbox`, dans
`PlatformInterface.OpenTun()` :

```go
options.FileDescriptor = dupFd   // experimental/libbox/service.go
```

Conséquence : sing-box rejetait la config (`json: unknown field "file_descriptor"`)
et s'arrêtait en moins d'1,5 s — d'où le message
« sing-box s'est arrêté immédiatement (code=1) ». Le TUN n'était jamais raccordé.

De plus `auto_route: false` empêchait toute installation de route par défaut : même
si le moteur avait démarré, aucun trafic système ne serait entré dans le tunnel.

### 2. Le binaire était inexécutable (violation W^X, Android 10+)

`extractSingBoxBinary()` copiait l'asset dans `filesDir/sing-box`, faisait
`setExecutable(true)` puis `ProcessBuilder(...).start()`.

Depuis **Android 10 (API 29)**, l'exécution d'un binaire situé dans le répertoire privé
de l'app est interdite → `error=13, Permission denied`. Aucune app VPN moderne ne
procède ainsi.

### 3. Type de service en premier plan invalide sur Android 14+

Le manifeste déclarait `android:foregroundServiceType="connectedDevice"` et le service
appelait `startForeground(..., FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)`.

Sur **API 34**, `connectedDevice` exige en plus une permission runtime parmi
`BLUETOOTH_ADVERTISE` / `BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN` / `CHANGE_NETWORK_STATE`
/ `NFC` / `TRANSMIT_IR` — que l'app ne possédait pas. Résultat : `SecurityException`
levée dès `onCreate()`, service tué **avant même** de lire la configuration.

Le type correct pour une app VPN tierce est `specialUse` (le client officiel sing-box
déclare `FOREGROUND_SERVICE_SPECIAL_USE`).

### 4. Aucun `protect()` sur les sockets sortants

Ni le socket JSch/SSH, ni les sockets du moteur ne passaient par
`VpnService.protect()`. Sans cela, la connexion vers le serveur VPN est elle-même
routée dans le tunnel qu'elle alimente → **boucle de routage**, coupure immédiate.
`route.auto_detect_interface` était par ailleurs à `false`.

### Symptôme combiné

`establish()` pouvait réussir une fraction de seconde (clé qui clignote ou n'apparaît
pas), puis le bloc `finally` appelait `cleanup()` → `tunPfd.close()` → l'interface
disparaissait, statut `error`, et le watchdog 45 s de `VpnContext` concluait en timeout.

---

## Le correctif

### Moteur : `libbox` in-process

`SxbVpnService` implémente désormais `io.nekohasekai.libbox.PlatformInterface`.
sing-box tourne **dans le process de l'app** :

| Rappel libbox | Rôle |
|---|---|
| `openTun(options)` | Construit le TUN avec `VpnService.Builder` et renvoie son fd — **c'est ce qui fait apparaître la clé VPN** |
| `autoDetectInterfaceControl(fd)` | Appelle `VpnService.protect(fd)` sur chaque socket sortant |
| `getInterfaces()` / `startDefaultInterfaceMonitor()` | Fournit la topologie réseau pour le routage hors-tunnel |

Plus aucun processus externe, plus aucun fichier de config sur disque, plus aucun
descripteur récupéré par réflexion.

### Fichiers modifiés

| Fichier | Changement |
|---|---|
| `modules/android-native/SxbVpnService.kt` | Implémente `PlatformInterface` ; suppression de `extractSingBoxBinary` / `writeSingBoxConfig` / `getFdInt` / `buildTunInterface` ; `file_descriptor` retiré des configs ; `auto_route`/`auto_detect_interface` à `true` ; `startForeground` en `specialUse` ; `protect()` sur les sockets SSH |
| `modules/android-native/SxbLibboxSupport.kt` | **(nouveau)** itérateurs gomobile, moniteur de réseau par défaut, énumération des interfaces |
| `plugins/withSxbVpn.js` | `foregroundServiceType=specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` ; permission `FOREGROUND_SERVICE_SPECIAL_USE` ; copie de `libbox.aar` ; règles ProGuard `io.nekohasekai.libbox.**` / `go.**` |
| `scripts/build-libbox.sh` | **(nouveau)** compile `libbox.aar` via `gomobile bind` (sing-box `v1.11.15`) |
| `.github/workflows/build-android.yml` | Étapes Go 1.23 + build/cache de `libbox.aar` ; suppression de la copie des binaires |
| `assets/sing-box-arm{,64}` | **Supprimés** (62 Mo de binaires morts et inexécutables) |

### Protocoles couverts

Les deux chemins de production sont préservés :

- **SSH / SSH+Payload** (défaut du dashboard, `provision.ts`) — JSch + injection de
  payload conservés à l'identique ; seul le pont vers le TUN passe par libbox.
- **VLESS / VMess / Trojan / Shadowsocks / WireGuard / Hysteria2 / TUIC** — libbox direct.

---

## Construire et vérifier

```bash
# Le prebuild construit libbox.aar automatiquement s'il est absent (~10 min).
cd app-mobile
npx expo prebuild --platform android --no-install
cd android && ./gradlew :app:assembleRelease
```

Pour construire le moteur séparément (ou le régénérer) :

```bash
cd app-mobile && ./scripts/build-libbox.sh          # nécessite Go + NDK
SING_BOX_VERSION=v1.11.15 ./scripts/build-libbox.sh # version explicite
SXB_SKIP_LIBBOX_BUILD=1 npx expo prebuild ...       # sauter la construction
```

Le build est autonome : aucune modification du workflow n'est nécessaire. Le
patch optionnel `ci-patches/` ajoute simplement une mise en cache de l'AAR
pour économiser ~10 min par exécution CI.

### Ce qu'il faut voir dans logcat

```bash
adb logcat -s SXB_DEBUG:* SXB-VPN:*
```

Séquence attendue :

```
FOREGROUND_STARTED                  ← plus de SecurityException (cause 3)
STEP_5_CONFIG_LOADED proto=ssh
LIBBOX_SETUP_OK
STEP_8_LIBBOX_START version=1.11.15
STEP_6_TUN_CREATING mtu=9000 autoRoute=true
STEP_7_TUN_CREATED fd=…                ← la clé VPN apparaît ici
SSH_SOCKET_PROTECTED result=true       ← plus de boucle de routage (cause 4)
STEP_13_VPN_CONNECTED
```

### Points de vigilance restants (non bloquants)

- `libbox.aar` pèse ~30 Mo par ABI ; le build est restreint à `arm64-v8a`.
- La vérification SHA-256 du binaire (`sha256Stream`) a disparu avec le binaire ;
  l'intégrité du moteur est désormais assurée par la signature de l'APK.
- `readWIFIState()` renvoie `null` : les règles de routage par SSID ne sont pas
  utilisées par les configs SXB, et cela évite de demander la permission de
  localisation.
