# AUDIT_PHASE1.md — SXB VPN Mobile
**Date :** 25 juillet 2026  
**Auditeur :** Replit Agent  
**Repo :** https://github.com/AbakoDolla/SXB-VPN  
**VPS :** 141.95.112.93 — Ubuntu 24.04.4 LTS  

---

## Table des matières

1. [Architecture actuelle](#1-architecture-actuelle)
2. [Inventaire des composants](#2-inventaire-des-composants)
3. [Problèmes critiques détectés](#3-problèmes-critiques-détectés)
4. [Sécurité](#4-sécurité)
5. [Android — Lifecycle et stabilité](#5-android--lifecycle-et-stabilité)
6. [Offline First — Vérification](#6-offline-first--vérification)
7. [VPS — État de production](#7-vps--état-de-production)
8. [Risques](#8-risques)
9. [Plan Phase 2](#9-plan-phase-2)
10. [Résumé — Ce qui est corrigé / Ce qui reste](#10-résumé)

---

## 1. Architecture actuelle

```
[Dashboard React + Vite]           vpnsxb.afrihall.com
        ↓
[Backend Express.js/PM2]           api.sxbvpn.afrihall.com → port 4000
        ↓
[PostgreSQL 16]                    localhost:5432 (Prisma ORM)
[Redis]                            localhost:6379
        ↓
[sing-box service]                 localhost:20091 (Clash API)
[Dropbear SSH VPN]                 port 444 (SSH direct)
[SSH WS tunnel]                    port 2223 (WebSocket)
        ↓
[App Mobile React Native/Expo]     com.sxbvpn.mobile
  ├── SxbVpnService.kt (Kotlin)
  ├── SxbVpnModule.kt  (Bridge RN)
  ├── KeystoreManager.kt
  ├── SecurityModule.kt
  ├── TrafficStatsManager.kt
  └── AutoReconnectManager.kt
```

**Flux attendu (activation) :**
```
TOKEN SXB-USER → /mobile/auth/activate → JWT pair
TOKEN SXB-DATA → /mobile/packages/activate → quota créé
                → /mobile/vpn/config → config VPN chiffrée (AES-256-CBC)
                → Mobile : stockage SecureStore / Android Keystore
                → SxbVpnService démarre sing-box ou SSH tunnel
```

---

## 2. Inventaire des composants

### 2.1 App Mobile — React Native / Expo 54
| Fichier | Rôle | État |
|---|---|---|
| `app/(tabs)/index.tsx` | Écran principal (bouton CONNECT) | ✅ Fonctionnel |
| `contexts/VpnContext.tsx` | State machine VPN global | ✅ Bien structuré |
| `contexts/AuthContext.tsx` | Auth + tokens JWT | ✅ Bien structuré |
| `services/apiClient.ts` | Axios + intercepteur refresh | ✅ Correct |
| `services/offlineStorage.ts` | Config locale SecureStore | ✅ Correct |
| `services/configValidator.ts` | Validation config VPN | ✅ Présent |
| `app/vpn-debug.tsx` | Écran debug | ⚠️ NE DOIT PAS être en prod |

### 2.2 Kotlin Native Modules
| Module | Rôle | État |
|---|---|---|
| `SxbVpnService.kt` (1757 lignes) | Moteur VPN — SSH, SSH+Payload, WS, sing-box | ✅ Complet |
| `SxbVpnModule.kt` | Bridge React Native ↔ Service | ✅ Correct |
| `KeystoreManager.kt` | AES-256-GCM Android Keystore | ✅ Excellent |
| `SecurityModule.kt` | Root/Frida/Xposed/Emulator detection | ✅ Présent |
| `TrafficStatsManager.kt` | Stats réseau Android TrafficStats | ✅ Correct |
| `AutoReconnectManager.kt` | Reconnexion auto 3 tentatives | ✅ Bon |
| `BootReceiver.kt` | Boot receiver (désactivé volontairement) | ✅ Correct |

### 2.3 Backend (VPS `/var/www/sxb-vpn`)
| Route | Endpoint | État |
|---|---|---|
| `mobile.ts` (777 lignes) | `/mobile/*` — surface mobile principale | ⛔ BUG CRITIQUE |
| `provision.ts` | `/provision/activate` — provisionnement | ⚠️ Clé de secours exposée |
| `vpn-profiles.ts` | Gestion profils VPN | ⚠️ AES-CBC sans auth |
| `auth.ts` | Authentification admin | ✅ JWT + refresh |
| `tokens.ts` | Gestion tokens SXB | ✅ |
| `subscriptions.ts` | Abonnements | ✅ |

### 2.4 Dashboard (React Vite)
Domaine : `vpnsxb.afrihall.com`  
Gère : utilisateurs, tokens, forfaits, quotas, appareils, configurations, révocation, logs, RBAC.  
État : ✅ Source unique de vérité. Interface riche, bien structurée.

---

## 3. Problèmes critiques détectés

### 🔴 CRITIQUE #1 — Prisma `payload` field manquant — Casse `/mobile/vpn/config`

**Fichier :** `server/routes/mobile.ts` ligne ~308  
**Impact :** L'application mobile **ne peut jamais récupérer une configuration VPN** depuis le backend.

**Erreur en production (logs PM2) :**
```
PrismaClientValidationError:
Invalid `prisma.subscription.findFirst()` invocation:
{
  include: {
    profile: {
      include: {
        payload: true,  ← CHAMP INEXISTANT dans le schéma Prisma
```

**Cause :** Le code `mobile.ts` fait `include: { profile: { include: { payload: true } } }` mais le modèle `VpnProfile` dans `prisma/schema.prisma` **n'a pas de relation `payload`**. Le schéma Prisma ne déclare pas de table `Payload` liée à `VpnProfile`.

**Conséquence :** Chaque tentative de connexion VPN depuis le mobile → erreur 500. Les utilisateurs ne peuvent pas se connecter même avec un abonnement valide.

**Correction immédiate :**
```typescript
// mobile.ts ligne ~300 — remplacer :
include: {
  profile: { include: { payload: true } }
}
// Par :
include: {
  profile: true  // sans payload — ou ajouter la relation dans prisma/schema.prisma
}
```

---

### 🔴 CRITIQUE #2 — sing-box sans `inbounds` — Aucun protocole VPN ne sert

**Fichier :** `/etc/sing-box/config.json` (VPS)  
**Impact :** sing-box est **démarré mais ne sert aucun protocole** (VLESS, VMess, Trojan, etc.)

**Config actuelle :**
```json
{
  "inbounds": null,   ← VIDE — aucun VPN ne peut se connecter
  "outbounds": [
    { "tag": "direct", "type": "direct" },
    { "tag": "block",  "type": "block" }
  ]
}
```

**Conséquence :** Toute connexion mobile basée sur sing-box (VLESS, VMess, Trojan, Shadowsocks, WireGuard, Hysteria2, TUIC) échoue immédiatement. Seul SSH via Dropbear (port 444) et SSH WebSocket (port 2223) pourraient fonctionner.

**Correction :** Configurer les inbounds sing-box depuis le Dashboard → Sing-box Manager, ou injecter la config depuis le backend via l'API Clash (port 20091, secret configuré).

---

### 🔴 CRITIQUE #3 — PM2 : 101 redémarrages en ~6 jours

**Cause probable :** Unhandled promise rejections dans les routes backend (erreurs Prisma non gérées qui font planter le process Node.js en mode fork).

**Données :**
```
│ restarts │ 101 │
│ uptime   │ 6h  │   ← redémarre très souvent
```

**Impact :** Interruptions de service répétées. Les utilisateurs connectés voient leurs sessions coupées.

**Correction :**
```typescript
// server.ts — ajouter avant startServer()
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  // Ne pas crasher en production — logger et continuer
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  process.exit(1); // ← PM2 redémarre, c'est voulu pour les vrais crashes
});
```

---

### 🟠 IMPORTANT #4 — Clé de chiffrement de secours hardcodée

**Fichiers :** `server/routes/mobile.ts`, `server/routes/provision.ts`, `server/routes/vpn-profiles.ts`

```typescript
// DANS TROIS FICHIERS DIFFÉRENTS :
const ENC_KEY = process.env.ENCRYPTION_KEY || 'sxb-vpn-32-byte-encryption-key-!';
//                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                              CLÉ EN CLAIR dans le code source
```

**Impact :** Si `ENCRYPTION_KEY` est absent du `.env` ou si le `.env` n'est pas chargé, toutes les configs VPN sont chiffrées avec une clé **publiquement connue** (visible dans le repo GitHub).

**Note :** Le `.env` de production contient bien `ENCRYPTION_KEY=[HIDDEN]`. Mais la clé de secours dans le code reste un risque si le `.env` est perdu ou le service démarre sans lui.

**Correction :**
```typescript
// Remplacer le fallback silencieux par un crash explicite au démarrage :
const ENC_KEY = process.env.ENCRYPTION_KEY;
if (!ENC_KEY || ENC_KEY.length < 32) {
  throw new Error('FATAL: ENCRYPTION_KEY env var manquant ou trop court (min 32 chars)');
}
```

---

### 🟠 IMPORTANT #5 — Écran `vpn-debug.tsx` accessible en production

**Fichier :** `app-mobile/app/vpn-debug.tsx`  
**Impact :** Affiche l'état interne du tunnel VPN, les logs natifs, et permet de manipuler le service. Ne doit **jamais** être accessible par un utilisateur final en production.

**Correction :** Conditionner l'accès à `__DEV__` ou supprimer le lien depuis Settings en prod :
```typescript
// settings.tsx — masquer en prod :
{__DEV__ && <Link href="/vpn-debug">Diagnostic VPN</Link>}
```

---

### 🟡 MINEUR #6 — AES-256-CBC sans authentification côté backend

**Fichiers :** `provision.ts`, `mobile.ts`, `vpn-profiles.ts`  
**Impact :** AES-CBC ne fournit pas d'intégrité (pas d'AEAD). Un attaquant qui modifie le ciphertext ne sera pas détecté.  
**Note :** Le mobile utilise AES-256-**GCM** via Android Keystore (✅ correct). L'asymétrie crée un risque à la jonction.  
**Recommandation Phase 2 :** Migrer le backend vers AES-256-GCM.

---

### 🟡 MINEUR #7 — API URL hardcodée dans le mobile

**Fichier :** `app-mobile/services/apiClient.ts`
```typescript
export const API_BASE_URL = 'https://vpnsxb.afrihall.com/api';
```
**Impact :** Impossible de changer l'URL sans recompiler l'APK. Si le domaine change → tous les utilisateurs sont bloqués.  
**Recommandation :** Utiliser `expo-constants` + `app.json` extra field, ou un mécanisme de discovery.

---

### 🟡 MINEUR #8 — `NSAllowsArbitraryLoads: true` (iOS)

**Fichier :** `app-mobile/app.json`
```json
"NSAppTransportSecurity": {
  "NSAllowsArbitraryLoads": true
}
```
**Impact :** Autorise tout trafic HTTP non sécurisé sur iOS. Apple peut rejeter l'app.  
**Correction :** Restreindre aux domaines spécifiques avec `NSExceptionDomains`.

---

### 🟡 MINEUR #9 — Logs avec `console.log` contenant des IPs

**Fichier :** `server/server.ts`
```typescript
console.log(`[${new Date().toISOString()}] 📡 ${req.method} ${req.url} - IP: ${cleanIp}`);
```
**Impact :** Les IPs des utilisateurs sont loguées en clair dans journald/PM2. Risque RGPD.  
**Recommandation :** Utiliser un logger structuré (pino/winston) avec anonymisation des IPs.

---

## 4. Sécurité

### ✅ Ce qui est bien fait

| Élément | Détail |
|---|---|
| Android Keystore AES-256-GCM | Clé matérielle, IV aléatoire, tag d'auth 128 bits |
| JWT + Refresh Token | Rotation correcte, stockage SecureStore |
| Rate limiting global | 200 req/15min par IP |
| CORS production | Whitelist strict (`vpnsxb.afrihall.com`, `sxbvpn.afrihall.com`) |
| SecurityModule | Détection Root, Frida, Xposed |
| Masquage des logs sensibles | `SecurityModule.maskSensitive()` sur les logs sing-box |
| fail2ban | Actif sur le VPS |
| HTTPS/TLS | Let's Encrypt avec TLS 1.2/1.3 |
| Token format | `SXB-USER-XXXX`, `SXB-DATA-XXXX` — pas d'UUID brut exposé |
| Pas de credentials en clair sur mobile | L'utilisateur ne voit jamais IP/port/password |

### ⚠️ Ce qui doit être corrigé

| Problème | Priorité |
|---|---|
| Clé AES hardcodée dans le code | 🔴 |
| AES-CBC → AES-GCM backend | 🟠 |
| vpn-debug en prod | 🟠 |
| NSAllowsArbitraryLoads iOS | 🟡 |
| Logs IP utilisateurs sans pseudonymisation | 🟡 |

---

## 5. Android — Lifecycle et stabilité

### ✅ Correctement implémenté

- **`startForeground()` dans `onCreate()`** — appelé immédiatement, avant toute logique VPN. Respecte la contrainte des 5 secondes Android.
- **`FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`** sur API 29+ ✅
- **`STOP_FOREGROUND_REMOVE`** sur Android 13+ (TIRAMISU) ✅ — la version dépréciée est gérée avec `@Suppress("DEPRECATION")`
- **`RECEIVER_NOT_EXPORTED`** sur Android 13+ pour les BroadcastReceivers ✅
- **`WAKE_LOCK`** — déclaré dans `withSxbVpn.js` et `app.json` ✅
- **Cleanup atomique** — `AtomicBoolean cleanupStarted` évite les double-cleanup
- **`AutoReconnectManager`** — max 3 tentatives, délais fixes 5s/15s/30s ✅
- **`BootReceiver`** — déclaré mais VPN auto-start désactivé (comportement correct) ✅
- **New Architecture désactivée** — `newArchEnabled: false` (compatible avec tous les modules natifs)

### ⚠️ Points d'attention

- **`Thread.sleep(2_500)`** après le lancement sing-box — fragile. Si le device est lent, sing-box peut ne pas être prêt en 2.5s → faux positif "sing-box crashed". Pas encore corrigé.
- **Pas de `FOREGROUND_SERVICE_DATA_SYNC`** — seul `connectedDevice` est déclaré. Sur Android 14, certains OEM (Samsung, Xiaomi) tuent les services `connectedDevice` quand l'écran est éteint si aucune connexion BT/USB active n'est détectée.

---

## 6. Offline First — Vérification

### Flux d'activation (avec internet)

```
1. POST /mobile/auth/activate (token SXB-USER)
   → JWT accessToken + refreshToken stockés dans SecureStore ✅

2. POST /mobile/packages/activate (token SXB-DATA)
   → quota associé au VpnClient ✅

3. GET /mobile/vpn/config
   → ⛔ ERREUR 500 (voir Critique #1 — Prisma payload)
   → Config VPN jamais reçue → VPN impossible
```

### Fonctionnement hors-ligne (après activation réussie)

Si la config a été reçue une fois avec succès et stockée :

```
loadVpnConfig() → SecureStore → OfflineConfig ✅
SxbVpnService → config locale → sing-box ou SSH ✅
```

**Note :** Le mécanisme est bien conçu (`offlineStorage.ts` + `SecureStore`). Mais il ne peut pas fonctionner si la config n'a jamais été téléchargée (bug Critique #1).

### Expiration hors-ligne

```
offlineStorage.ts → QuotaData.expiryDate ✅
configValidator.ts → vérification locale de l'expiration ✅
```

**Limitation :** La validation d'expiration hors-ligne est basée sur la date sauvegardée localement. Un utilisateur dont l'abonnement expire côté serveur peut continuer à se connecter offline jusqu'à la prochaine synchronisation. **Acceptable pour la Phase 1.**

---

## 7. VPS — État de production

### Services actifs

| Service | Port | État | Rôle |
|---|---|---|---|
| nginx | 80/443 | ✅ Running | Reverse proxy + TLS |
| sxb-backend (PM2) | 4000 | ⚠️ 101 restarts | API Express.js |
| PostgreSQL 16 | 5432 (local) | ✅ Running | Base de données |
| Redis | 6379 (local) | ✅ Running | Cache/sessions |
| sing-box | 20091 Clash API | ⛔ Inbounds null | Moteur VPN (non configuré) |
| Dropbear SSH | 444 | ✅ Running | SSH VPN direct |
| SSH WS tunnel | 2223 | ✅ Running | WebSocket SSH |
| Prometheus | 9090 | ✅ Running | Métriques |
| Grafana | 3001 | ✅ Running | Dashboard métriques |

### Nginx routing

```
vpnsxb.afrihall.com  → /var/www/sxb-vpn/artifacts/sxb-dashboard/dist/ (static)
api.sxbvpn.afrihall.com → http://127.0.0.1:4001 (⚠️ port 4001 mais backend écoute sur 4000)
```

**⚠️ Discordance de port :** Nginx redirige vers `127.0.0.1:4001` mais le backend PM2 écoute sur `4000`. Cela signifie que `api.sxbvpn.afrihall.com` est **mort** (502 Bad Gateway). L'API accessible depuis le mobile passe par `vpnsxb.afrihall.com/api` (via la config nginx principale, pas encore lue en totalité).

### Disk / Memory

```
Disk : 24G utilisé / 38G total (62%) → ✅ Acceptable, surveiller
RAM  : 999Mi / 3.7Gi → ✅ OK
```

---

## 8. Risques

| # | Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **0 utilisateur ne peut se connecter** (bug Prisma payload) | Certaine | 🔴 Total | Corriger `mobile.ts` immédiatement |
| R2 | **sing-box sans inbounds** — protocoles modernes non disponibles | Certaine | 🔴 Total | Configurer inbounds via Dashboard |
| R3 | **Backend instable** 101 crashes | Haute | 🔴 Élevé | Ajouter handler global, corriger Prisma |
| R4 | **Clé AES fallback** connue publiquement | Moyenne | 🟠 Élevé | Crash explicite si `ENCRYPTION_KEY` absent |
| R5 | **vpn-debug en prod** — fuite d'info interne | Faible | 🟠 Moyen | Masquer avec `__DEV__` |
| R6 | **iOS NSAllowsArbitraryLoads** — rejet App Store | Faible | 🟡 Moyen | Restreindre aux domaines SXB |
| R7 | **Disk 62%** — si logs explosent | Moyenne | 🟡 Moyen | Logrotate + monitoring |

---

## 9. Plan Phase 2

Suite à cet audit, voici les travaux recommandés pour la Phase 2 (dans l'ordre de priorité) :

### Phase 2A — Corrections bloquantes (à faire MAINTENANT)

1. **[FIX #1] Corriger `mobile.ts` — relation `payload` Prisma**
   - Retirer `include: { payload: true }` ou créer la relation dans `schema.prisma`
   - Regen Prisma client + redéployer

2. **[FIX #2] Configurer sing-box inbounds**
   - Depuis le Dashboard → Sing-box Manager → créer au moins un inbound VLESS/VMess
   - Ou écrire la config directement dans `/etc/sing-box/config.json` + `systemctl restart sing-box`

3. **[FIX #3] Unhandled rejection handler backend**
   - Ajouter `process.on('unhandledRejection', ...)` dans `server.ts`
   - Stopper les 101 redémarrages

4. **[FIX #4] Clé AES — crash explicite si absente**
   - Remplacer le fallback par un throw au démarrage du serveur

### Phase 2B — Sécurité (sprint suivant)

5. Masquer `vpn-debug.tsx` en production
6. Migrer backend de AES-256-CBC → AES-256-GCM
7. Corriger `NSAllowsArbitraryLoads` iOS
8. Anonymiser les logs IP (RGPD)
9. Vérifier le port nginx `4001` vs backend `4000`

### Phase 2C — Architecture cible (après stabilisation)

10. API URL configurable depuis `app.json` / Expo constants
11. Config sing-box dynamique depuis le Dashboard (via Clash API port 20091)
12. Push notifications abonnement expiré
13. Synchronisation quota temps réel (WebSocket ou polling)
14. Tests automatisés backend (jest/supertest sur les routes `/mobile/*`)

---

## 10. Résumé

### Ce qui a été corrigé (Phase 1 — aucune modification demandée, audit only)

> Phase 1 = Audit uniquement. Aucun code n'a été modifié.

### Ce qui est fonctionnel ✅

- Architecture mobile bien conçue (native Kotlin + RN bridge)
- Android Keystore AES-256-GCM ✅ — chiffrement mobile correct
- Foreground Service Android 12-15 correctement géré
- Auto-reconnect avec backoff ✅
- Offline First mécaniquement correct (si la config est reçue une fois)
- Dashboard complet (source de vérité) ✅
- Backend sécurisé sur le périmètre CORS/rate-limit/TLS
- SSH via Dropbear (port 444) probablement fonctionnel

### Ce qui est cassé ⛔ — Bloque 100% des connexions VPN

| # | Problème | Fichier | Impact |
|---|---|---|---|
| 1 | Prisma `payload` inexistant → `/mobile/vpn/config` 500 | `server/routes/mobile.ts:308` | **Zéro connexion possible** |
| 2 | sing-box `inbounds: null` | `/etc/sing-box/config.json` | **Aucun protocole moderne** |
| 3 | Backend 101 crashes | `server/server.ts` | **Instabilité service** |

### Ce qui doit être corrigé en Phase 2 — Avant toute nouvelle fonctionnalité ⚠️

| # | Problème | Fichier |
|---|---|---|
| 4 | Clé AES hardcodée fallback | `mobile.ts`, `provision.ts`, `vpn-profiles.ts` |
| 5 | vpn-debug accessible en prod | `app/vpn-debug.tsx` |
| 6 | AES-CBC → AES-GCM backend | Tous les fichiers crypto backend |
| 7 | NSAllowsArbitraryLoads iOS | `app.json` |
| 8 | Discordance port nginx 4001/4000 | `/etc/nginx/sites-enabled/` |

---

*Rapport généré le 25 juillet 2026 — SXB VPN Phase 1 Audit*
