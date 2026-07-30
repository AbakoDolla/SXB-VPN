# INSTRUCTIONS — Application manuelle du patch CI d'audit (lecture seule)

> **Contexte** : le token du bot Arena n'a **pas** la permission `workflows`
> (push refusé : *« refusing to allow a GitHub App to create or update workflow
> without `workflows` permission »*). Conformément à la mission, ce patch est
> fourni pour **application manuelle** par un membre disposant des droits.

## Ce que fait ce workflow (rien d'autre)

- Connexion SSH au VPS `141.95.112.93` (utilisateur `ubuntu`) avec le secret
  **existant** `VPS_SSH_PASSWORD` (le même que le workflow de déploiement utilise).
- Exécute **exclusivement des commandes de lecture** : `ss`, `ufw status`,
  `nft list ruleset`, `iptables-save`, `fail2ban-client status`,
  `systemctl status`, `journalctl` (2 dernières heures), `pm2 status/describe`,
  `docker ps`, `nginx -T`, `git status/log` (aucun fetch/pull/reset/checkout),
  `SELECT` SQL (aucunes colonnes `password`, `dataToken`, `jsonConfig` complet
  ni contenu de payload), sondes `curl`/`openssl`/`ssh-keyscan`/`ssh` banner.
- **Aucun** redémarrage, **aucune** migration, **aucun** `git reset`,
  **aucune** écriture, **aucun** redéploiement.
- Toutes les sorties passent par un filtre `sed` qui masque : DATABASE_URL,
  ENCRYPTION_KEY, PROVISION_SECRET, mots de passe, tokens `SXB-DATA-*`,
  blobs `gcm:*`, JWT.
- Le job `audit-vue-publique` teste depuis le runner GitHub ce que « voit »
  le téléphone : TLS 443, bannières SSH sur 22/444/443/8443 — utile pour
  corréler avec le timeout JSch observé sur l'appareil réel.

## Procédure d'application (2 minutes)

### Option A — Interface GitHub (sans terminal)

1. Ouvrir <https://github.com/AbakoDolla/SXB-VPN/tree/arena/019fb186-sxb-vpn/scripts/ci-patches>.
2. Copier le contenu de `vps-audit-ro.yml`.
3. Aller sur l'onglet **Actions → New workflow → set up a workflow yourself**,
   nommer le fichier `vps-audit-ro.yml`, coller le contenu **inchangé**,
   valider le commit **sur la branche** `arena/019fb186-sxb-vpn`.
4. Le push déclenche immédiatement le run (déclencheur `push` limité à la
   branche Arena + `workflow_dispatch` en secours).
5. L'agent Arena lira les logs via `gh run list` / `gh run view --log` et
   produira le rapport d'audit horodaté et masqué.

### Option B — Terminal (avec vos droits propriétaire)

```bash
git fetch origin
git checkout arena/019fb186-sxb-vpn
mkdir -p .github/workflows
cp scripts/ci-patches/vps-audit-ro.yml .github/workflows/vps-audit-ro.yml
git add .github/workflows/vps-audit-ro.yml
git commit -m "ci(audit): activation temporaire du workflow d'audit lecture seule"
git push origin arena/019fb186-sxb-vpn
```

## Après l'audit

Le fichier sera **supprimé** par le patch final (ou manuellement) avant la
fusion vers `main`. Aucune trace de workflow temporaire ne doit rester dans
le produit livré.

## Pourquoi ce détour est nécessaire (preuves de blocage)

| Vérification | Résultat |
|---|---|
| Sortie réseau du sandbox Arena | filtrée : seuls `.github.com/.githubusercontent.com` répondent ; TCP vers `141.95.112.93` établi puis **réinitialisé** sur tout port (22/443/444/8443) — sandbox sortant |
| `gh run download` / `--log` | redirection vers `results-receiver.actions.githubusercontent.com` **bloquée** par la même egress |
| Push de `.github/workflows/*` | **refusé** côté serveur (permission `workflows` absente du token) |
| Secret `VPS_SSH_PASSWORD` | existe côté repo (utilisé par `deploy-vps.yml`, run vert `30488286589`) — jamais lu ni affiché par l'agent |

> Rien de sensible n'est requis : le workflow consomme uniquement le secret
> déjà présent dans GitHub Actions.
