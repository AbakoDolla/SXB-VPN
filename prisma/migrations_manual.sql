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
