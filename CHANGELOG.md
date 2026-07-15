# Changelog — SXB VPN Platform

All notable changes to this project are documented in this file.  
Format: [Semantic Versioning](https://semver.org/). Dates are UTC.

---

## [2.1.0] — 2026-07-15

### 🔒 Security Fixes
- **Removed client-side token generation** (`generateTokenCode()` deleted from `src/api/tokens.ts`). Tokens are now exclusively server-generated via cryptographic randomness.
- **Hardened JWT defaults** — seed enforces strong passwords; production `.env` must override `JWT_SECRET` and `REFRESH_SECRET`.
- **passwordHash never exposed** in API responses (sanitizeUser/sanitizeVpnClient helpers verify this throughout).

### ✨ New Features
- **AdminToken system** (`SXB-ADMIN-XXXX-XXXX`): new Prisma model + backend routes (`/api/admin-tokens/generate`, `/api/admin-tokens/activate`). Allows admins to create time-limited login tokens for new accounts without sharing passwords.
- **Gestion des Comptes** (`AccountsView`) — new dashboard section for ADMIN/SUPER_ADMIN:
  - List all dashboard users with role badges
  - Create accounts with auto-generated passwords
  - One-click admin token generation per user
  - Revoke active tokens
  - Full responsive layout
- **SUPER_ADMIN role** properly seeded in the database (was missing from `prisma/seed.ts`).

### 🐛 Bug Fixes
- **`tokens.manage` permission missing from seed** — all token API calls returned 403. Fixed: permission now seeded and assigned to ADMIN, RESELLER, SUPER_ADMIN roles.
- **TokensView type mismatch** — component used `tok.owner`/`tok.code` which don't exist in `TokenSXB` type. Fixed to use `tok.token`, `tok.clientId`, client lookup.
- **TokensView create form** — was calling `createToken({ owner, quota, expiration })`. Fixed to use correct API shape `{ clientId, quotaGb, durationDays, deviceLimit }`.
- **TokensView create** now shows a client selector dropdown populated from real `/api/clients`.
- **Foreign key constraint on user creation** — caused by roles table being empty (seed not run on VPS). Fixed via full seed overhaul.
- **PM2 crash loop** (`Cannot find module dist/server.cjs`) — resolved by building project on VPS.
- **XPanel URL inconsistency** — three different values across `.env.example`, `docker-compose.yml`, and VPS `.env`. Standardized to env var `XPANEL_URL`, default `http://localhost:18790`.

### 🏗️ Schema Changes
- Added `AdminToken` model to `prisma/schema.prisma` with fields: `id`, `token`, `userId`, `expiresAt`, `usedAt`, `status`, `createdAt`.
- `AdminToken` linked to `User` with cascade delete.

### 🧹 Code Quality
- Resolved router conflict: `server/routes/users.ts` vs `server/routes/users/index.ts`. Server.ts resolves to `users.ts` (middleware-based). Both coexist — `users/index.ts` (RBAC-based) is available for future migration.
- `src/components/Layout.tsx` — added "Gestion des Comptes" navigation item (ADMIN/SUPER_ADMIN only).
- `src/App.tsx` — added `accounts` route case.
- `src/api/tokens.ts` — removed legacy `generateTokenCode()`, simplified `createToken()` parameters.
- `src/api/accounts.ts` — new module for account/admin-token management.

### 📦 Backend Routes Added
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/admin-tokens/generate` | Generate `SXB-ADMIN-XXXX-XXXX` token for a user |
| POST | `/api/admin-tokens/activate` | First-login via admin token, returns JWT |
| GET  | `/api/admin-tokens` | List admin tokens (ADMIN+) |
| POST | `/api/admin-tokens/:id/revoke` | Revoke a token |

### 🌱 Seed Changes
| Account | Password | Role |
|---------|----------|------|
| superadmin@sxbvpn.com | SuperAdmin2026! | SUPER_ADMIN |
| admin@sxbvpn.com | Admin2026! | ADMIN |
| support@sxbvpn.com | Support2026! | SUPPORT |

---

## [2.0.0] — 2026-07-14

### Features (prior work)
- Full RBAC system: roles, permissions, role_permissions tables
- Multi-role dashboard (ADMIN, SUPPORT, RESELLER)
- VPN client management with XPanel integration
- Token SXB system (data tokens for mobile)
- Voucher management
- Reseller management
- Mobile API: account activation, VPN config
- Expo React Native app with token-based activation
- GitHub Actions APK build workflow

---

## [1.0.0] — 2026-07-13

### Initial Release
- Express + TypeScript backend
- React + Vite + Tailwind dashboard
- Prisma ORM + PostgreSQL
- Redis caching
- Docker Compose infrastructure
