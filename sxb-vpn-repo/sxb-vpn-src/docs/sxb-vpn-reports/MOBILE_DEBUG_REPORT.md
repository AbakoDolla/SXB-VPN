# SXB VPN — Mobile Debug Report
**Date:** 2026-07-17  
**Status:** ✅ Fixes Applied & Pushed

---

## 🐛 Bug #1 — App Crash "Something went wrong" (ErrorBoundary triggered)

### Root Cause
All screens using `require("@/assets/images/icon.png")` failed because the `@/` TypeScript path alias is **not resolved by Metro bundler** when used inside `require()` calls for binary assets.

Metro bundler resolves `@/` via the Babel module resolver for ES imports, but `require()` calls for static assets (`.png`, `.ttf`, `.jpg`) must use **relative paths**.

### Affected Files
| File | Old | Fixed |
|------|-----|-------|
| `app/(tabs)/index.tsx` | `require("@/assets/images/icon.png")` | `require("../../assets/images/icon.png")` |
| `app/activate.tsx` | `require("@/assets/images/icon.png")` | `require("../assets/images/icon.png")` |
| `app/index.tsx` | `require("@/assets/images/icon.png")` | `require("../assets/images/icon.png")` |
| `app/onboarding.tsx` | `require("@/assets/images/icon.png")` | `require("../assets/images/icon.png")` |

### Evidence
- `_layout.tsx` already uses `require("../assets/fonts/Inter_*.ttf")` (relative) — this is the correct pattern
- The `metro.config.js` has no custom module resolver, only `getDefaultConfig(__dirname)`
- The error was caught by the `ErrorBoundary` wrapping the entire app in `_layout.tsx`

### Fix Applied
Changed all `require("@/assets/images/icon.png")` to use correct relative paths.  
Committed and pushed: `a7604c1`

---

## 🐛 Bug #2 — Notifications Screen Always Empty

### Root Cause
`GET /api/mobile/notifications` route was **completely missing** from the VPS backend (`server/routes/mobile.ts`). The mobile app caught the 404 silently and showed empty state.

### Fix Applied
Added `GET /api/mobile/notifications` to VPS backend:
- Returns smart notifications based on account state
- Handles states: `expired`, `low quota (<1GB)`, `no_package`, `ready`, `suspended`
- Queries `AuditLog` table for VPN session history notifications
- Deployed and verified on VPS: confirmed in PM2 logs

---

## 🐛 Bug #3 — History Screen Always Empty

### Root Cause
`GET /api/mobile/history` route was **completely missing** from the VPS backend. The mobile app fell back to `buildLocalHistory(accountState)` which returned derived data only.

### Fix Applied
Added `GET /api/mobile/history` to VPS backend:
- Queries `AuditLog` table ordered by `timestamp DESC` (last 100 entries)
- Prepends account summary entry (quota, state)
- Deployed and verified on VPS

---

## 🐛 Bug #4 — XPanelService Missing Methods

### Root Cause
`server/routes/mobile.ts` called `XPanelService.getSubscriptionLink()` and `XPanelService.getInbounds()` which **did not exist** in `server/services/xpanel/index.ts`, causing runtime TypeErrors (caught in try-catch, silently ignored).

### Fix Applied
Added to XPanel service:
```typescript
async getInbounds(): Promise<any[]>  // GET /api/inbounds
async getSubscriptionLink(userId: string): Promise<string | null>  // GET /api/users/{id}/subscription
```

---

## ✅ Verification

```
GET /api/health → {"status":"ok","timestamp":"...","service":"sxb-vpn-backend"}
GET /api/mobile/notifications (invalid token) → 401 (route exists, auth required)
GET /api/mobile/history (invalid token) → 401 (route exists, auth required)
PM2 logs confirm all routes being hit
```

---

## 📋 Commit History
- `a7604c1` — fix(mobile): fix require() asset paths + feat(backend): add VPS backend source + notifications/history routes
