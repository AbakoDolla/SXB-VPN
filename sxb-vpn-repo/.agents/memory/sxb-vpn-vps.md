---
name: SXB VPN VPS setup
description: Critical operational facts about the VPS backend (141.95.112.93) — rebuild procedure, password reset, esbuild path, known bugs fixed
---

# SXB VPN VPS — Procédures critiques

## Accès
- Host: `141.95.112.93` (ubuntu / stuffNation321)
- Backend: PM2 process `sxb-backend`, script `/var/www/sxb-vpn/dist/server.cjs`
- Port: 4000 (direct), proxied via Nginx → `https://vpnsxb.afrihall.com`

## Rebuild backend
```bash
cd /var/www/sxb-vpn
ESBUILD=/var/www/sxb-vpn/artifacts/api-server/node_modules/.bin/esbuild
sudo $ESBUILD server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs
sudo fuser -k 4000/tcp 2>/dev/null || true; sleep 2
sudo pm2 restart sxb-backend
```

**Why:** `npm run build` fails (pnpm workspace TTY issue). Standard `node_modules/.bin/esbuild` doesn't exist; correct path is in `artifacts/api-server/node_modules/.bin/esbuild`.

## Reset admin password
```bash
cd /var/www/sxb-vpn
HASH=$(node -e "const b = require('./node_modules/.pnpm/bcryptjs@3.0.3/node_modules/bcryptjs'); b.hash('NEW_PASSWORD', 10).then(h => process.stdout.write(h));")
sudo -u postgres psql sxb_vpn -c "UPDATE users SET \"passwordHash\" = '$HASH' WHERE email = 'superadmin@sxbvpn.com';"
```
**Why:** The bcryptjs module is under pnpm flat path, not at ./node_modules/bcryptjs directly.

## EADDRINUSE issue
PM2 crash-loops with EADDRINUSE when restarted too fast. Always `fuser -k 4000/tcp` before restart.

## Bugs corrigés (Jul 2026)
- `analytics.ts`: route `/overview` manquante sur VPS (version divergée) → copiée depuis local
- `analytics.ts`: `voucher.count({where:{status:"used"}})` → `{where:{isRedeemed:true}}`
- `mobile.ts`: `findClientByAccountToken` utilisait `findMany+filter` → `findUnique({where:{token}})`
- Admin password: hash bcryptjs incompatible → regénéré directement sur VPS

## Admin credentials (ne pas hardcoder)
- Email: `superadmin@sxbvpn.com`
- Current pw: `SXBAdmin2026!` (resetté Jul 22 2026 — X majuscule)
- DATABASE_URL: `postgresql://postgres:sxb_secure_db_pass_2026@localhost:5432/sxb_vpn`
