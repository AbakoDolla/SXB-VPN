# AUDIT PHASE A — État et preuves (session Arena `arena/019fb186-sxb-vpn`)

**Horodatage** : 2026-07-30 ~06:00 UTC (07:00 Africa/Douala)
**Branche** : `arena/019fb186-sxb-vpn` (base : `852551a` = `origin/main` vérifié)
**Statut** : audit live VPS **bloqué** (voir §2) — patch CI prêt à appliquer (voir §3).
Toutes les valeurs sensibles sont masquées. Aucun secret n'est stocké dans Git.

---

## 1. Vérifications préalables (✅ conformes à l'ordre de travail)

| Étape | Résultat | Preuve |
|---|---|---|
| `gh auth status` | ✅ `arena-ai-coding-agent[bot]` (GH_TOKEN) | sortie CLI |
| Branche Arena imposée | ✅ `arena/019fb186-sxb-vpn` | `git branch --show-current` |
| `git fetch origin` | ✅ | — |
| `origin/main` toujours courant | ✅ `852551a316224e88f7573250c1ef3641d5269307` (commit de fin de session précédente, PR #13) | `git rev-parse origin/main` |
| Suites historiques | ✅ **17 + 17 + 18 = 52 assertions vertes** | `provision-e2e.test.mjs`, `provision-route.e2e.mjs` (nécessite `cd backend && npm install --legacy-peer-deps`), `device-sim.e2e.mjs` (nécessite `cd app-mobile && npm ci --legacy-peer-deps`) |

## 2. Blocage de l'audit live depuis le sandbox Arena (prouvé, reproductible)

La sortie réseau du sandbox Arena est **filtrée** : seuls les domaines GitHub
(`github.com`, `api.github.com`) répondent. Tout le reste est réinitialisé
après le handshake TCP.

| Test (2026-07-30 ~05:55 UTC) | Résultat |
|---|---|
| `curl https://github.com` | **200** |
| `curl https://example.com`, `https://www.google.com` | **000** (échec) |
| TLS `1.1.1.1:443` | `unexpected eof` après ClientHello (332 octets écrits, 0 lu) |
| TCP `141.95.112.93` ports 22/443/444/8443/8000 | handshake OK, puis **reset dès premier octet envoyé** |
| Bannière SSH `141.95.112.93:22/444` (depuis sandbox) | connexion ouverte puis fermée **sans bannière** (même filtrage) |
| `ssh ubuntu@141.95.112.93` | `kex_exchange_identification: Connection reset by peer` |
| `gh run download 30488286589` (logs anciens runs) | redirection `results-receiver.actions.githubusercontent.com` **bloquée** (EOF) |
| Push `.github/workflows/*.yml` | **refusé serveur** : `without workflows permission` |

> Le comportement est identique pour des destinations sans rapport avec SXB
> (Google, Cloudflare) : il s'agit du **filtre de sortie du sandbox**, pas d'un
> blocage fail2ban du VPS (qui n'aurait aucune raison de bannir Google).

**Conséquence** : ni SSH direct, ni relais via workflow CI (n'ayant pas la
permission `workflows`), ni lecture des logs d'anciens runs ne sont possibles
depuis ce sandbox. L'audit live doit passer par **vous** (§3) — c'est le seul
point de blocage.

### Sondes publiques déjà réalisées (via l'outil de fetch plateforme, hors sandbox)

| Sonde | Résultat | Interprétation |
|---|---|---|
| `https://vpnsxb.afrihall.com/api/health` | `{"status":"ok","timestamp":"2026-07-30T05:54:06.049Z","service":"sxb-vpn-backend"}` | Backend SXB **UP** en production |
| `https://vpnsxb.afrihall.com:8443/api/v1/ping` | **502 Bad Gateway** `nginx/1.24.0 (Ubuntu)` | Upstream XNet/XPanel (127.0.0.1:18790) arrêté ou inaccessible — **cause du 502 à déterminer précisément par l'audit interne** (processus absent ? mauvais upstream ? port 18790 non écouté ?) |
| `https://vpnsxb.afrihall.com/` | dashboard servi | Nginx 443 opérationnel |

## 3. Livrable de déblocage : patch CI prêt à appliquer

Mission §1 : *« Ne pas modifier `.github/workflows/*` si le token Arena n'a pas
la permission workflows. Dans ce cas, générer un patch sous `scripts/ci-patches/`
pour application manuelle. »* → **c'est fait** :

- `scripts/ci-patches/vps-audit-ro.yml` — workflow d'audit **strictement lecture
  seule** (aucun restart, aucune migration, aucun `git reset`, aucun write ;
  filtres de rédaction `sed` sur toutes les sorties ; `SELECT` SQL sans colonnes
  `password`/`dataToken`/`jsonConfig`/contenu payload).
  Il couvre intégralement les points 4.1 → 4.5 de la mission + sondes publiques
  depuis le runner GitHub (bannières SSH 22/444/443/8443 vues « comme le
  téléphone les voit »).
- `scripts/ci-patches/INSTRUCTIONS_AUDIT.md` — procédure (2 min, interface
  GitHub ou terminal) et justification du détour.

Le workflow se déclenche au push sur la branche Arena (ni `build-android.yml`
ni `deploy-vps.yml` ne réagissent : leurs déclencheurs sont limités à `main`).
Il sera **supprimé avant fusion** vers `main`.

> Alternative si vous préférez ne pas toucher aux workflows : exécuter vous-
> même le corps du `script:` depuis votre machine (SSH ubuntu@141.95.112.93)
> et me coller la sortie — le filtre de rédaction y est déjà intégré.

## 4. Preuves déjà établies **par le code** (indépendantes du VPS)

### 4.1 Incident téléphone (APK #165) — mécanisme exact

| Observation téléphone | Preuve code (`app-mobile/modules/android-native/SxbVpnService.kt`) |
|---|---|
| `usePayload=false` → « Mode SSH direct » | `startSshTunnel()` l.736 : `usePayload = cfg.optBoolean("usePayload", false) \|\| protocol.contains("payload")` ; branche `else` l.787+ |
| `tls=true` **ignoré** en SSH direct | `tlsEnabled` l.738 n'est utilisé que dans `SxbPayloadProxy` (l.228, 253, 772). En SSH direct : `SxbLoggingSocketFactory` l.447-457 ouvre un `Socket()` **TCP brut** sans TLS |
| `payload_len=4` alors que payload absent | l.746 `cfg.optString("payload", "")` : avec `"payload": null` dans le JSON, `org.json` retourne la chaîne **`"null"`** (4 car.) — défaut de parsing confirmé ; non envoyé car `usePayload=false`, mais **serait** envoyé tel quel en mode payload (bug réel) |
| `SSH_HANDSHAKE_START` puis `SSH_TIMEOUT` à 30 s | `session.connect(30_000)` l.805 attend la bannière `SSH-` du serveur ; `classifyVpnError` l.997-1012 ne distingue pas « bannière absente » / « TCP timeout » / « TLS » — message d'erreur insuffisant (mission 6.4) |
| 2 tentatives identiques (auto-reconnexion) | `failVpn` → `autoReconnect.onDisconnected()` → relance avec la **même** config → même échec (logique, pas un hasard) |

**Mécanisme du timeout (cohérent avec toutes les observations)** : le moteur
attend une bannière `SSH-2.0-…` en **clair** sur `host:443`. Sur le port 443
d'un serveur TLS/HTTPS (ou d'un proxy HTTP), **aucune bannière SSH n'arrive
jamais** → read-timeout 30 s → `SSH_TIMEOUT`. Ni l'authentification, ni le
SOCKS5, ni libbox/TUN ne sont atteints. **Ce n'est pas (encore) un problème de
credentials.**

Cause racine **candidat n°1** (à confirmer par audit live) : la combinaison
`{ protocol: ssh, port: 443, tls: true }` est **incohérente pour le moteur** —
le bouton TLS du dashboard n'a aucun effet en SSH direct (mission 6.4 :
« Ne pas laisser un bouton TLS que le moteur ignore »). Reste à prouver
*quelle* configuration le profil DB porte exactement (§4.4 mission) : c'est le
**premier résultat attendu du patch d'audit**.

### 4.2 `jsonConfig` mensonger (mission 6.1) — **prouvée E2E par le code**

- UI : `src/components/VpnProfilesView.tsx` (aide du champ) —
  *« Si renseigné, cette config JSON sera utilisée à la place des champs
  individuels lors du provisionnement. »*
- Backend : `server/routes/provision.ts` l.194-226 construit `rawConfig`
  **uniquement** depuis les colonnes (`protocol`, `host`, `port`, `tls`,
  `sni`, `network`, `payload`…) — `grep jsonConfig server/` ne trouve que le
  CRUD (`vpn-profiles.ts` l.154/179/202/227), **jamais** `provision.ts` ni
  `mobile.ts`.
- Stockage : `vpn-profiles.ts` l.179 écrit `jsonConfig` **en clair**
  (contrairement à `password` qui passe par `encrypt()`) — violation du
  critère « pas de credentials en clair ».
- **Verdict** : affirmation UI fausse + config importée ignorée + stockage
  clair. Test rouge à écrire (mission étape 8).

### 4.3 Fusion destructive mobile (mission 6.4) — **prouvée**

`app-mobile/services/configValidator.ts` → `mergeConfigs()` :
1. Boucle principale : `value !== undefined && value !== null && value !== ''`
   → `null`/**chaîne vide** de suppression jamais appliqués.
2. Bloc « préservation » (fin de fonction) : `if (!merged.tls && oldCfg.tls)
   merged.tls = oldCfg.tls;` — un `tls:false` **explicite** est falsy →
   l'ancien `tls:true` **le restaure**. Idem `host/port/protocol/username/
   password/uuid/payload/sni/path/flow/method/privateKey/endpoint`.

Contextes d'appel dangereux : `VpnContext.tsx`
- l.235 : cache provisionné existant fusionné avec métadonnées (`protocol`,
  `displayProtocol`, `configId`, `dataToken`) ;
- l.512 : **`mergeConfigs(oldConfig, data.vpnConfig)`** — `vpnConfig` vient de
  `/mobile/vpn/config` (ne contient plus que `configId/protocol/displayProtocol`
  — déjà dé-credentialisé ✅) **mais** la préservation maintient l'ancienne
  config technique même si le profil a changé côté dashboard : **aucun
  `configVersion`/`configHash` n'existe** pour invalider ce cache →
  re-provisionnement uniquement si cache absent/incomplet.

### 4.4 Sources concurrentes (mission 6.2) — inventaire prouvé

| Source | Route(s) | Modèle | Devenir mobile ? |
|---|---|---|---|
| SSH Manager (`SSHManagerView`) | `server/routes/ssh.ts` | `SshAccount` | ❌ non relié aux abonnements |
| Profils VPN (`VpnProfilesView`) | `vpn-profiles.ts` | `VpnProfile` | ✅ via `Subscription.profileId` |
| Payload Manager | `payload.ts` | `SshPayload` | via `VpnProfile.payloadId` |
| Protocol Manager | vue `ProtocolManagerView` | — | UI legacy |
| XPanel/XNet | `xpanel.ts` (status/sync/users/configs) | XNet externe (`127.0.0.1:18790`, **actuellement 502**) | ❌ séparé |
| Xray/Sing-box Managers | `xray.ts`, `singbox.ts` | `XrayAccount`, `SingboxAccount` | ❌ séparés |

⚠️ Dette supplémentaire trouvée au passage : `ssh.ts` l.219-224 exécute
`sshpass -p …` via `execSync` (mot de passe en ligne de commande, interpolation
shell) — à remplacer par le préflight propre de la mission §7.

## 5. Verdict intermédiaire (taxonomie de la mission §4.6)

| # | Hypothèse | État de preuve |
|---|---|---|
| 2 | Import/transformation dashboard incorrect (jsonConfig ignoré, stocké clair) | **✅ prouvée par le code** |
| 5 | Transport natif Android incorrect (TLS ignoré en SSH direct ; `"null"` ; messages d'erreur) | **✅ prouvée par le code** |
| 4 | Cache mobile obsolète (fusion destructive, pas de hash/version) | **✅ prouvée par le code** |
| 3 | Provisionnement backend incorrect (colonnes plutôt qu'import) | **✅ prouvée par le code** |
| 1 | Configuration externe invalide (profil qu'a reçu le téléphone : proto=ssh/443/tls=true) | ⏳ **nécessite audit live DB** (requête masquée prête dans le patch) |
| 6 | Serveur externe indisponible / inattingnable | ⏳ **nécessite audit live** (sondes prêtes depuis VPS + runner) |

## 6. Prochaines actions dès déblocage

1. Application du patch CI → run audit (2 jobs) → rapport horodaté complet.
2. Requête DB masquée sur `subscriptionId=83ea8954-…` + inventaire profils.
3. Sondes transport sur le **host:port externe exact** (bannière, TLS, HTTP).
4. Corrélation timestamps téléphone ↔ logs VPS (si nouvelle tentative).
5. Verdict final → tests rouges → refonte (modèle canonique chiffré,
   `configVersion`/`configHash`, allowlist de fusion, préflight §7, natif).

---

*Rédigé automatiquement par l'agent Arena — aucun secret, token, mot de passe
ni clé privée n'apparaît dans ce document.*
