---
name: VPS git repo divergence from GitHub main
description: The VPS /var/www/sxb-vpn/ is a completely separate git history from the Replit workspace / GitHub main branch
---

## The Problem

The GitHub repo `AbakoDolla/SXB-VPN` has TWO completely different codebases in its history:

1. **GitHub `main` branch** = Replit workspace (pnpm monorepo: `artifacts/sxb-dashboard`, `artifacts/sxb-mobile`, `artifacts/api-server`)
2. **VPS `/var/www/sxb-vpn/` local git** = Express backend with its own 63+ commits, completely different file layout

They diverged at some point and cannot be fast-forward merged.

## Solution Applied

Push VPS backend changes to a dedicated branch:

```bash
cd /var/www/sxb-vpn
git checkout -b vps-backend
git push -u origin vps-backend
```

**Why:** This preserves both histories without force-pushing and lets the VPS-specific code be reviewed as a PR if needed.

## Structure

| Location | Git Repo | Branch | Content |
|----------|----------|--------|---------|
| /home/runner/workspace | GitHub main | main | pnpm monorepo (Replit) |
| /var/www/sxb-vpn | GitHub vps-backend | vps-backend | Express backend |
| /var/www/sxb-vpn/dist | N/A | — | Built SPA + server |

## VPS Backend Entry Points

- `server.ts` → compiled to `dist/server.cjs` via `npm run build`
- PM2 runs: `dist/server.cjs`
- `.env` at `/var/www/sxb-vpn/.env` (must NOT be committed)
- Build command: `npm run build` (Vite + esbuild)
- PM2 save: `pm2 save` after any config change
