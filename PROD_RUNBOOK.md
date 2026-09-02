# Runbook de production SXB VPN

Ce document couvre l’API et le dashboard SXB VPN. XPanel/XNet doit faire
l’objet d’une maintenance séparée.

## Déploiement normal

1. Ouvrir une pull request et attendre la réussite du workflow `CI`.
2. Vérifier que les changements Prisma sont additifs ou non destructifs.
3. Fusionner dans `main`.
4. Surveiller `Deploy to VPS` dans GitHub Actions.
5. Confirmer les trois contrôles :

```bash
curl --fail https://vpnsxb.afrihall.com/
curl --fail https://vpnsxb.afrihall.com/api/health
```

Le workflow de déploiement ne réutilise pas le `node_modules` du processus en
cours. Il construit sous `/var/www/sxb-vpn/releases/<sha>`, puis bascule le lien
`current` et redémarre PM2 seulement quand la release est prête.

Lors de l’adoption initiale de Prisma Migrate, le workflow compare la base
existante au schéma de référence avant d’enregistrer la migration de base. La
moindre dérive arrête le déploiement avant la bascule. Elle doit alors être
analysée et réconciliée manuellement, jamais contournée avec une option de perte
de données.

## Sauvegardes

Chaque déploiement exécute automatiquement :

```bash
SXB_APP_DIR=/var/www/sxb-vpn scripts/prod/backup-sxb.sh
```

Les sauvegardes sont privées dans `~/sxb-backups/<horodatage>` et comprennent :

- un dump PostgreSQL vérifié ;
- des compteurs de contrôle ;
- l’environnement protégé en mode `0600` ;
- Redis lorsque disponible ;
- les artefacts actuellement servis ;
- les uploads ;
- le commit, le diff et les fichiers Git non suivis ;
- un manifeste SHA-256 et un script de restauration interactif.

Vérification manuelle :

```bash
cd "$(readlink -f ~/sxb-backups/latest)"
sha256sum --check manifest.sha256
pg_restore --list db.dump >/dev/null
```

## Échec d’un déploiement

Ne pas relancer à l’aveugle.

1. Lire l’étape en échec dans GitHub Actions.
2. Vérifier que l’ancienne API répond encore.
3. Vérifier PM2 :

```bash
cd /var/www/sxb-vpn
pm2 describe sxb-backend
pm2 logs sxb-backend --lines 100
readlink -f current
cat .last-deployed-sha 2>/dev/null
```

Le workflow remet automatiquement le lien `current` et les artefacts dashboard
précédents lorsqu’une vérification post-bascule échoue.

## Restauration de la base

Une restauration de base est une opération destructive. Ne l’effectuer que si
la base a réellement été altérée et après avoir créé une nouvelle sauvegarde de
l’état courant.

```bash
cd "$(readlink -f ~/sxb-backups/latest)"
sha256sum --check manifest.sha256
./restore-db.sh
```

Comparer ensuite les fichiers `*.count`, redémarrer PM2 et vérifier les URL de
santé.

## Changements locaux sur le VPS

Le déploiement sauvegarde les changements locaux. Il s’arrête si un fichier
suivi a été modifié, afin de ne pas écraser un correctif de production non
réconcilié. Examiner `git-status.txt`, `tracked-changes.patch` et
`untracked-files.tar.gz` dans la dernière sauvegarde, puis intégrer ou retirer
le changement manuellement avant de relancer.

## XPanel/XNet

Un `502` sur le port public XPanel ne doit pas entraîner de modification de
l’API SXB VPN. Diagnostiquer séparément :

```bash
sudo systemctl status xnet --no-pager
sudo journalctl -u xnet -n 100 --no-pager
curl --max-time 5 http://127.0.0.1:18790/
sudo nginx -t
```

Avant tout redémarrage, identifier le nom réel de l’unité, sauvegarder sa base
et sa configuration, puis prévoir la commande inverse.

## Rotation des accès

Après toute divulgation, révoquer et remplacer immédiatement :

- les jetons GitHub ;
- les mots de passe SSH au profit d’une clé ;
- les mots de passe administrateurs ;
- les secrets JWT et de chiffrement selon une procédure compatible avec les
  sessions et données chiffrées existantes.

Ne jamais inscrire les nouvelles valeurs dans le dépôt ou dans les logs.
