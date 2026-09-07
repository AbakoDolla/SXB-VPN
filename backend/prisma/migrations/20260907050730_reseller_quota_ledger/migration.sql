-- Grand livre append-only des quotas revendeur.
-- Cette migration ne recopie ni ne modifie aucune donnee metier existante.
CREATE TABLE IF NOT EXISTS "reseller_quota_movements" (
  "id" TEXT NOT NULL,
  "resellerId" TEXT NOT NULL,
  "resellerUserId" TEXT NOT NULL,
  "resellerName" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorName" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "deltaBytes" BIGINT NOT NULL,
  "quotaBeforeBytes" BIGINT NOT NULL,
  "quotaAfterBytes" BIGINT NOT NULL,
  "allocatedBeforeBytes" BIGINT NOT NULL,
  "allocatedAfterBytes" BIGINT NOT NULL,
  "referenceType" TEXT,
  "referenceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reseller_quota_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reseller_quota_movements_kind_check" CHECK (
    "kind" IN (
      'ADMIN_ALLOCATION',
      'ADMIN_WITHDRAWAL',
      'ADMIN_CORRECTION',
      'QUOTA_COMMITMENT',
      'QUOTA_RELEASE'
    )
  )
);

CREATE INDEX IF NOT EXISTS "reseller_quota_movements_resellerUserId_createdAt_idx"
  ON "reseller_quota_movements" ("resellerUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "reseller_quota_movements_resellerId_createdAt_idx"
  ON "reseller_quota_movements" ("resellerId", "createdAt");
CREATE INDEX IF NOT EXISTS "reseller_quota_movements_createdAt_idx"
  ON "reseller_quota_movements" ("createdAt");

CREATE OR REPLACE FUNCTION reject_reseller_quota_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reseller_quota_movements is append-only';
END;
$$;

DROP TRIGGER IF EXISTS "reseller_quota_movements_append_only"
  ON "reseller_quota_movements";
CREATE TRIGGER "reseller_quota_movements_append_only"
  BEFORE UPDATE OR DELETE ON "reseller_quota_movements"
  FOR EACH ROW EXECUTE FUNCTION reject_reseller_quota_movement_mutation();
