---
name: SXB VPN Architecture
description: Architecture complète du projet SXB VPN — URLs, identifiants admin, structure VPS
---

## Production URLs
- Dashboard: https://vpnsxb.afrihall.com (React app, served via Nginx)
- Backend API: https://vpnsxb.afrihall.com/api (Express + Prisma + PostgreSQL)
- XPanel: https://xpanel.vpnsxb.afrihall.com

## VPS
- IP: 141.95.112.93, user: ubuntu, port: 22
- Backend path: /var/www/sxb-vpn
- PM2 processes: sxb-backend (id 2), sxb-dashboard (id 1)
- dist file: /var/www/sxb-vpn/dist/server.cjs (built with esbuild --packages=external)
- Rebuild command: `sudo ./node_modules/.bin/esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs`
- Restart: `sudo pm2 restart sxb-backend`

## Identifiants admin
- Email: superadmin@sxbvpn.com / Password: SxBAdmin2026!
- Rôle: SUPER_ADMIN (toutes les permissions)

## GitHub
- Repo: https://github.com/AbakoDolla/SXB-VPN
- Branche: main
- Secret requis: VPS_SSH_PASSWORD=stuffNation321 (à ajouter dans GitHub Settings → Secrets)

## Structure mobile
- Dossier: app-mobile/
- Module natif: app-mobile/modules/android-native/ (SxbVpnModule.kt, SxbVpnService.kt)
- Expo module: app-mobile/modules/expo-sxb-vpn/src/
- Context: app-mobile/contexts/VpnContext.tsx
- Localisation: app-mobile/localization/fr.ts + en.ts

## sing-box
- VPS: /usr/local/bin/sing-box v1.13.13 (déjà opérationnel)
- APK build: binaires arm64/arm téléchargés depuis GitHub Releases dans GitHub Actions
- Protocoles: VLESS, VMess, Trojan, Shadowsocks, WireGuard, Hysteria2, TUIC

**Why:** centraliser les points d'entrée pour éviter les confusions entre dev (Replit) et prod (VPS).
