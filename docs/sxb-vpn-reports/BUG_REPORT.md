# SXB VPN — Bug Report
**Date:** 2026-07-17  
**Session:** Full system audit & repair  
**Status:** ✅ All Critical Bugs Fixed

---

## Critical Bugs (Fixed)

### BUG-001 — Mobile App Crash on Launch
- **Severity:** Critical
- **Component:** `artifacts/sxb-mobile/`
- **Symptom:** App shows "Something went wrong. Please reload the app to continue." on first launch
- **Root Cause:** `require("@/assets/images/icon.png")` using TypeScript `@/` alias in Metro `require()` calls — not supported for binary assets
- **Files:** `app/index.tsx`, `app/(tabs)/index.tsx`, `app/activate.tsx`, `app/onboarding.tsx`
- **Fix:** Changed to relative `require("../assets/images/icon.png")` paths
- **Status:** ✅ Fixed & pushed (commit `a7604c1`)

### BUG-002 — Notifications Always Empty
- **Severity:** High
- **Component:** VPS backend `server/routes/mobile.ts`
- **Symptom:** Notifications tab shows empty state, API returns 404
- **Root Cause:** `GET /api/mobile/notifications` route missing from backend
- **Fix:** Implemented route with smart notifications (expired, low quota, no package, active states) + audit log integration
- **Status:** ✅ Fixed, built, deployed on VPS

### BUG-003 — History Always Empty
- **Severity:** High
- **Component:** VPS backend `server/routes/mobile.ts`
- **Symptom:** History tab shows fallback local data only
- **Root Cause:** `GET /api/mobile/history` route missing from backend
- **Fix:** Implemented route querying `audit_logs` table + account summary
- **Status:** ✅ Fixed, built, deployed on VPS

### BUG-004 — XPanelService Runtime TypeError (silent)
- **Severity:** Medium
- **Component:** VPS `server/services/xpanel/index.ts`
- **Symptom:** VPN config endpoint fails silently, fallback protocols used
- **Root Cause:** `XPanelService.getSubscriptionLink()` and `XPanelService.getInbounds()` called but not defined
- **Fix:** Added both methods to XPanelServiceClass
- **Status:** ✅ Fixed, deployed on VPS

### BUG-005 — Backend Not Tracked in GitHub
- **Severity:** Medium
- **Component:** Repository / DevOps
- **Symptom:** GitHub repo 63+ commits behind VPS production, no source control for backend
- **Root Cause:** VPS backend was developed directly on server without git push
- **Fix:** Downloaded complete VPS backend source to `backend/` directory in GitHub repo, committed and pushed
- **Status:** ✅ Fixed (commit `a7604c1`)

---

## Non-Critical Issues (Fixed)

### BUG-006 — Replit API Server Nearly Empty
- **Severity:** Low
- **Component:** `artifacts/api-server/`
- **Symptom:** Only `/healthz` endpoint existed
- **Fix:** Implemented complete API server matching VPS backend: auth, mobile, xpanel, dashboard, clients, users, admin-tokens, analytics routes
- **Status:** ✅ Fixed

---

## Known Limitations (Not Bugs)

| Item | Notes |
|------|-------|
| Replit API server uses in-memory storage | No PostgreSQL in dev environment — VPS uses real Prisma+PostgreSQL |
| Mobile push notifications | Not implemented (no FCM/APNs integration) |
| VPN tunnel | Managed natively on-device, backend only provides config + session audit |
