---
name: SXB VPN Dashboard Architecture
description: Architecture de production, nginx, PM2, chemins critiques et pièges
---

## Architecture de production

- **Frontend** : React + Vite, servi par nginx depuis `/var/www/sxb-vpn/artifacts/sxb-dashboard/dist/public/`
- **Backend** : `node dist/server.cjs` (esbuild bundle de `server.ts` racine), port 4000
- **Proxy** : nginx `/xapi` → rewrite `/api` → localhost:4000
- **Domaine** : `vpnsxb.afrihall.com` (HTTPS, certificat Let's Encrypt)

## PM2 — piège critique

Il existait DEUX instances PM2 :
- `/root/.pm2` (PM2 root) — gérait l'ancien process backend
- `/home/ubuntu/.pm2` (PM2 ubuntu) — instance nouvelle, correcte

**Conflit** : le PM2 root gardait port 4000 occupé, causant `EADDRINUSE` pour le PM2 ubuntu.

**Fix** :
1. `sudo pm2 stop all && sudo pm2 delete all && sudo pm2 kill` (tuer root PM2)
2. `pm2 start ecosystem.config.cjs` (ubuntu PM2)
3. Corriger le systemd service : ajouter `ExecStartPre=pm2 kill` pour éviter le conflit au redémarrage
4. `sudo systemctl enable pm2-ubuntu && sudo systemctl start pm2-ubuntu`

## Chemins de build

- Frontend : `cd artifacts/sxb-dashboard && PORT=3000 BASE_PATH=/ NODE_ENV=production ../../node_modules/.bin/vite build --config vite.config.ts`
- Backend : `node_modules/.bin/esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs`

## DB

- PostgreSQL, tables snake_case (`vpn_clients`, `roles`, `permissions`, etc.)
- Connexion : `PGPASSWORD='sxb_secure_db_pass_2026' psql -h localhost -U postgres -d sxb_vpn`
- Credentials superadmin : `superadmin@sxbvpn.com / SuperAdmin2026!`

**Why:** Les deux PM2 coexistaient parce que le premier déploiement utilisait `sudo pm2` (root) et les suivants `pm2` (ubuntu). Sans `ExecStartPre=pm2 kill`, le PM2 root revenait à chaque démarrage systemd.

**How to apply:** Avant tout déploiement, vérifier `sudo pm2 list` ET `pm2 list` séparément. Si les deux ont des entrées, consolider vers ubuntu PM2.
