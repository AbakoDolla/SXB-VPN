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
