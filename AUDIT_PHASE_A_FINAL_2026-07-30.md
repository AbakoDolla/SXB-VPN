# AUDIT PHASE A — RAPPORT FINAL HORODATÉ (lecture seule, masqué)

**Date/heure UTC** : 2026-07-30, runs d'audit `30520950596` → `30525643740` (07:44 → 08:12 UTC)
**Branche Arena** : `arena/019fb186-sxb-vpn` · **`origin/main` distant : `852551a` (inchangé)**
**Méthode** : audit 100 % lecture seule via workflow temporaire (aucun restart,
aucune migration, aucun write sur la production). Rapports bruts masqués :
`audit-runs/30525114934-20260730T080402Z/` et `audit-runs/30525643740-20260730T081150Z/`
(fichiers temporaires à purger avant merge).

---

## 1. VERDICT — CAUSE PRINCIPALE DU TIMEOUT SSH (APK #165), PROUVÉE

> **Le profil « Evans new » (`22f0af42`) lié à l'abonnement testé
> `83ea8954-…` déclare `protocol=ssh` (direct) avec `tls=true`, `sni=yamo.mtn.cm`,
> port 443, sans payload — alors que le serveur externe
> `node05.mikosi.fr.eu.org:443` n'émet JAMAIS de bannière SSH en clair.**
> Il accepte uniquement un **handshake WebSocket en clair** (prouvé : `HTTP/1.1
> 101 Switching Protocols`, `Sec-WebSocket-Accept` valide), **derrière lequel
> coule SSH** (prouvé : bannière `SSH-2.0-BugSleuth_0.1.9` lue dans les trames
> WS aucun credential utilisé).

Chaîne causale complète, chaque maillon prouvé :

| # | Maillon | Preuve |
|---|---|---|
| 1 | Dashboard : profil enregistré `ssh`+`tls=true`+`sni`+443, **aucune validation transport, aucune alerte** | DB (run 30525114934), `vpn-profiles.ts` (aucun test à la création) |
| 2 | Backend provisionne fidèlement les colonnes (jamais `jsonConfig`) → blob chiffré au device `SXB0Y1NVCBT52FK8RI` | `provision.ts` l.194-226 ; `lastProvisionAt = 2026-07-30 04:37:19` |
| 3 | Mobile : `usePayload=false` (protocole sans « payload ») → branche **SSH direct** ; `tls=true`/`sni` **lignorés** | logs APK #165 + `SxbVpnService.kt` l.447-457, 736-738, 787-798 |
| 4 | Socket TCP brute vers `node05…:443`, attente d'une bannière `SSH-` | `SxbLoggingSocketFactory` (TCP pur) |
| 5 | Le serveur attend d'abord HTTP/WS (ou TLS) → **n'envoie rien** → double attente | Sonde WS décisive (run 30525643740) |
| 6 | `session.connect(30_000)` expire → `SSH_TIMEOUT`, ×2 (auto-reconnexion, même config) | logs APK #165 + code `classifyVpnError` |

**Taxonomie mission §4.6 :**

1. **Configuration externe invalide → ✅ CAUSE PRINCIPALE** (combinaison transport impossible enregistrée et provisionnée)
2. Import/transformation dashboard incorrect → ✅ **cause** (pas de rejet à l'enregistrement ; `jsonConfig` ignoré + stocké clair)
3. Provisionnement backend incorrect → partiellement (fidèle aux colonnes — justement le problème : aucune config canonique importée n'existe)
4. Cache mobile obsolète → **facteur aggravant** (aucun `configVersion`/`configHash` ; fusion destructive prouvée)
5. Transport natif Android incorrect → ✅ **cause secondaire majeure** (TLS ignoré silencieusement en SSH direct ; `payload_len=4` = AOSP `optString(NULL)` → `"null"` ; messages d'erreur indifférenciés)
6. Serveur externe indisponible → ❌ **RÉFUTÉE** (il répond TLS 200/101 et sert SSH derrière WS)

## 2. Ce que le serveur externe exige réellement (sondes sans credentials)

| Test (2026-07-30 08:08-08:12 UTC, depuis le VPS) | Résultat |
|---|---|
| DNS `node05.mikosi.fr.eu.org` | `2a01:4f8:c0c:d51a::1` (+IPv4 via curl) |
| Bannière SSH brute :22 / :443 / :80 | **aucune** |
| TLS :443 (SNI quelconque) | **handshake OK**, cert LE `CN=node05.mikosi.fr.eu.org`, valide |
| HTTP clair :80 (Host yamo.mtn.cm) | **200** |
| HTTP clair :443 | **101** (endpoint WS en clair !) |
| WS TLS :443 (SNI/Host yamo) | 000 (échec requête après/au handshake) |
| **WS clair :443 (Host yamo) → puis lecture trames** | **101 valide → `SSH-2.0-BugSleuth_0.1.9`** ✅ |
| Ports 2082/8880/2095/2096 fermés ; 8080/8443 ouverts | — |

**Combinaison correcte** (cohérente avec les 6 profils `ssh+payload` existant en
DB sur ce même host : port 443, `tls=false`, payloads actifs) :
`protocol=ssh+payload`, `host=node05.mikosi.fr.eu.org`, `port=443`,
**`tls=false`**, payload WebSocket avec `Host: yamo.mtn.cm` (payload exact
fourni par le fournisseur mikosi). Les paramètres précis du payload relèvent du
fournisseur — le préflight §7 saura les **valider automatiquement** à l'import.

## 3. État réel du VPS `vps-d43561fe` (Ubuntu 24.04.4, à jour, sain)

| Domaine | Fait d'audit |
|---|---|
| Projet | `/var/www/sxb-vpn`, HEAD `e1e5a22` (PR #8), `origin/main` local **non refetché** depuis PR #8 — le backend prod tourne PR #8 ; `pnpm-lock.yaml` **modifié localement** (pour `node_modules`, attendu mais à documenter) |
| PM2 | `sxb-backend` online (11 h, 9 restarts), `dist/server.cjs`, port **4000 public** |
| SSH | OpenSSH 22 (public, bannière keyscan OK) · **Dropbear 444 (public, bannière `SSH-2.0-dropbear_2022.83` confirmée des deux côtés)** · sshd 2222/2223 (localhost, backend stunnel) · `sshd-ws` (X-Net) · `websockify 2082→444` (public) |
| Nginx 1.24 | 443 dashboard (`root /var/www/sxb-vpn/dist`) + `api.sxbvpn.com`/`api.sxbvpn.afrihall.com` → `localhost:4000` · **8443 → `127.0.0.1:18790`** · 8080 → 18790 |
| **XNet/XPanel** | **ARRÊTÉ — rien n'écoute sur 18790** → **cause du 502 prouvée** (`connect() failed (111: Connection refused)` dans `error.log`, récurrent) ; des clients externes frappent régulièrement `/kqUtkMEvgdtx/` (legacy XPanel) |
| Pare-feu | UFW actif, deny-in par défaut, 22/80/443/444/3000/4000/8080/8443/3001/9090… ouverts ; fail2ban actif |
| Monitoring | Grafana 3001 et Prometheus 9090 **exposés publiquement** (UFW ALLOW) — surface à filtrer |
| Absents | **7300 BadVPN UDPGW : rien n'écoute** (doc obsolète) ; port **51820** (profil `[AUDIT] SSH Standard EDITED`) : rien n'écoute → profil mort ; Xray inbound VLESS public : aucun |
| Base | PostgreSQL 16.14 locale ; **`_prisma_migrations` n'existe pas** (déploiements par `db push --accept-data-loss`) — historique de schéma non versionné |

## 4. Fait base de données (SELECT, colonnes sensibles exclues)

- **Abonnement cible** : actif jusqu'au 2026-08-29, device `SXB0Y1NVCBT52FK8RI`,
  profil « Evans new » (créé 2026-07-30 04:36, jamais modifié),
  `lastProvisionAt` 04:37 — **correspond exactement au test téléphone**.
- **Doublons de profils** : 6 groupes (`node05…:443 ssh ×4`, `ssh+payload ×6`,
  `141.95.112.93:443 ssh ×3`, `vpnsxb.afrihall.com:443 vless ×3`, …) — plusieurs
  configs « Teste » pointent `141.95.112.93:443` (nginx TLS) : **mêmes timeouts
  garantis** si provisionnées en SSH direct.
- `ssh_accounts` (mode « import » pour mikosi) et `vpn_profiles` coexistent sans
  lien : la double source mission §6.2 confirmée en production.
- `subscription_devices` et `app_registrations` : vides.
- 5 payloads SSH actifs (contenus non lus — seulement longueurs 78-414).

## 5. Sécurité — incidents trouvés pendant l'audit (actions utilisateur vues en cours)

| # | Incident | Gravité | Action |
|---|---|---|---|
| S1 | **PAT GitHub en clair dans `git remote -v` du VPS** (credentials dans l'URL) | Critique | Révocation demandée (utilisateur) + nettoyage remote URL en remédiation + filtre masque étendu (`7405b19` parents) |
| S2 | PAT également publié en conversation + dans l'issue #14 avant masquage | Critique | Révoquer + supprimer issues #14/#15 (utilisateur) |
| S3 | Grafana/Prometheus publics (3001/9090) | Moyenne | Restreindre UFW ou basic-auth — remédiation |
| S4 | Backend port 4000 public en plus de 443 via nginx | Moyenne | 4000 devrait rester localhost (nginx proxy) — remédiation |
| S5 | `sshpass -p` en ligne de commande dans `ssh.ts /test` (legacy) | Moyenne | Remplacé par le préflight §7 dans la refonte |

## 6. Preuves code déjà versées (rappel — suite rouge)

`scripts/tests/incident-repro.e2e.mjs` : **10 rouges / 3 contrôles verts** —
fusion destructive (`false`/null/`''` restaurés), infiltration de champs
techniques via sources non provisionnées, `payload:null`→"null" (AOSP),
`ssh+tls:true` accepté silencieusement, `jsonConfig` ignoré par la vraie route,
`configVersion`/`configHash` absents. Les 52 assertions historiques restent
vertes.

## 7. Conclusion et feu vert demandé

**L'incident téléphone est entièrement expliqué et prouvé.** Le produit doit
être refondu selon l'architecture imposée (intermédiaire d'import uniquement)
avec, au minimum : modèle canonical chiffré + hash/version, validation
transport à l'import (rejet `ssh+tls` direct sans implémentation), préflight
honnête (le préflight aurait détecté immédiatement que ce serveur exige WS),
fusion par allowlist côté mobile, `configVersion`/`configHash` (invalide le
cache), nettoyage `payload:null`, messages d'erreur différenciés, et test
tunnel réel avant toute publication.

*Rédigé par l'agent Arena — aucun secret, token, mot de passe, clé privée ni
contenu de payload ne figure dans ce document.*
