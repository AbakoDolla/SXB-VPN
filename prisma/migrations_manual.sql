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
