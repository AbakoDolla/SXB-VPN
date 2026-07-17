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
  - Password : (stocké dans XPANEL_ADMIN_PASSWORD secret)

### GitHub
- Repo : https://github.com/AbakoDolla/SXB-VPN
- Token : stocké dans GITHUB_TOKEN secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
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

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
