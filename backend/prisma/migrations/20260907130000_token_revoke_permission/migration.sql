-- Permission de mutation distincte de la simple consultation des jetons.
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
