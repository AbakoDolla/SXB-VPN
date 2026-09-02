DELETE FROM "role_permissions"
WHERE "permissionId" IN (
    SELECT "id"
    FROM "permissions"
    WHERE "name" IN ('xpanel.view', 'xpanel.manage', 'xpanel.sync', 'xpanel.access')
);

DELETE FROM "permissions"
WHERE "name" IN ('xpanel.view', 'xpanel.manage', 'xpanel.sync', 'xpanel.access');

DO $$
BEGIN
    IF to_regclass('"xpanel_configs"') IS NOT NULL THEN
        IF to_regclass('"server_configs"') IS NOT NULL THEN
            RAISE EXCEPTION 'Both legacy and current server configuration tables exist';
        END IF;
        ALTER TABLE "xpanel_configs" RENAME TO "server_configs";
    ELSIF to_regclass('"server_configs"') IS NULL THEN
        RAISE EXCEPTION 'Server configuration table is missing';
    END IF;
END
$$;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname
    INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = '"server_configs"'::regclass
      AND contype = 'p';

    IF constraint_name IS NOT NULL AND constraint_name <> 'server_configs_pkey' THEN
        EXECUTE format(
            'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
            'server_configs',
            constraint_name,
            'server_configs_pkey'
        );
    END IF;

    SELECT conname
    INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = '"server_configs"'::regclass
      AND confrelid = '"servers"'::regclass
      AND contype = 'f';

    IF constraint_name IS NOT NULL
       AND constraint_name <> 'server_configs_serverId_fkey' THEN
        EXECUTE format(
            'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
            'server_configs',
            constraint_name,
            'server_configs_serverId_fkey'
        );
    END IF;
END
$$;

ALTER TABLE "vpn_clients" DROP COLUMN IF EXISTS "xpanelUserId";
