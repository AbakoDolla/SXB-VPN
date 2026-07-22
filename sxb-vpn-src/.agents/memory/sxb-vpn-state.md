---
name: SXB VPN — état du projet et décisions clés
description: Historique des corrections, décisions d'architecture et points d'attention pour les futures sessions
---

## Correction BUG 500 (création forfait data)

**Causes identifiées :**
1. Client Prisma obsolète — `createdBy` ajouté à `Subscription` dans schema.prisma SANS relancer `prisma generate`
2. `vpn_profiles.createdBy` absent de la DB (table manquante, schema à jour)
3. `subscriptions.deviceId` en DB mais absent du schéma Prisma

**Fixes appliqués :**
- VPS : `ALTER TABLE vpn_profiles ADD COLUMN IF NOT EXISTS "createdBy" TEXT`
- schema.prisma : `deviceId String?` ajouté dans `Subscription`
- VPS : `npx prisma generate` + esbuild rebuild + pm2 restart

**Why:** Toujours relancer `prisma generate` après toute modification de schema.prisma, sinon le client généré dans node_modules est désynchronisé.

## Gestion de processus VPS

**Architecture actuelle (stable) :**
- Root PM2 gère `sxb-backend` (PID variable, user: root)
- Root PM2 gère `sxb-dashboard` (PID 972315 au 20/07, user: root)
- Ubuntu PM2 était en conflit — nettoyé
- `pm2 startup systemd` configuré (root) — survie au reboot

**Commandes à utiliser :**
```bash
sudo pm2 list              # voir les processus
sudo pm2 restart sxb-backend
sudo pm2 logs sxb-backend --err --lines 50
sudo /root/.pm2/logs/sxb-backend-error-0.log  # logs d'erreur réels
```

## Credentials admin (changés)

- Email : `superadmin@sxbvpn.com`
- Password : `SxBAdmin2026!` (reset direct en DB le 20/07/2026)
- **Note :** mot de passe original inconnu — a été remplacé

## Build VPS

**Commande exacte de rebuild :**
```bash
cd /var/www/sxb-vpn
sudo npm run build   # vite build frontend → dist/
sudo ./node_modules/.bin/esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs
sudo pm2 restart sxb-backend
```

**Config de build dans `/var/www/sxb-vpn/package.json` (backend):**
```json
"build": "vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs"
```

## Dashboard — sections conservées

Nav réorganisée en 3 groupes après nettoyage :
- **Principal** : Dashboard, Clients VPN, Forfaits Data, Tokens SXB, Appareils
- **Protocoles VPN** : Configurations VPN, Gestionnaire Proto., SSH, Xray/V2Ray, Sing-box
- **Administration** : Utilisateurs, Rôles & Permissions, Logs & Activité, Paramètres

Sections supprimées : Vouchers, Support, Revendeurs, Serveurs, Payload (doublon SSH)

## Mobile app — points clés

- `VpnContext.tsx` : config VPN chiffrée XOR+btoa dans `@sxb_vpn_cfg_v2` (migre auto depuis @sxb_vpn_config)
- `settings.tsx` : PIN fonctionnel, langue FR/EN, kill switch, device ID, logs VPN, purge données
- `Buffer` non disponible sans polyfill en RN → utiliser `btoa`/`atob` (RN 0.71+)
- Module natif `SxbVpnNative` = SSH uniquement via JSch (Java), tunnel SOCKS5 local

## Synchronisation DB ↔ Prisma schema

**Colonnes ajoutées manuellement en DB (hors migration Prisma) :**
- `vpn_profiles.createdBy TEXT`
- `ssh_accounts.createdBy TEXT`
- `subscriptions.deviceId TEXT` (déjà présente)

**Why:** Ce projet utilise `prisma db push` (pas de migrations). Toute colonne ajoutée au schéma doit être appliquée manuellement en DB via ALTER TABLE, OU via `prisma db push` relancé.
