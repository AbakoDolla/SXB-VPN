# HANDOFF_WS_KEY_FIX.md — Fix Handshake WebSocket (Injection Sec-WebSocket-Key)

## Contexte
Lors des tests de connexion SSH+Payload avec transport WebSocket (`Upgrade: websocket`), certains serveurs WebSocket exigent un en-tête `Sec-WebSocket-Key` et `Sec-WebSocket-Version: 13` valides conformes à la RFC 6455. Sans cet en-tête, le serveur rejette le handshake (réponse HTTP 400 ou connexion fermée sans 101 Switching Protocols), provoquant un `SSH_TIMEOUT`.

## Solution (Parité Sonde)
Le module backend de test (`transport-probe.ts`) injecte automatiquement un `Sec-WebSocket-Key` aléatoire (16 octets encodés en base64) ainsi que `Sec-WebSocket-Version: 13` lorsqu'un payload contient `Upgrade: websocket` sans clé explicite.

Ce correctif applique la même logique dans le client natif Android (`SxbVpnService.kt` / `SxbPayloadProxy`) :
1. Détection de la présence de `Upgrade: websocket` (insensible à la casse) dans le payload résolu.
2. Si `Sec-WebSocket-Key` est absent, génération d'une clé aléatoire de 16 octets via `SecureRandom` et encodage base64 (`android.util.Base64.NO_WRAP`).
3. Injection de l'en-tête `Sec-WebSocket-Key` et `Sec-WebSocket-Version: 13` juste avant le saut de ligne final des en-têtes HTTP (`\r\n\r\n`), garantissant la stricte parité avec le comportement de la sonde backend.

## Fichier modifié
- `app-mobile/modules/android-native/SxbVpnService.kt`
- `artifacts/sxb-mobile/modules/android-native/SxbVpnService.kt`
