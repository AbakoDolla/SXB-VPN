---
name: SXB VPN Project Setup
description: Key decisions and quirks for the SXB VPN monorepo (dashboard + mobile + backend)
---

## Context
Source code lives at https://github.com/AbakoDolla/SXB-VPN. Files were cloned and copied into Replit artifacts.

## URLs
- Dashboard (prod): https://vpnsxb.afrihall.com
- API (prod): https://vpnsxb.afrihall.com/api
- X-Panel (IP): http://141.95.112.93:8080/kqUtkMEvgdtx/
- X-Panel (domain): https://xpanel.vpnsxb.afrihall.com/kqUtkMEvgdtx/

## Key decisions

### Dashboard API Proxy
The dashboard's `vite.config.ts` has a proxy block forwarding `/api` → `https://vpnsxb.afrihall.com`. The source code in `src/api/client.ts` uses relative fetch URLs (`/api/...`). Do NOT change this to absolute URLs.

**Why:** The deployed version at vpnsxb.afrihall.com serves both frontend and backend from the same origin. In development (Replit), the proxy bridges them.

### EXPO_TOKEN neutralization
The dev script in `artifacts/sxb-mobile/package.json` starts with `EXPO_TOKEN=` (empty assignment).

**Why:** The user provided an invalid Expo key (not an actual Expo access token). Without neutralizing it, Expo CLI throws `ApiV2Error: The bearer token is invalid.` and refuses to start.

**How to apply:** Any time the mobile workflow fails with `ApiV2Error` or bearer token errors, check that `EXPO_TOKEN=` is still present at the start of the dev script.

### No mocked data
All API calls in both dashboard and mobile go to the production API. The `src/api/db.ts` file in the dashboard is a stub (kept for backward compatibility but returns empty arrays). Real data flows from `src/api/*.ts` files via the production API.

### Secrets stored
- GITHUB_TOKEN: GitHub PAT for the repo
- XPANEL_ADMIN_PASSWORD: X-Panel admin password
- JWT_SECRET: Backend JWT secret key
- (EXPO_TOKEN was saved but is invalid — neutralized in dev script)

### Mobile font loading
The mobile app uses local font files (`assets/fonts/Inter_*.ttf`) loaded via `useFonts()` with `require()`. NOT using `@expo-google-fonts/inter` package imports. The `_layout.tsx` uses relative paths `../assets/fonts/` (not `@/assets/fonts/`) because the `@/` alias doesn't work with `require()` for binary assets.
