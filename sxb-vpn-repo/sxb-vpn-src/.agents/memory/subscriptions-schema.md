---
name: Subscriptions Table Schema
description: Vraies colonnes de la table subscriptions (différentes des hypothèses initiales)
---

## Colonnes réelles (PostgreSQL `\d subscriptions`)
- id, name, clientId, profileId
- dataToken (unique, NOT NULL)
- quotaBytes (bigint, NOT NULL) — pas quotaTotal ou quotaGB
- quotaUsed (bigint, default 0)
- durationDays (integer, NOT NULL) — pas expireAfterDays
- deviceLimit (integer, default 1)
- startAt, expireAt, createdAt, updatedAt (NOT NULL)
- status (text, default 'active')
- deviceId, lastProvisionAt, createdBy, revokedAt, lastSyncAt, revokeReason

## INSERT correct
```sql
INSERT INTO subscriptions (id, name, "clientId", "profileId", "dataToken",
  "quotaBytes", "quotaUsed", "durationDays",
  "deviceLimit", "startAt", "expireAt", status, "createdAt", "updatedAt")
VALUES (..., NOW(), NOW());
-- updatedAt est NOT NULL sans default → toujours fournir
```

## VPN Clients Table
- id, token, status, quotaTotal, quotaUsed (bigint), expireAt, deviceId, deviceLimit, activatedAt

**Why:** éviter les erreurs INSERT avec de faux noms de colonnes (quotaTotal vs quotaBytes, etc.)
