<<<<<<< HEAD
- [SXB VPN VPS setup](sxb-vpn-vps.md) — VPS 141.95.112.93, PM2 + esbuild rebuild procedure, admin password reset method
- [SXB VPN dashboard Replit](sxb-vpn-dashboard-replit.md) — dashboard source in sxb-vpn-src/, copied to artifacts/sxb-dashboard/, uses /xapi proxy to VPS
- [SXB VPN GitHub push auth](sxb-vpn-github.md) — git push requires PAT; HTTP auth fails without token in remote URL
=======
- [SXB VPN Dashboard Architecture](sxb-vpn-architecture.md) — deux PM2 (root + ubuntu) peuvent coexister et causer EADDRINUSE ; fix : tuer root PM2, passer à pm2-ubuntu.service systemd
- [SXB VPN Permission Fix](sxb-vpn-permissions.md) — dashboard.ts utilisait analytics.view au lieu de analytics.read, mais requirePermission bypass ADMIN/SUPER_ADMIN donc pas bloquant
- [SXB VPN API Null-Safety Pattern](sxb-vpn-api-null-safety.md) — toutes les fonctions fetchXxx() doivent utiliser try/catch + res?.accounts ?? [] pour éviter crash .map() sur undefined
>>>>>>> github/main
