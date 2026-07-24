---
name: Prisma VPS Fix — generate hors pnpm workspace
description: Comment regenerer le Prisma client sur le VPS sans le bug "pnpm add prisma"
---

## Problème
`prisma generate` dans un projet pnpm workspace tente de lancer `pnpm add prisma@X.X.X -D --silent` 
et échoue si pnpm n'est pas disponible ou si le workspace root bloque l'install.

## Solution
Créer un répertoire temporaire HORS du workspace pnpm, y init un package.json vierge, 
installer prisma@X.X.X via npm (pas pnpm), puis lancer generate depuis ce répertoire.

```bash
mkdir -p /tmp/prisma-fix
cd /tmp/prisma-fix
cat > package.json << PKGJSON
{"name":"fix","version":"1.0.0","private":true}
PKGJSON
# Modifier schema.prisma pour ajouter: output = "/tmp/prisma-fix/client"
sed 's|generator client {|generator client {\n  output = "/tmp/prisma-fix/client"|' \
  /var/www/sxb-vpn/prisma/schema.prisma > /tmp/prisma-fix/schema.prisma
npm install --save-dev prisma@5.22.0 --legacy-peer-deps --silent
node_modules/.bin/prisma generate --schema /tmp/prisma-fix/schema.prisma
# Copier TOUT (y compris runtime/) vers la destination
cp -r /tmp/prisma-fix/client/* /dest/node_modules/.prisma/client/
```

**IMPORTANT**: Toujours copier le dossier `runtime/` aussi — sans lui, le client crashe avec
`Cannot find module './runtime/library.js'`.

**Why:** Le hook postinstall de Prisma détecte l'environnement pnpm et tente d'auto-update,
ce qui échoue en CI/CD ou sur des VPS sans pnpm global. L'approche /tmp évite ce hook.
