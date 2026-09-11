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

-- Permission de mutation distincte de la simple consultation des jetons.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "settings"
    WHERE "key" = 'migration.token_revoke_permission.v1'
  ) THEN
    INSERT INTO "permissions" ("id", "name", "description")
    VALUES (gen_random_uuid(), 'tokens.revoke', 'Révoquer des jetons SXB')
    ON CONFLICT ("name") DO NOTHING;

    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT r."id", p."id"
    FROM "roles" r
    JOIN "permissions" p ON p."name" = 'tokens.revoke'
    WHERE r."name" IN ('RESELLER', 'ADMIN', 'SUPER_ADMIN')
    ON CONFLICT ("roleId", "permissionId") DO NOTHING;

    INSERT INTO "settings" ("key", "value")
    VALUES ('migration.token_revoke_permission.v1', 'applied')
    ON CONFLICT ("key") DO NOTHING;
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

-- ── Validite d acces revendeur + propriete explicite du client ────────────────
-- Validité d'accès revendeur + propriété explicite du client.
--
-- STRICTEMENT ADDITIVE ET IDEMPOTENTE : deux colonnes NULLables, un index et
-- une clé étrangère ON DELETE SET NULL. Aucune ligne métier n'est supprimée,
-- aucune colonne existante n'est réécrite. Rejouer ce fichier ne produit
-- aucun effet supplémentaire.
--
-- `resellers.accessExpiresAt` NULL = accès hérité sans échéance (fiches
-- créées avant cette migration). L'API refuse désormais une création sans
-- date, mais la base n'impose rien aux lignes historiques : leur imposer une
-- échéance rétroactivement couperait des revendeurs en service.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'resellers' AND column_name = 'accessExpiresAt'
  ) THEN
    ALTER TABLE "resellers" ADD COLUMN "accessExpiresAt" TIMESTAMP(3);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vpn_clients' AND column_name = 'resellerId'
  ) THEN
    ALTER TABLE "vpn_clients" ADD COLUMN "resellerId" TEXT;
  END IF;
END
$$;

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

-- ── Propriété et cycle de vie des vouchers ──────────────────────────────────
ALTER TABLE "vouchers"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resellerId" TEXT,
  ADD COLUMN IF NOT EXISTS "redeemedClientId" TEXT;

UPDATE "vouchers"
SET "status" = 'used'
WHERE "isRedeemed" = true
  AND "status" = 'active';

UPDATE "vouchers" AS v
SET "redeemedClientId" = c."id"
FROM "vpn_clients" AS c
WHERE v."redeemedClientId" IS NULL
  AND v."isRedeemed" = true
  AND v."redeemedBy" = c."id";

UPDATE "vouchers" AS v
SET "resellerId" = COALESCE(c."resellerId", r."id")
FROM "vpn_clients" AS c LEFT JOIN "resellers" AS r ON r."userId" = c."userId"
WHERE v."resellerId" IS NULL
  AND v."redeemedClientId" = c."id"
  AND COALESCE(c."resellerId", r."id") IS NOT NULL;

CREATE INDEX IF NOT EXISTS "vouchers_resellerId_idx" ON "vouchers" ("resellerId");
CREATE INDEX IF NOT EXISTS "vouchers_redeemedClientId_idx" ON "vouchers" ("redeemedClientId");
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

CREATE INDEX IF NOT EXISTS "vpn_clients_resellerId_idx"
  ON "vpn_clients" ("resellerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vpn_clients_resellerId_fkey'
      AND conrelid = 'vpn_clients'::regclass
  ) THEN
    ALTER TABLE "vpn_clients"
      ADD CONSTRAINT "vpn_clients_resellerId_fkey"
      FOREIGN KEY ("resellerId") REFERENCES "resellers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Report de la propriété DÉJÀ EXISTANTE, pas une réattribution : jusqu'ici un
-- client appartenait à un revendeur parce qu'il portait son `userId`. La ligne
-- ci-dessous ne fait que rendre ce lien explicite, uniquement là où la colonne
-- est encore vide. Aucun client rattaché à un autre compte n'est déplacé.
UPDATE "vpn_clients" AS c
SET "resellerId" = r."id"
FROM "resellers" AS r
WHERE c."resellerId" IS NULL
  AND c."userId" = r."userId";

-- Amorçage unique des permissions indispensables au nouveau parcours.
-- Le marqueur empêche les déploiements suivants de réattribuer une permission
-- qu'un SUPER_ADMIN aurait volontairement retirée depuis l'écran RBAC.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "settings"
    WHERE "key" = 'migration.reseller_lifecycle_rbac.v1'
  ) THEN
    INSERT INTO "permissions" ("id", "name", "description")
    VALUES
      (gen_random_uuid(), 'clients.view', 'Voir les clients VPN'),
      (gen_random_uuid(), 'subscription.view', 'Voir les forfaits data'),
      (gen_random_uuid(), 'subscription.manage', 'Créer et gérer les forfaits data'),
      (gen_random_uuid(), 'tokens.view', 'Voir les jetons SXB'),
      (gen_random_uuid(), 'rbac.manage', 'Administrer les permissions RBAC')
    ON CONFLICT ("name") DO NOTHING;

    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT r."id", p."id"
    FROM "roles" r
    JOIN "permissions" p ON p."name" IN (
      'clients.view', 'subscription.view', 'subscription.manage', 'tokens.view'
    )
    WHERE r."name" IN ('RESELLER', 'ADMIN', 'SUPER_ADMIN')
    ON CONFLICT ("roleId", "permissionId") DO NOTHING;

    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT r."id", p."id"
    FROM "roles" r
    JOIN "permissions" p ON p."name" = 'rbac.manage'
    WHERE r."name" = 'SUPER_ADMIN'
    ON CONFLICT ("roleId", "permissionId") DO NOTHING;

    IF (
      SELECT count(DISTINCT "name") FROM "roles"
      WHERE "name" IN ('RESELLER', 'ADMIN', 'SUPER_ADMIN')
    ) = 3 THEN
      INSERT INTO "settings" ("key", "value")
      VALUES ('migration.reseller_lifecycle_rbac.v1', 'applied')
      ON CONFLICT ("key") DO NOTHING;
    END IF;
  END IF;
END
$$;

-- ── Essai gratuit : jeton d'invitation + demandes ────────────────────────────
-- STRICTEMENT ADDITIF : deux nouvelles tables. Aucune table ni colonne
-- existante n'est modifiee, supprimee ou rendue obligatoire. La base de
-- production reste fonctionnelle a l'identique si ce bloc n'est pas applique
-- (les routes d'essai repondent alors 503, rien d'autre ne change).
--
-- RAPPEL DE CONCEPTION : free_trial_tokens ne porte AUCUNE colonne technique
-- VPN (ni serveur, ni quota, ni date d'acces, ni configuration). Un jeton
-- d'essai ne peut donc pas faire fuiter une configuration : l'information ne
-- s'y trouve pas.
CREATE TABLE IF NOT EXISTS "free_trial_tokens" (
  "id"        TEXT PRIMARY KEY,
  "token"     TEXT NOT NULL UNIQUE,
  "label"     TEXT,
  "maxUses"   INTEGER,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "status"    TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "free_trial_tokens_status_createdAt_idx"
  ON "free_trial_tokens" ("status", "createdAt");

CREATE TABLE IF NOT EXISTS "free_trial_requests" (
  "id"              TEXT PRIMARY KEY,
  "tokenId"         TEXT NOT NULL REFERENCES "free_trial_tokens"("id") ON DELETE CASCADE,
  "name"            TEXT NOT NULL,
  "deviceId"        TEXT NOT NULL,
  "platform"        TEXT,
  "appVersion"      TEXT,
  "claimSecretHash" TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "clientId"        TEXT,
  "subscriptionId"  TEXT,
  "deployedAt"      TIMESTAMP(3),
  "deployedBy"      TEXT,
  "rejectedAt"      TIMESTAMP(3),
  "rejectedBy"      TEXT,
  "reviewNote"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastCheckedAt"   TIMESTAMP(3)
);
-- Une demande SEPAREE par couple (jeton, appareil) : deux personnes qui
-- utilisent le meme jeton n'ont jamais la meme ligne, donc jamais le meme
-- acces.
CREATE UNIQUE INDEX IF NOT EXISTS "free_trial_requests_tokenId_deviceId_key"
  ON "free_trial_requests" ("tokenId", "deviceId");
CREATE INDEX IF NOT EXISTS "free_trial_requests_status_createdAt_idx"
  ON "free_trial_requests" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "free_trial_requests_deviceId_idx"
  ON "free_trial_requests" ("deviceId");

-- ── Essai gratuit : pays declare + empreinte d'appareil ─────────────────────
-- STRICTEMENT ADDITIF : deux colonnes NULLABLES sur une table deja creee par
-- le bloc ci-dessus. Aucune ligne existante n'est reecrite, aucune colonne
-- existante n'est modifiee ni rendue obligatoire. Une base qui n'applique pas
-- ce bloc continue de fonctionner : seules les nouvelles inscriptions
-- exigeraient les colonnes.
--
-- "country" est le pays SAISI par l'utilisateur (ISO 3166-1 alpha-2). C'est
-- une declaration, pas une mesure : aucune geolocalisation ni resolution
-- d'adresse IP n'intervient nulle part dans ce chemin.
--
-- "deviceFingerprint" est un CONDENSAT SHA-256 (avec sel serveur) d'une
-- empreinte d'appareil stable a travers une reinstallation. La valeur brute
-- n'est jamais stockee ni journalisee. C'est ce qui interdit un second essai
-- apres desinstallation / reinstallation de l'application.
ALTER TABLE "free_trial_requests" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "free_trial_requests" ADD COLUMN IF NOT EXISTS "deviceFingerprint" TEXT;

-- Le controle « un seul essai par appareil » tourne a chaque inscription : il
-- doit etre une lecture indexee, pas un balayage de table.
CREATE INDEX IF NOT EXISTS "free_trial_requests_deviceFingerprint_status_idx"
  ON "free_trial_requests" ("deviceFingerprint", "status");
CREATE INDEX IF NOT EXISTS "free_trial_requests_country_status_idx"
  ON "free_trial_requests" ("country", "status");
