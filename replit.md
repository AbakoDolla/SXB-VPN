<<<<<<< HEAD
# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
=======
# SXB VPN — Plateforme de gestion VPN

Application SaaS VPN complète avec dashboard d'administration, app mobile Expo et connexion au backend déployé sur https://vpnsxb.afrihall.com.

## Run & Operate

- `pnpm --filter @workspace/sxb-dashboard run dev` — Dashboard admin (port auto)
- `pnpm --filter @workspace/sxb-mobile run dev` — App mobile Expo (port auto)
- `pnpm --filter @workspace/api-server run dev` — API server local (port 8080)
- `pnpm run typecheck` — typecheck complet
- `pnpm run build` — typecheck + build tous les packages

## URLs & Credentials

### Production (Vercel / VPS)
- **Dashboard Admin** : https://vpnsxb.afrihall.com
- **API Backend** : https://vpnsxb.afrihall.com/api
- **X-Panel (IP)** : http://141.95.112.93:8080/kqUtkMEvgdtx/
- **X-Panel (Domaine)** : https://xpanel.vpnsxb.afrihall.com/kqUtkMEvgdtx/
  - Username : `admin`
  - Password : voir secret `XPANEL_ADMIN_PASSWORD`

### GitHub
- Repo : https://github.com/AbakoDolla/SXB-VPN
- Token : stocké dans GITHUB_TOKEN secret
>>>>>>> github/main

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
<<<<<<< HEAD
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._
=======
- **Dashboard** : React 19 + Vite + Tailwind CSS v4 + Recharts + Motion
- **Mobile** : Expo SDK 54 + Expo Router + React Native 0.81
- **Backend** : Express + Prisma + PostgreSQL (production sur VPS)
- **API** : Proxy Vite → https://vpnsxb.afrihall.com/api (développement)

## Where things live

- `artifacts/sxb-dashboard/src/` — Code source du dashboard (copié du repo GitHub)
- `artifacts/sxb-mobile/` — App mobile Expo (copiée du repo GitHub)
- `artifacts/api-server/` — API server Replit (non utilisé en prod, remplacé par VPS)
- `artifacts/sxb-dashboard/src/api/` — Clients HTTP vers le backend de production
- `artifacts/sxb-mobile/services/apiClient.ts` — Client Axios mobile (prod API)
- `artifacts/sxb-mobile/contexts/` — AuthContext, VpnContext, ThemeContext, LanguageContext

## Architecture decisions

- Le dashboard proxifie `/api/*` vers `https://vpnsxb.afrihall.com` en développement (vite.config.ts)
- L'app mobile utilise directement `https://vpnsxb.afrihall.com/api` comme base URL
- Zéro données mockées — tout passe par l'API de production
- EXPO_TOKEN est neutralisé (`EXPO_TOKEN=`) dans le script dev pour éviter les erreurs d'auth Expo
- Les secrets sensibles (GitHub, X-Panel, JWT) sont stockés en Replit Secrets

## Permissions App Mobile

- **Android** : INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, CAMERA, FOREGROUND_SERVICE
- **iOS** : NSAppTransportSecurity (AllowsArbitraryLoads), Camera, Location, Photos

## User preferences

- Aucune donnée mockée nulle part dans le projet
- L'app doit demander les permissions nécessaires à l'utilisateur
- Dashboard, X-Panel et app mobile doivent fonctionner en temps réel avec l'API de production

## Gotchas

- EXPO_TOKEN invalide → neutraliser avec `EXPO_TOKEN=` en tête du script dev
- Le vite proxy dashboard ne fonctionne qu'en développement ; en prod Vercel gère le routing
- X-Panel tourne sur le VPS (141.95.112.93:8080), pas déployé sur Vercel
- Le backend utilise Prisma + PostgreSQL sur le VPS, pas la DB Replit
>>>>>>> github/main

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
