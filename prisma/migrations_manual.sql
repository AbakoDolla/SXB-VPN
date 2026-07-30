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
