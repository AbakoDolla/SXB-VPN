DELETE FROM "role_permissions"
WHERE "permissionId" IN (
    SELECT "id"
    FROM "permissions"
    WHERE "name" IN ('xpanel.view', 'xpanel.manage', 'xpanel.sync', 'xpanel.access')
);

DELETE FROM "permissions"
WHERE "name" IN ('xpanel.view', 'xpanel.manage', 'xpanel.sync', 'xpanel.access');

ALTER TABLE "xpanel_configs" RENAME TO "server_configs";
ALTER TABLE "server_configs"
    RENAME CONSTRAINT "xpanel_configs_pkey" TO "server_configs_pkey";
ALTER TABLE "server_configs"
    RENAME CONSTRAINT "xpanel_configs_serverId_fkey" TO "server_configs_serverId_fkey";

ALTER TABLE "vpn_clients" DROP COLUMN "xpanelUserId";
