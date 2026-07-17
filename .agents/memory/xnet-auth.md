---
name: XNet API authentication and endpoints
description: How XNet (the XPanel binary at /opt/xnet/xnet-server) authenticates and which API endpoints are real
---

## XNet Auth Model

XNet does NOT use a static Bearer token from env. It uses session login:

```bash
# Login → get JWT (24h expiry)
POST http://localhost:18790/api/auth/login
Body: {"username": "<XPANEL_ADMIN_USERNAME>", "password": "<XPANEL_ADMIN_PASSWORD>"}
Response: {"token": "<JWT>", "username": "admin", "role": "Super Admin"}

# Use token for subsequent calls
GET http://localhost:18790/api/system/info
Header: Authorization: Bearer <JWT>
```

**Why:** `XPANEL_JWT_SECRET` in .env is NOT the API token — it's the signing secret for XNet's JWT generation. Sending it as Bearer token returns `{"error":"Invalid or expired token"}`. The correct flow is login with username/password.

**How to apply:** The backend `XPanelServiceClass` authenticates on first request, caches the JWT for 23h, auto-renews on 401. Never use static token.

---

## Confirmed Working Endpoints

| Endpoint | Auth Required | Notes |
|----------|--------------|-------|
| POST /api/auth/login | No | Returns JWT token |
| GET /api/v1/ping | No | Health check → `{"status":"ok"}` |
| GET /api/system/info | Bearer JWT | CPU/RAM/disk/sing-box status |
| GET /api/inbounds | Bearer JWT | VPN inbound configs (empty by default) |
| GET /api/outbounds | Bearer JWT | VPN outbound configs |
| GET /api/nodes | Bearer JWT | Returns server nodes with IP |
| POST /api/auth/verify-totp | No | 2FA (if enabled) |
| GET /api/v1/live/metrics | WebSocket | Real-time metrics |

## Endpoints That Return 404

- /api/users → `{"error":"not found"}` (not the right path for XNet user management)
- /api/servers → `{"error":"not found"}`
- /api/settings → `{"error":"not found"}`

---

## XNet Panel Access

- Internal: http://localhost:18790
- Via nginx port 8080: http://VPS_IP:8080/kqUtkMEvgdtx/
- Via nginx port 8443 (SSL): https://vpnsxb.afrihall.com:8443/kqUtkMEvgdtx/

## XNet Binary Location

- Binary: /opt/xnet/xnet-server
- Frontend: /opt/xnet/dist/ (React SPA, Persian language)
- DB: /opt/xnet/data/xnet.db (SQLite)
- Service: xnet.service (systemd)
- Version: 1.0.0 / sing-box 1.13.13
