# MISSION — Import JSON Xray/v2ray : détection de format, traduction sing-box, sonde v2, exécution mobile

## Problème réel corrigé

Un opérateur colle une config JSON Xray/v2ray (outbounds[].protocol, settings.vnext,
streamSettings, dokodemo-door, dns tcp+local:// + payload [crlf], chaînage
proxySettings via un proxy HTTP amont avec headers personnalisés) :

1. `canonical-config.ts` classait tout JSON avec `outbounds[]` en `singbox-json` → la config Xray passait pour du sing-box.
2. La validation singbox (« outbounds non vide ») acceptait la config Xray telle quelle.
3. La sonde v1 répondait « sonde transport v1 non applicable à singbox » → badge « Jamais testé ».
4. `configValidator.ts` mobile répétait la même heuristique (`Array.isArray(outbounds)` → singbox).
5. `SxbVpnService.kt` n'avait AUCUNE branche `"singbox"` → « Protocole inconnu : singbox » → error + stopSelf.

Conséquence produit : « importé » côté dashboard, plantage à la connexion côté app.

## Changements par partie

### PARTIE 1 — Détection stricte du format JSON (backend + mobile)
- `backend/server/services/xray-translate.ts` : `hasXrayMarkers()` / `isSingboxNativeJson()` — sing-box natif = outbounds[] d'objets avec `type` (string) ET absence de markers Xray ; Xray = au moins un marker (protocol, settings.vnext, streamSettings, dokodemo-door, dns tcp+local:// / https+local://, blackhole|freedom).
- `backend/server/services/canonical-config.ts` : `parseImportedConfig` utilise la détection stricte ; `sourceFormat` étendu à `xray-json` ; ni l'un ni l'autre → « JSON non reconnu : ni sing-box ni Xray ».
- `app-mobile/services/configValidator.ts` + `protocolDetector.ts` : miroir strict ; config stockée avec markers Xray → « Format non pris en charge — réimportez la configuration ».

### PARTIE 2 — Traducteur Xray → sing-box (backend, à l'import)
- Nouveau `backend/server/services/xray-translate.ts` : mapping complet (voir tableau ci-dessous), refus explicite pour les features non couvertes, warnings pour les features simplifiées. Le profil stocke le JSON traduit (`protocol: 'singbox'`), `sourceFormat: 'xray-json'`, warnings persistés dans `validationMessage`.
- Dashboard (`VpnProfilesView.tsx`) : format détecté (« Xray/v2ray → converti en sing-box »), warnings de traduction, aperçu JSON avec secrets masqués (`uuid/password → ****` via `configPreview` calculé côté backend).

### PARTIE 3 — Passthrough mobile singbox (`SxbVpnService.kt`)
- Branche `"singbox" → startSingBoxTunnelRaw(json)` (l.838).
- `buildRawSingBoxConfig()` : inbounds = TUN de l'app uniquement ; dns = JSON stocké sinon DNS de l'app ; route.rules = DNS hijack + ip_cidr→direct (F3) puis règles stockées ; route.final = stocké sinon premier outbound non spécial ; log.level = warn ; auto_detect_interface = true.
- Validation au démarrage : type connu pour chaque outbound, detours existants, ≥ 1 outbound non spécial → log clair + état error (jamais de crash muet).

### PARTIE 4 — Sonde transport v2 (`transport-probe.ts`)
- vless/vmess/trojan/shadowsocks/singbox : DNS → TCP(+latence) → PROXY_CONNECT (amont http, headers configurés exacts) → TLS_HANDSHAKE (SNI ; allowInsecure toléré et noté ; reality noté non-émulé) → WS_HANDSHAKE (GET path + Upgrade + clé aléatoire, 101 = ok, autre code = échec rapporté).
- Verdict → badge : OK « Testé ✓ », échec « Échec : <étape> », unreachable_from_probe inchangé + hint. Sonde SSH v1 inchangée.

## Marqueurs de vérification (commentaire de PR)

| Marqueur | Emplacement | Preuve |
|---|---|---|
| détection `xray-json` ≥ 3 occurrences | `canonical-config.ts`, `vpn-profiles.ts` | 4 occurrences |
| `xray-translate` service ≥ 1 fichier mapping complet | `backend/server/services/xray-translate.ts` | 1 fichier |
| refus `xtls-rprx-vision` ≥ 1 test | `tests/xray-translate.test.ts` | 4 tests |
| detour généré ≥ 1 | `tests/xray-translate.test.ts` (T-X1 + proxySettings) | 4 tests |
| classification `outbounds[].type` vs `.protocol` ≥ 1 | `tests/canonical-config.test.ts` | 1 test |
| sonde v2 : `PROXY_CONNECT` / `TLS_HANDSHAKE` / `WS_HANDSHAKE` ≥ 1 chacun | `transport-probe.ts` + tests | 2 / 4 / 2 |
| message « sonde transport v1 non applicable » supprimé pour les protos couverts | `transport-probe.ts` | conservé uniquement wireguard/hysteria2/tuic (l.407) |
| branche `"singbox"` dans `when(proto)` = 1 | `SxbVpnService.kt` l.838 | 1 |
| `startSingBoxTunnelRaw` ≥ 1 | `SxbVpnService.kt` | 2 (appel + définition) |
| détection stricte dans `configValidator` ≥ 1 | `configValidator.ts` | 7 (`isSingboxNativeJson`/`hasXrayMarkers`) |

## Preuves T-X1…T-X5

### T-X1 — Import de la config réelle du rapport (dashboard)
Config Xray d'origine : vless + ws + tls + amont http (headers) + dns tcp+local:// + dokodemo-door.
- Test unitaire `canonical-config.test.ts` « T-X1 : JSON Xray → sourceFormat xray-json, protocol singbox, warnings » : **PASS** (sourceFormat = `xray-json`, outbound traduit `type: vless` + `detour: upstream-http`, warnings « inbounds fournis par l'app : TUN » et « astuce DNS opérateur perdue »).
- Test unitaire `xray-translate.test.ts` « T-X1 » : **PASS** (mapping complet vérifié champ par champ, route.final = `proxy`, règles ip_cidr → direct/block, inboundTag/port 53 ignorés + warnings).
- Dashboard : bandeau post-import « Import OK — Xray/v2ray → converti en sing-box » + liste des warnings + aperçu JSON masqué (uuid/password → `****`) via `configPreview`.

### T-X2 — Sonde réelle « Tester la configuration importée »
- Tests unitaires `transport-probe.test.ts` (serveurs TCP locaux) : **10/10 PASS** — DNS_RESOLVED, TCP_CONNECTED (+latence), PROXY_CONNECT (200 ok / 403 « proxy amont refuse la cible » + headers exacts vérifiés), TLS_HANDSHAKE (échec sur serveur non-TLS → « Échec : TLS_HANDSHAKE »), WS_HANDSHAKE (101 ok / 404 → « Échec : WS_HANDSHAKE — code HTTP 404 »).
- Plus aucun verdict « sonde transport v1 non applicable » pour vless/vmess/trojan/shadowsocks/singbox (assertion de test dédiée).

### T-X3 — Téléphone (provision + connexion)
Non exécutable dans le sandbox (nécessite appareil Android réel + compte jetable + serveur opérateur réel). Chemin vérifié statiquement :
- `provision.ts` livre le canonique traduit (protocol `singbox`, outbounds vless + http + direct/block/dns) → `VpnContext` (protocol singbox) → `SxbVpnModule.startVpn` → `SxbVpnService` branche `"singbox"` (l.838) → `startSingBoxTunnelRaw` → `buildRawSingBoxConfig` (TUN app + DNS + règles + final) → `startLibboxService`. Plus de « Protocole inconnu : singbox ». À valider sur device réel avec `SXB_DEBUG` (tunnel UP, IP serveur VLESS, compteur trafic).

### T-X4 — Négatifs + non-régression
Tests `canonical-config.test.ts` **9/9 PASS** :
- flow `xtls-rprx-vision` → refus « flow Vision non supporté par sing-box » ;
- JSON ni sing-box ni Xray → refus « JSON non reconnu : ni sing-box ni Xray » ;
- sing-box natif valide → import direct OK (`singbox-json`) ;
- URI vless, JSON SSH+Payload, conf WireGuard → inchangés ;
- réimport d'un canonique déjà traduit → `singbox-json`.

### T-X5 — Révocation / quota inchangés
Aucune modification des chemins quota/révocation (#42/#43 : `subscriptions.ts`, `provision.ts`, `VpnContext` quota local). Le profil converti passe par le même pipeline provision (hash canonique + configVersion + allowlist métadonnées). Les règles de quota/suppression restent fonctionnelles par construction.

## Validation technique
- Backend : `tsc --noEmit` OK ; `tsx --test server/tests/*.test.ts` → **35/35 PASS**.
- Mobile TS : `npm run typecheck` → 12 erreurs pré-existantes (inchangées, aucune dans les fichiers modifiés).
- Dashboard : `tsc --noEmit` sur les fichiers modifiés → 0 erreur.
- Build Android : workflow `build-android.yml` (déclenché sur PR) — voir run CI.
