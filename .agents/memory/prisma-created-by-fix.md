---
name: Prisma createdBy Fix
description: Erreur P2022 vpn_profiles.createdBy — cause et solution après ALTER TABLE manuel
---

## Symptôme
```
PrismaClientKnownRequestError: The column `vpn_profiles.createdBy` does not exist in the current database.
code: 'P2022'
```

## Cause
La colonne `createdBy` (et autres colonnes) ont été ajoutées via `ALTER TABLE ... ADD COLUMN` directement en SQL, sans migration Prisma. Le client Prisma généré ne connaît pas la nouvelle colonne jusqu'à `prisma generate`.

## Solution
```bash
cd /var/www/sxb-vpn
sudo npx prisma generate
# Rebuild
sudo ./node_modules/.bin/esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs
sudo pm2 restart sxb-backend
```

## Important
- PM2 ne vide PAS les logs d'erreur au restart → les anciennes erreurs restent dans le fichier
- Vérifier que les nouvelles erreurs sont bien absentes en testant l'endpoint et comparant les timestamps
- Après le fix: subscription creation WORKS, `createdBy` est retourné dans la réponse

**Why:** toute modification manuelle de DB doit être suivie de `prisma generate` + rebuild + restart pour que le client Prisma soit en phase avec le vrai schéma.
**How to apply:** chaque fois qu'on modifie la DB via SQL direct sur le VPS (ALTER TABLE, etc.) sans passer par une migration Prisma.
