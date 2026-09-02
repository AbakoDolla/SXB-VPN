# SXB VPN

SXB VPN est une plateforme de gestion d’accès VPN composée d’un dashboard web,
d’une API, d’une application mobile et d’intégrations avec des serveurs VPN.

## Architecture

| Composant | Emplacement | Technologie |
|---|---|---|
| API | `server.ts`, `server/` | Node.js, Express, TypeScript |
| Dashboard | `artifacts/sxb-dashboard/` | React, Vite, Tailwind CSS |
| Mobile | `app-mobile/` | React Native, Expo |
| Modèle de données | `prisma/schema.prisma` | PostgreSQL, Prisma |
| Déploiement | `.github/workflows/deploy-vps.yml` | GitHub Actions, PM2, Nginx |

PostgreSQL est utilisé directement par l’API. Redis est présent sur le VPS mais
le code applicatif actuel ne l’utilise pas.

Production :

- dashboard et API : <https://vpnsxb.afrihall.com>
- santé API : <https://vpnsxb.afrihall.com/api/health>

## Prérequis

- Node.js 20
- Corepack et pnpm 11.25.0
- PostgreSQL

## Installation locale

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm exec prisma generate --schema=prisma/schema.prisma
pnpm exec prisma migrate deploy --schema=prisma/schema.prisma
pnpm exec prisma db seed
pnpm run dev
```

Renseignez dans `.env` des valeurs uniques pour `JWT_SECRET`,
`REFRESH_SECRET` et `ENCRYPTION_KEY`. En production, l’API refuse de démarrer si
ces secrets sont absents ou invalides.

Le seed crée les rôles et permissions, jamais de compte avec un mot de passe
par défaut. Pour créer ou réinitialiser explicitement le super administrateur :

```bash
SUPER_ADMIN_EMAIL='admin@example.com' \
SUPER_ADMIN_PASSWORD='mot-de-passe-long-et-unique' \
node scripts/setup-super-admin.js
```

## Commandes

```bash
pnpm run typecheck       # API, dashboard et mobile
pnpm run test            # tests API et régressions mobiles
pnpm run build           # dashboard et bundle API
pnpm run test:backend    # tests API uniquement
pnpm run build:backend   # bundle API uniquement
```

## Déploiement

Le push sur `main` déclenche d’abord la CI puis le workflow de production
protégé. Le workflow :

1. valide les tests, types, builds et le schéma Prisma ;
2. vérifie le VPS sans le modifier ;
3. crée et vérifie une sauvegarde PostgreSQL, Redis, artefacts et état Git ;
4. construit une release isolée avec le lockfile pnpm ;
5. refuse les changements Prisma destructifs ;
6. bascule PM2 sur la release versionnée ;
7. vérifie l’API locale et les URL publiques ;
8. restaure automatiquement la release précédente si une vérification échoue.

Les procédures d’exploitation et de restauration sont dans
[`PROD_RUNBOOK.md`](PROD_RUNBOOK.md).

## Sécurité

- JWT d’accès et de rafraîchissement séparés ;
- mots de passe hachés avec bcrypt ;
- contrôle d’accès RBAC ;
- chiffrement applicatif des données sensibles ;
- limitation de débit et en-têtes Helmet ;
- audit applicatif ;
- secrets de déploiement dans l’environnement GitHub `production` ;
- authentification SSH par clé et empreinte hôte stricte.

Aucun identifiant de connexion ne doit être stocké dans Git, un rapport ou une
commande partagée.
