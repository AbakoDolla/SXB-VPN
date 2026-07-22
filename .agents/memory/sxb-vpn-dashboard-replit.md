---
name: SXB VPN Dashboard (Replit workspace)
description: How the SXB VPN dashboard is set up in the Replit workspace and how it connects to the VPS backend
---

# SXB VPN Dashboard — Workspace Replit

## Artifact
- Artifact ID: `artifacts/sxb-dashboard` (kind: web, preview path: /)
- Workflow: `artifacts/sxb-dashboard: web`
- Port: 20925

## Source
- Code source SXB: `sxb-vpn-src/artifacts/sxb-dashboard/src/` (repo cloné)
- Copié vers: `artifacts/sxb-dashboard/src/` (127 fichiers)

## Connexion au backend VPS
- API base URL: `/xapi` (défini dans `src/api/client.ts`)
- Proxy Vite: `/xapi` → `https://vpnsxb.afrihall.com/api` (dans `vite.config.ts`)
- **Why `/xapi` et pas `/api`**: l'artifact api-server Replit intercepte `/api/*` en priorité dans le workspace

## Packages clés
- `motion: ^12.42.2` ajouté manuellement (sxb-dashboard l'utilise, absent du scaffold initial)
- Utilise sa propre couche API (`src/api/`) — pas les hooks générés `@workspace/api-client-react`

## CSS/Thème
- Dark theme custom (pas les variables shadcn "red" du scaffold)
- Source: `sxb-vpn-src/artifacts/sxb-dashboard/src/index.css` (copié)
- Fonts: Inter + JetBrains Mono (Google Fonts)
