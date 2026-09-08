-- Propriété commerciale et cycle de vie des vouchers.
-- Les champs restent NULLables pour préserver les vouchers historiques dont
-- le revendeur ou le client bénéficiaire ne peut pas être déduit avec certitude.
ALTER TABLE "vouchers"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resellerId" TEXT,
  ADD COLUMN IF NOT EXISTS "redeemedClientId" TEXT;

UPDATE "vouchers"
SET "status" = 'used'
WHERE "isRedeemed" = true
  AND "status" = 'active';

-- L'ancien parcours mobile stockait l'identifiant du client dans redeemedBy.
-- Ce backfill ne retient que les correspondances certaines.
UPDATE "vouchers" AS v
SET "redeemedClientId" = c."id"
FROM "vpn_clients" AS c
WHERE v."redeemedClientId" IS NULL
  AND v."isRedeemed" = true
  AND v."redeemedBy" = c."id";

UPDATE "vouchers" AS v
SET "resellerId" = c."resellerId"
FROM "vpn_clients" AS c
WHERE v."resellerId" IS NULL
  AND v."redeemedClientId" = c."id"
  AND c."resellerId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "vouchers_resellerId_idx"
  ON "vouchers" ("resellerId");
CREATE INDEX IF NOT EXISTS "vouchers_redeemedClientId_idx"
  ON "vouchers" ("redeemedClientId");
CREATE INDEX IF NOT EXISTS "vouchers_resellerId_status_isRedeemed_idx"
  ON "vouchers" ("resellerId", "status", "isRedeemed");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vouchers_resellerId_fkey'
      AND conrelid = 'vouchers'::regclass
  ) THEN
    ALTER TABLE "vouchers"
      ADD CONSTRAINT "vouchers_resellerId_fkey"
      FOREIGN KEY ("resellerId") REFERENCES "resellers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vouchers_redeemedClientId_fkey'
      AND conrelid = 'vouchers'::regclass
  ) THEN
    ALTER TABLE "vouchers"
      ADD CONSTRAINT "vouchers_redeemedClientId_fkey"
      FOREIGN KEY ("redeemedClientId") REFERENCES "vpn_clients"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Amorçage unique : un changement RBAC ultérieur reste sous le contrôle d'un
-- SUPER_ADMIN et n'est pas annulé lors d'un redéploiement.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "settings"
    WHERE "key" = 'migration.voucher_lifecycle_rbac.v1'
  ) THEN
    INSERT INTO "permissions" ("id", "name", "description")
    VALUES
      (gen_random_uuid(), 'vouchers.view', 'Voir les vouchers'),
      (gen_random_uuid(), 'vouchers.create', 'Créer des vouchers'),
      (gen_random_uuid(), 'vouchers.redeem', 'Appliquer des vouchers à un client'),
      (gen_random_uuid(), 'vouchers.revoke', 'Révoquer des vouchers non utilisés')
    ON CONFLICT ("name") DO NOTHING;

    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT r."id", p."id"
    FROM "roles" r
    JOIN "permissions" p ON p."name" IN (
      'vouchers.view', 'vouchers.create', 'vouchers.redeem', 'vouchers.revoke'
    )
    WHERE r."name" IN ('RESELLER', 'ADMIN', 'SUPER_ADMIN')
    ON CONFLICT ("roleId", "permissionId") DO NOTHING;

    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT r."id", p."id"
    FROM "roles" r
    JOIN "permissions" p ON p."name" = 'vouchers.view'
    WHERE r."name" = 'SUPPORT'
    ON CONFLICT ("roleId", "permissionId") DO NOTHING;

    INSERT INTO "settings" ("key", "value")
    VALUES ('migration.voucher_lifecycle_rbac.v1', 'applied')
    ON CONFLICT ("key") DO NOTHING;
  END IF;
END
$$;
