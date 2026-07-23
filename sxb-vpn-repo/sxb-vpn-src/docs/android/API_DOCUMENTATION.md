# SXB VPN API Documentation

## Overview
Base URL: `https://vpnsxb.afrihall.com/api`

All endpoints require authentication via Bearer token (except auth endpoints).

## Authentication

### POST /auth/login
Login to the system.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "Login successful",
  "user": {
    "id": "uuid",
    "name": "User Name",
    "email": "user@example.com",
    "role": "CLIENT|RESELLER|ADMIN|SUPER_ADMIN",
    "permissions": ["clients.view", "clients.create", ...]
  },
  "accessToken": "jwt_token",
  "refreshToken": "refresh_token"
}
```

### POST /auth/register
Register a new user.

**Request:**
```json
{
  "name": "User Name",
  "email": "user@example.com",
  "password": "password123",
  "phone": "+22507XXXXXXXX"
}
```

### POST /auth/refresh
Refresh access token.

**Request:**
```json
{
  "refreshToken": "refresh_token"
}
```

### GET /auth/me
Get current user info.

## Dashboard

### GET /dashboard/stats
Get dashboard statistics.

**Response:**
```json
{
  "activeUsers": 42,
  "expiredAccounts": 5,
  "consumedTraffic": 125.5,
  "activeServers": 3,
  "activeResellers": 8,
  "totalRevenue": 0
}
```

### GET /dashboard/traffic
Get traffic data for charts.

**Response:**
```json
[
  { "time": "Lun", "download": 12.5, "upload": 3.2 },
  { "time": "Mar", "download": 15.0, "upload": 4.1 },
  ...
]
```

### GET /dashboard/users
Get user growth data.

**Response:**
```json
[
  { "time": "Mon", "count": 10 },
  { "time": "Tue", "count": 15 },
  ...
]
```

## Clients

### GET /clients
Get all VPN clients.

**Response:**
```json
{
  "clients": [
    {
      "id": "uuid",
      "userId": "uuid",
      "token": "sxb-usr-xxxx-xxxx",
      "quotaTotal": "10737418240",
      "quotaUsed": "0",
      "expireAt": "2026-08-14T08:56:14.922Z",
      "status": "active",
      "xpanelUserId": "uuid",
      "user": {
        "id": "uuid",
        "name": "Client Name",
        "email": "client@example.com"
      }
    }
  ]
}
```

### POST /clients
Create a new VPN client.

**Request:**
```json
{
  "name": "Client Name",
  "email": "client@example.com",
  "phone": "+22507XXXXXXXX"
}
```

**Response:** Returns the created client object.

### GET /clients/:id
Get client details.

### PUT /clients/:id
Update client (status, quota, expiration).

**Request:**
```json
{
  "status": "suspended",
  "quotaTotal": "10737418240",
  "expireAt": "2026-12-31T23:59:59.000Z"
}
```

### DELETE /clients/:id
Delete a client.

## Tokens (Plans/Packages)

Tokens define quota packages that can be assigned to clients.

### GET /tokens
Get all tokens.

**Response:**
```json
{
  "tokens": [
    {
      "id": "uuid",
      "token": "SXB-XXXX-XXXX-XXXX",
      "clientId": "uuid",
      "quota": "10737418240",
      "expiration": "2026-12-31T23:59:59.000Z",
      "status": "active",
      "deviceLimit": 1
    }
  ]
}
```

### POST /tokens
Create a new token (assign quota to client).

**Request:**
```json
{
  "clientId": "client_uuid",
  "quotaGb": 10,
  "durationDays": 30,
  "deviceLimit": 1
}
```

### POST /tokens/:id/revoke
Revoke a token.

### POST /tokens/validate
Validate and apply a token code.

**Request:**
```json
{
  "token": "SXB-XXXX-XXXX-XXXX"
}
```

## Vouchers

### GET /vouchers
Get all vouchers.

### POST /vouchers
Create vouchers.

**Request:**
```json
{
  "quotaGb": 10,
  "durationDays": 30,
  "count": 5
}
```

### POST /vouchers/redeem
Redeem a voucher code.

**Request:**
```json
{
  "code": "VCH-XXXXX-XXXXX"
}
```

## Servers

### GET /servers
Get all VPN servers.

**Response:**
```json
{
  "servers": [
    {
      "id": "uuid",
      "name": "Server 1",
      "host": "server1.example.com",
      "port": 443,
      "status": "online"
    }
  ]
}
```

### POST /servers
Create a new server.

### PUT /servers/:id
Update server.

### DELETE /servers/:id
Delete a server.

## Resellers

### GET /resellers
Get all resellers.

### POST /resellers
Create a reseller.

### PUT /resellers/:id
Update reseller.

### DELETE /resellers/:id
Delete reseller.

## X-Panel

### GET /xpanel/status
Get X-Panel connection status.

**Response:**
```json
{
  "status": "online|offline",
  "connectedServers": 2,
  "synchronizedUsers": 42,
  "availableConfigs": 4,
  "isSyncing": false
}
```

### POST /xpanel/sync
Trigger X-Panel synchronization.

### GET /xpanel/users
Get X-Panel users.

### GET /xpanel/configs
Get VPN configurations from X-Panel.

## Activity Logs

### GET /audit-logs
Get activity logs.

**Query params:**
- `limit` (default: 50)
- `offset` (default: 0)

## Response Format

All responses follow this format:
```json
{
  "success": true,
  "data": {...}
}
```

Or for errors:
```json
{
  "error": "error.code",
  "message": "Human readable message"
}
```

## Error Codes

| Code | Description |
|------|-------------|
| errors.auth.unauthorized | Unauthorized access |
| errors.auth.invalid_credentials | Invalid email or password |
| errors.validation | Validation error |
| errors.not_found | Resource not found |
| errors.server | Server error |
| errors.rate_limit | Too many requests |

## Authentication Flow

1. Login with email/password
2. Receive accessToken and refreshToken
3. Include accessToken in Authorization header: `Bearer <token>`
4. When token expires, use refreshToken to get new accessToken
