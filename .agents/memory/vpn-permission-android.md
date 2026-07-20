---
name: VPN Permission Android
description: Correctif critique — permission VPN Android doit déclencher startActivityForResult
---

## Problème
`VpnService.prepare()` retourne un Intent non-null quand la permission VPN n'est pas accordée. Si on ignore l'Intent et qu'on appelle directement `startVpn()`, le service plante sans popup système.

## Solution dans SxbVpnModule.kt
1. Implémenter `ActivityEventListener` dans le module
2. `isVpnPermissionGranted()` — méthode synchrone, vérifie uniquement
3. `requestVpnPermission()` — méthode asynchrone :
   - Si permission déjà accordée: résoud `true` immédiatement
   - Si besoin permission: store la promise, appelle `activity.startActivityForResult(vpnIntent, VPN_REQUEST_CODE)`
   - `onActivityResult()` résoud la promise avec `resultCode == RESULT_OK`

## Solution dans VpnContext.tsx (connect())
```typescript
// AVANT startVpn() :
const alreadyGranted = SxbVpnNative.isVpnPermissionGranted(); // synchrone
if (!alreadyGranted) {
  const granted = await requestVpnPermission(); // asynchrone → popup
  if (!granted) { setIsConnecting(false); return; }
}
```

## Gestion d'erreur
Si `startVpn()` rejette avec `VPN_PERMISSION_REQUIRED`, retry automatique via `requestVpnPermission()`.

**Why:** sans `startActivityForResult`, l'utilisateur ne voit jamais la popup Android "Autoriser VPN?" et la connexion échoue silencieusement.
**How to apply:** tout code qui appelle `startVpn()` doit vérifier/demander la permission VPN d'abord.
