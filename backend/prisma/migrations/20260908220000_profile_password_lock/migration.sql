-- profile_password_lock_v1: additive, legacy profiles remain unlocked.
ALTER TABLE "vpn_profiles" ADD COLUMN IF NOT EXISTS "lockPasswordHash" TEXT;
ALTER TABLE "vpn_profiles" ADD COLUMN IF NOT EXISTS "lockVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "vpn_profiles" ADD COLUMN IF NOT EXISTS "engineType" TEXT;
ALTER TABLE "vpn_profiles" ADD COLUMN IF NOT EXISTS "engineAccountId" TEXT;
CREATE INDEX IF NOT EXISTS "vpn_profiles_engineType_engineAccountId_idx"
  ON "vpn_profiles" ("engineType", "engineAccountId");

-- Link only certain one-to-one legacy copies. Never infer identity from a
-- non-unique name or attach a profile already bound to another source.
WITH accounts AS (
  SELECT 'ssh' AS engine, "id", '[SSH] ' || "name" AS profile_name,
    'ssh' AS protocol, "host", "port", "username" AS identity
  FROM "ssh_accounts"
  UNION ALL
  SELECT 'xray', "id", '[' || upper("protocol") || '] ' || "name",
    "protocol", "host", "port", "uuid" FROM "xray_accounts"
  UNION ALL
  SELECT 'singbox', "id", '[' || upper("protocol") || '-SB] ' || "name",
    "protocol", "host", "port", "uuid" FROM "singbox_accounts"
), matches AS (
  SELECT p."id" AS profile_id, a.engine, a."id" AS account_id,
    count(*) OVER (PARTITION BY p."id") AS profile_matches,
    count(*) OVER (PARTITION BY a.engine, a."id") AS account_matches
  FROM "vpn_profiles" p JOIN accounts a
    ON p."name" = a.profile_name AND p."protocol" = a.protocol
    AND p."host" = a."host" AND p."port" = a."port"
    AND a.identity IS NOT NULL
    AND a.identity = CASE WHEN a.engine = 'ssh' THEN p."username" ELSE p."uuid" END
  WHERE p."engineAccountId" IS NULL AND p."engineType" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "vpn_profiles" bound
      WHERE bound."engineType" = a.engine AND bound."engineAccountId" = a."id")
)
UPDATE "vpn_profiles" p
SET "engineType" = m.engine, "engineAccountId" = m.account_id
FROM matches m
WHERE p."id" = m.profile_id AND m.profile_matches = 1 AND m.account_matches = 1;
