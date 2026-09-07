-- migrations_manual.sql — SXB VPN
-- Apply these manually on the production DB when needed.
-- Each block is idempotent (uses IF NOT EXISTS / DO $$ checks).

-- ── Phase 2 : ajout jsonConfig sur vpn_profiles ───────────────────────────────
-- Adds an optional raw JSON config field for V2Ray/VMess/VLESS/Trojan/WireGuard/Sing-box.
-- The field is optional; existing rows keep NULL (no action required).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vpn_profiles' AND column_name = 'json_config'
  ) THEN
    ALTER TABLE vpn_profiles ADD COLUMN json_config TEXT;
    RAISE NOTICE 'vpn_profiles.json_config added';
  ELSE
    RAISE NOTICE 'vpn_profiles.json_config already exists — skipped';
  END IF;
END $$;

-- ── Phase 3 : modèle « intermédiaire d'import » sur vpn_profiles ─────────────
-- Colonnes NULLables (configVersion NOT NULL DEFAULT 1) : rétrocompatibilité
-- totale, aucune perte de données. db push Prisma est compatible ; ce bloc
-- permet l'application manuelle idempotente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='sourceFormat') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "sourceFormat" VARCHAR(32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='canonicalConfig') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "canonicalConfig" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='canonicalConfigHash') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "canonicalConfigHash" VARCHAR(64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='configVersion') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "configVersion" INTEGER NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='importedAt') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "importedAt" TIMESTAMP(3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='validatedAt') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "validatedAt" TIMESTAMP(3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='validationStatus') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "validationStatus" VARCHAR(32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vpn_profiles' AND column_name='validationMessage') THEN
    ALTER TABLE vpn_profiles ADD COLUMN "validationMessage" TEXT;
  END IF;
END $$;

-- ── Mission OWNER : rôle racine OWNER (au-dessus de SUPER_ADMIN) ─────────────
-- Idempotent : INSERT … ON CONFLICT DO NOTHING. Aucune donnée existante n'est
-- modifiée. gen_random_uuid() est natif PostgreSQL 13+.
INSERT INTO roles (id, name, description)
SELECT gen_random_uuid(), 'OWNER', 'Propriétaire racine — au-dessus de SUPER_ADMIN'
ON CONFLICT (name) DO NOTHING;

-- ── Mission OWNER : traçabilité de sécurité (AuditLog) ──────────────────────
-- visibleOwnerOnly=true → entrée visible UNIQUEMENT par le rôle OWNER.
-- Les routes /api/audit-logs excluent ces entrées pour les non-OWNER.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "visibleOwnerOnly" BOOLEAN NOT NULL DEFAULT false;

-- ── Mission OWNER : modèle Setting clé/valeur (mode maintenance) ────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Santé mobile pseudonymisée ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mobile_health_devices (
  id TEXT PRIMARY KEY,
  pseudonym TEXT NOT NULL UNIQUE,
  "appVersion" TEXT NOT NULL,
  "versionCode" INTEGER NOT NULL,
  "androidApi" INTEGER,
  "deviceModel" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tunnelState" TEXT NOT NULL,
  protocol TEXT,
  "lastOutcome" TEXT NOT NULL DEFAULT 'none',
  "lastErrorCode" TEXT,
  "sessionDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "reconnectCount" INTEGER NOT NULL DEFAULT 0,
  "activeDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "backgroundDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "wakeCount" INTEGER NOT NULL DEFAULT 0,
  "reportCount" INTEGER NOT NULL DEFAULT 0,
  "batteryOptimization" TEXT NOT NULL DEFAULT 'unknown',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_health_reports (
  id TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL UNIQUE,
  "deviceId" TEXT NOT NULL REFERENCES mobile_health_devices(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tunnelState" TEXT NOT NULL,
  protocol TEXT,
  outcome TEXT NOT NULL DEFAULT 'none',
  "errorCode" TEXT,
  "sessionDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "reconnectCount" INTEGER NOT NULL DEFAULT 0,
  "activeDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "backgroundDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "wakeCount" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "mobile_health_devices_lastSeenAt_idx" ON mobile_health_devices("lastSeenAt");
CREATE INDEX IF NOT EXISTS "mobile_health_devices_versionCode_idx" ON mobile_health_devices("versionCode");
CREATE INDEX IF NOT EXISTS "mobile_health_reports_reportedAt_idx" ON mobile_health_reports("reportedAt");
CREATE INDEX IF NOT EXISTS "mobile_health_reports_deviceId_reportedAt_idx" ON mobile_health_reports("deviceId", "reportedAt");
CREATE INDEX IF NOT EXISTS "mobile_health_reports_outcome_reportedAt_idx" ON mobile_health_reports(outcome, "reportedAt");
