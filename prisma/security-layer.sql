-- Additive SXB security layer. Apply before the new backend; no automatic enrollment.
BEGIN;
ALTER TABLE vpn_clients ADD COLUMN IF NOT EXISTS "devicePublicKey" TEXT,
  ADD COLUMN IF NOT EXISTS "deviceKeyId" TEXT,
  ADD COLUMN IF NOT EXISTS "keyEnrolledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "enrollmentGrantHash" TEXT,
  ADD COLUMN IF NOT EXISTS "enrollmentGrantExpiresAt" TIMESTAMP(3);
ALTER TABLE activation_sessions ADD COLUMN IF NOT EXISTS "authGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "authIssuedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "authExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "authRevokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activationRequestId" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "refreshJti" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshIssuedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "previousRefreshJti" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshRetryUntil" TIMESTAMP(3);
CREATE TABLE IF NOT EXISTS mobile_proof_nonces (
  id TEXT PRIMARY KEY, "keyId" TEXT NOT NULL, nonce TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_proof_nonces_keyId_nonce_key" ON mobile_proof_nonces ("keyId", nonce);
CREATE INDEX IF NOT EXISTS "mobile_proof_nonces_expiresAt_idx" ON mobile_proof_nonces ("expiresAt");
CREATE TABLE IF NOT EXISTS mobile_connections (
  id TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "deviceId" TEXT NOT NULL,
  "authSessionId" TEXT NOT NULL, "authGeneration" INTEGER NOT NULL,
  "usageSessionId" TEXT NOT NULL, "subscriptionId" TEXT, "configId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedAt" TIMESTAMP(3), "closeReason" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_connections_clientId_usageSessionId_key" ON mobile_connections ("clientId", "usageSessionId");
ALTER TABLE mobile_connections ADD COLUMN IF NOT EXISTS "relayConfigHash" TEXT;
CREATE INDEX IF NOT EXISTS "mobile_connections_clientId_authSessionId_authGeneration_idx" ON mobile_connections ("clientId", "authSessionId", "authGeneration");
ALTER TABLE security_events ADD COLUMN IF NOT EXISTS "sessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "sessionGeneration" INTEGER,
  ADD COLUMN IF NOT EXISTS "connectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "eventKey" TEXT,
  ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "riskLevel" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "security_events_eventKey_key" ON security_events ("eventKey");
CREATE INDEX IF NOT EXISTS "security_events_sessionId_createdAt_idx" ON security_events ("sessionId", "createdAt");
CREATE TABLE IF NOT EXISTS root_device_approvals (
  "keyId" TEXT PRIMARY KEY, "publicKey" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  "clientId" TEXT REFERENCES vpn_clients(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "deviceModel" TEXT, "appVersion" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3), "decidedById" TEXT
);
CREATE INDEX IF NOT EXISTS "root_device_approvals_clientId_idx" ON root_device_approvals ("clientId");
CREATE INDEX IF NOT EXISTS "root_device_approvals_status_lastSeenAt_idx" ON root_device_approvals (status, "lastSeenAt");
COMMIT;
