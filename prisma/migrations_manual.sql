-- Migration manuelle appliquée sur le VPS le 2026-07-19
-- Ces colonnes étaient dans le schema.prisma mais absentes de la DB (schema drift)

-- vpn_profiles: ajout de createdBy
ALTER TABLE vpn_profiles ADD COLUMN IF NOT EXISTS "createdBy" text;

-- subscriptions: colonnes manquantes du modèle Subscription
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS "lastProvisionAt" timestamp(3) without time zone;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS "lastSyncAt" timestamp(3) without time zone;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS "revokedAt" timestamp(3) without time zone;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS "createdBy" text;

-- subscription_devices: table manquante (modèle SubscriptionDevice)
CREATE TABLE IF NOT EXISTS subscription_devices (
  id text NOT NULL PRIMARY KEY,
  "subscriptionId" text NOT NULL REFERENCES subscriptions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  "deviceId" text NOT NULL,
  "activatedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" timestamp(3) without time zone
);
