# 🚀 RUNBOOK PRODUCTION — Déploiement de la refonte (PR #16)

> Ordre impératif de la mission §10. **Ne rien sauter.** Durée totale estimée : 20–30 min.
> Le déploiement lui-même est **automatique** dès le merge (workflow `deploy-vps`),
> tout comme le build APK (`build-android`). Votre rôle : sauvegarde, merger,
> surveiller, tester sur téléphone, remédiation.

---

## ÉTAPE 0 — Répartition (qui fait quoi)

| Action | Qui |
|---|---|
| Sauvegarde DB + version git | **Vous** (SSH sur le VPS) |
| Merger la PR #16 | **Vous** (bouton GitHub) ou **l'agent** sur votre « GO » explicite |
| Build + migration Prisma + redémarrage | **Automatique** (workflow `deploy-vps`) |
| Build APK + Release `apk-<n>` | **Automatique** (workflow `build-android`) |
| Surveillance des runs + vérif HTTP publique | **Les deux** (l'agent peut lire les statuts) |
| Réimport du profil incident + test téléphone réel | **Vous** |
| Remédiation VPS (remote git, UFW, XNet) | **Vous** (script interactif fourni) |
| Fermeture de l'issue `[AUDIT] #15` | **Vous** (droits repo) |

---

## ÉTAPE 1 — Sauvegarde vérifiable (AVANT le merge) 🔒

```bash
ssh ubuntu@141.95.112.93
# (le script est dans le repo après merge ; avant cela, copiez-le depuis la branche)
bash /var/www/sxb-vpn/scripts/prod/backup-sxb.sh
```
Vérifiez la dernière ligne : `🟢 SAUVEGARDE COMPLÈTE ET VÉRIFIÉE`.
Sans cette ligne verte, **ne pas continuer**.

> Alternative immédiate (avant merge) — les commandes essentielles :
> ```bash
> mkdir -p ~/sxb-backups/$(date -u +%Y%m%dT%H%M%SZ) && cd $_
> git -C /var/www/sxb-vpn rev-parse HEAD > git-head.txt
> set -a; source /var/www/sxb-vpn/.env; set +a
> URL="${DATABASE_URL%%\?*}"   # retire ?schema=public (paramètre Prisma, inconnu de libpq)
> pg_dump "$URL" -Fc -Z9 -f db.dump && pg_restore -l db.dump | grep -c " TABLE "
> ```
> ⚠️ `pg_dump "$DATABASE_URL"` **sans nettoyage échoue** : Prisma suffixe l'URI de
> `?schema=public`, que libpq ne connaît pas (`invalid URI query parameter: "schema"`).

## ÉTAPE 2 — Merger la PR #16 🔀

- Par vous : https://github.com/AbakoDolla/SXB-VPN/pull/16 → **Merge pull request**
  (recommandé : *Create a merge commit*, pas de squash — l'historique thématique compte).
- Ou dites à l'agent « GO merge » (il exécutera `gh pr merge 16`).

## ÉTAPE 3 — Surveiller les deux workflows 👀

Dans **GitHub → Actions** :
1. `🚀 Deploy to VPS` — déclenché automatiquement (paths `server/`, `backend/`, `prisma/`…).
   Déroulé : pull → build dashboard → build backend → **`prisma db push`** (colonnes
   **additives uniquement** : `canonicalConfig`, `canonicalConfigHash`, `configVersion`,
   `sourceFormat`, `importedAt`, `validatedAt`, `validationStatus`, `validationMessage`)
   → `pm2 restart` → reload nginx → **validation HTTP publique** (frontend 200 + API up).
   ✅ Attendu : run verte complète. La migration ne supprime aucune donnée
   (vérifié contre le schéma : aucun champ retiré).
2. `Build Android APK` — déclenché aussi (paths `app-mobile/**`).
   ✅ Résultat : artefact `sxb-vpn-android-apk-<n>` + Release GitHub `apk-<n>`.

 ⚠️ Si `deploy-vps` échoue : NE PAS relancer à l'aveugle — lire le log du run,
 restaurer au besoin (`pg_restore` avec le dump de l'étape 1) et remonter le log à l'agent.

## ÉTAPE 4 — Vérifications rapides post-déploiement ✅

```bash
# Depuis n'importe quelle machine
curl -s -o /dev/null -w "%{http_code}\n" https://vpnsxb.afrihall.com/
# Dashboard → Profils VPN : les badges « Importé v… / Legacy » doivent apparaître.
# Aucune donnée perdue : les anciens profils fonctionnent toujours (mode legacy).
```

## ÉTAPE 5 — Réparer le profil de l'incident 📱 (le moment de vérité)

Dans le **dashboard → Profils VPN → Importer une configuration** :
```json
{
  "protocol": "ssh+payload",
  "host": "node05.mikosi.fr.eu.org",
  "port": 443,
  "username": "<identifiant fournisseur>",
  "password": "<mot de passe fournisseur>",
  "tls": false,
  "sni": "yamo.mtn.cm",
  "payload": "GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]"
}
```
1. Cliquez **« Tester la configuration importée »** → attendu : `transport_ok` 🟢
   (la sonde vérifiera DNS → TCP → bannière `SSH-2.0-BugSleuth` via le tunnel WebSocket).
2. Importez → le profil devient **canonique v1** (champs techniques 🔒 verrouillés).
3. Liez-le à l'abonnement du téléphone de test (ou réattribuez l'abonnement `83ea8954…`).
4. Sur le téléphone : le cache détecte le `configHash` différent → **re-provisionnement
   automatique** → connexion. Le SSH_TIMEOUT ne peut plus se produire :
   la config provisionnée est **identique** à celle du fournisseur (prouvé §8.1).

> L'ancien profil « ssh + tls=true:443 » serait désormais **rejeté (422)** à l'import —
> c'est précisément la combinaison qui causait l'incident (SSH-over-WS → TLS inapplicable).

## ÉTAPE 6 — Remédiation VPS (après validation du VPN) 🛡️

```bash
ssh ubuntu@141.95.112.93 'bash -s' < scripts/prod/remediation-vps.sh
# ou interactivement sur place : bash /var/www/sxb-vpn/scripts/prod/remediation-vps.sh
```
Contenu : nettoyage remote git (PAT historique), fermeture UFW 3001/9090/4000,
note `pnpm-lock.yaml`, décision XNet (502 sur :8443). Interactif, rien de forcé.

## ÉTAPE 7 — Clôture 🏁

- Fermer l'issue **`[AUDIT] #15`** (rapports déjà archivés dans `AUDIT_PHASE_A_*.md`).
- Nouveau test téléphone réel = la preuve finale de la mission.
- Signer dans `RAPPORT_MISSION_SXB_FIX.md` la ligne « validation appareil physique OK ».

---

### Rollback (si quelque chose tourne mal) ⏪
```bash
cd /var/www/sxb-vpn
git reset --hard <git-head.txt de l'étape 1>
bash ~/sxb-backups/<TS>/restore.sh        # restaure la DB (nettoyage ?schema=… inclus)
pm2 restart ecosystem.config.cjs --update-env
```
