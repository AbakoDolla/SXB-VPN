BEGIN;
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS "allocationUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationOwnerId" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationOwnerName" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationResellerId" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationType" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationOrigin" TEXT;
ALTER TABLE data_additions
  ADD COLUMN IF NOT EXISTS "allocationUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationOwnerId" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationOwnerName" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationResellerId" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationType" TEXT;

-- Freeze the recorded creator first, otherwise the pre-migration billing owner.
-- The origin explicitly distinguishes that legacy snapshot from a new sale.
WITH identities AS (
  SELECT s.id, c."userId",
    s."freeTrialRequestId" IS NOT NULL
      OR EXISTS (SELECT 1 FROM free_trial_requests f WHERE f."subscriptionId" = s.id)
      OR EXISTS (SELECT 1 FROM data_additions d WHERE d."subscriptionId" = s.id AND d.kind = 'creation' AND d."freeTrial")
      AS trial,
    creator.id AS "creatorResellerId",
    COALESCE(creator.id, c."resellerId", legacy.id) AS "sellerId",
    s."createdBy", c."managedById"
  FROM subscriptions s
  JOIN vpn_clients c ON c.id = s."clientId"
  LEFT JOIN resellers creator ON creator."userId" = s."createdBy" AND creator."createdAt" <= s."createdAt"
  LEFT JOIN resellers legacy ON legacy."userId" = c."userId" AND legacy."createdAt" <= s."createdAt"
  WHERE s."allocationType" IS NULL
), owners AS (
  SELECT i.*, r."userId" AS "sellerUserId", u.name AS "sellerName", u.email AS "sellerEmail"
  FROM identities i
  LEFT JOIN resellers r ON r.id = i."sellerId"
  LEFT JOIN users u ON u.id = r."userId"
)
UPDATE subscriptions s SET
  "allocationUserId" = o."userId",
  "allocationType" = CASE WHEN o.trial THEN 'free_trial' ELSE 'sold' END,
  "allocationResellerId" = CASE WHEN o.trial THEN NULL ELSE o."sellerId" END,
  "allocationOwnerId" = CASE WHEN o.trial THEN COALESCE(o."createdBy", o."managedById", 'system')
    ELSE COALESCE(o."sellerUserId", o."createdBy", o."managedById", 'system') END,
  "allocationOwnerName" = CASE WHEN o.trial THEN 'Systeme'
    ELSE COALESCE(o."sellerName", o."sellerEmail", 'Systeme') END,
  "allocationOrigin" = CASE WHEN o.trial THEN 'legacy_trial'
    WHEN o."creatorResellerId" IS NOT NULL THEN 'legacy_creator' ELSE 'legacy_account_snapshot' END
FROM owners o WHERE s.id = o.id;

UPDATE data_additions d SET
  "allocationUserId" = s."allocationUserId", "allocationOwnerId" = s."allocationOwnerId",
  "allocationOwnerName" = s."allocationOwnerName", "allocationResellerId" = s."allocationResellerId",
  "allocationType" = CASE WHEN d."freeTrial" THEN 'free_trial' ELSE s."allocationType" END
FROM subscriptions s WHERE s.id = d."subscriptionId" AND d."allocationType" IS NULL;
WITH historical AS (
  SELECT d.id, c."userId", d."actorUserId",
    d."freeTrial" OR EXISTS (
      SELECT 1 FROM data_additions origin
      WHERE origin."subscriptionId" = d."subscriptionId" AND origin.kind = 'creation' AND origin."freeTrial"
    ) AS trial,
    COALESCE(creator.id, c."resellerId", legacy.id) AS "sellerId"
  FROM data_additions d
  LEFT JOIN vpn_clients c ON c.id = d."clientId"
  LEFT JOIN resellers creator ON creator."userId" = d."actorUserId" AND creator."createdAt" <= d."createdAt"
  LEFT JOIN resellers legacy ON legacy."userId" = c."userId" AND legacy."createdAt" <= d."createdAt"
  WHERE d."allocationType" IS NULL
)
UPDATE data_additions d SET
  "allocationUserId" = h."userId",
  "allocationType" = CASE WHEN h.trial THEN 'free_trial' ELSE 'sold' END,
  "allocationResellerId" = CASE WHEN h.trial THEN NULL ELSE h."sellerId" END,
  "allocationOwnerId" = CASE WHEN h.trial THEN COALESCE(h."actorUserId", 'system')
    ELSE COALESCE(r."userId", h."actorUserId", 'system') END,
  "allocationOwnerName" = CASE WHEN h.trial THEN 'Systeme' ELSE COALESCE(u.name, u.email, 'Systeme') END
FROM historical h LEFT JOIN resellers r ON r.id = h."sellerId" LEFT JOIN users u ON u.id = r."userId"
WHERE d.id = h.id;
UPDATE data_additions SET "allocationResellerId" = NULL WHERE "allocationType" = 'free_trial';

CREATE INDEX IF NOT EXISTS "subscriptions_allocationResellerId_allocationType_createdAt_idx"
  ON subscriptions ("allocationResellerId", "allocationType", "createdAt");
CREATE INDEX IF NOT EXISTS "subscriptions_allocationUserId_allocationType_idx"
  ON subscriptions ("allocationUserId", "allocationType");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_allocation_identity_check') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_allocation_identity_check
      CHECK ("allocationType" IS NULL OR
        ("allocationType" IN ('sold', 'free_trial') AND "allocationUserId" IS NOT NULL
          AND "allocationOwnerId" IS NOT NULL AND
          ("allocationType" <> 'free_trial' OR "allocationResellerId" IS NULL)));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION preserve_subscription_allocation_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."allocationType" IS NOT NULL AND
    ROW(OLD."allocationUserId", OLD."allocationOwnerId", OLD."allocationOwnerName", OLD."allocationResellerId",
      OLD."allocationType", OLD."allocationOrigin", OLD."clientId")
    IS DISTINCT FROM
    ROW(NEW."allocationUserId", NEW."allocationOwnerId", NEW."allocationOwnerName", NEW."allocationResellerId",
      NEW."allocationType", NEW."allocationOrigin", NEW."clientId") THEN
    RAISE EXCEPTION 'ALLOCATION_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS subscription_allocation_identity_immutable ON subscriptions;
CREATE TRIGGER subscription_allocation_identity_immutable BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION preserve_subscription_allocation_identity();
COMMIT;
