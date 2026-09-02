-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "admin_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_clients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "quotaTotal" BIGINT,
    "quotaUsed" BIGINT NOT NULL DEFAULT 0,
    "expireAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "avatarUrl" TEXT,
    "xpanelUserId" TEXT,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "deviceId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "appRegisteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vpn_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resellers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commission" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "quota" BIGINT NOT NULL,
    "expiration" TIMESTAMP(3) NOT NULL,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'online',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xpanel_configs" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "configurationEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xpanel_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "quota" BIGINT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "isRedeemed" BOOLEAN NOT NULL DEFAULT false,
    "redeemedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ipAddress" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visibleOwnerOnly" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ssh_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'create',
    "expireAt" TIMESTAMP(3),
    "quotaTotal" BIGINT,
    "quotaUsed" BIGINT NOT NULL DEFAULT 0,
    "connectionLimit" INTEGER NOT NULL DEFAULT 1,
    "compression" BOOLEAN NOT NULL DEFAULT false,
    "tcpNodelay" BOOLEAN NOT NULL DEFAULT true,
    "slowDns" BOOLEAN NOT NULL DEFAULT false,
    "dns" TEXT,
    "sni" TEXT,
    "payloadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ssh_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ssh_payloads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT,
    "sni" TEXT,
    "port" INTEGER,
    "headers" JSONB,
    "content" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ssh_payloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xray_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "path" TEXT,
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "sni" TEXT,
    "network" TEXT DEFAULT 'ws',
    "password" TEXT,
    "method" TEXT,
    "quotaTotal" BIGINT,
    "quotaUsed" BIGINT NOT NULL DEFAULT 0,
    "expireAt" TIMESTAMP(3),
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "serverId" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xray_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "singbox_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "path" TEXT,
    "tls" BOOLEAN NOT NULL DEFAULT true,
    "sni" TEXT,
    "network" TEXT DEFAULT 'ws',
    "password" TEXT,
    "method" TEXT,
    "quotaTotal" BIGINT,
    "quotaUsed" BIGINT NOT NULL DEFAULT 0,
    "expireAt" TIMESTAMP(3),
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "serverId" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "singbox_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_usage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "accountId" TEXT,
    "deviceId" TEXT,
    "accountType" TEXT,
    "download" BIGINT NOT NULL DEFAULT 0,
    "upload" BIGINT NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_logs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "accountId" TEXT,
    "protocol" TEXT,
    "action" TEXT NOT NULL,
    "ipAddress" TEXT,
    "details" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vpn_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "protocol" TEXT NOT NULL,
    "displayProtocol" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "uuid" TEXT,
    "path" TEXT,
    "network" TEXT DEFAULT 'ws',
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "sni" TEXT,
    "dns" TEXT,
    "payloadId" TEXT,
    "offlineValidDays" INTEGER NOT NULL DEFAULT 7,
    "method" TEXT,
    "jsonConfig" TEXT,
    "sourceFormat" TEXT,
    "canonicalConfig" TEXT,
    "canonicalConfigHash" TEXT,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "importedAt" TIMESTAMP(3),
    "validatedAt" TIMESTAMP(3),
    "validationStatus" TEXT,
    "validationMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vpn_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "dataToken" TEXT NOT NULL,
    "quotaBytes" BIGINT NOT NULL DEFAULT 0,
    "quotaUsed" BIGINT NOT NULL DEFAULT 0,
    "durationDays" INTEGER NOT NULL,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expireAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "displayProtocol" TEXT,
    "technicalProtocol" TEXT,
    "lastProvisionAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "deviceId" TEXT,
    "revokeReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_registrations" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "phone" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "clientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_devices" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "subscription_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_sessions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "activationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expirationDate" TIMESTAMP(3),
    "lastSync" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'info',
    "target" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "admin_tokens_token_key" ON "admin_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_clients_token_key" ON "vpn_clients"("token");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_clients_deviceId_key" ON "vpn_clients"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "resellers_userId_key" ON "resellers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_token_key" ON "tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "xray_accounts_uuid_key" ON "xray_accounts"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "singbox_accounts_uuid_key" ON "singbox_accounts"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_profiles_uuid_key" ON "vpn_profiles"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_dataToken_key" ON "subscriptions"("dataToken");

-- CreateIndex
CREATE UNIQUE INDEX "app_registrations_deviceId_key" ON "app_registrations"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_devices_subscriptionId_deviceId_key" ON "subscription_devices"("subscriptionId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "activation_sessions_clientId_deviceId_key" ON "activation_sessions"("clientId", "deviceId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_clients" ADD CONSTRAINT "vpn_clients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "vpn_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xpanel_configs" ADD CONSTRAINT "xpanel_configs_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ssh_accounts" ADD CONSTRAINT "ssh_accounts_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "ssh_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xray_accounts" ADD CONSTRAINT "xray_accounts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "vpn_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "singbox_accounts" ADD CONSTRAINT "singbox_accounts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "vpn_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_profiles" ADD CONSTRAINT "vpn_profiles_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "ssh_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "vpn_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "vpn_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_registrations" ADD CONSTRAINT "app_registrations_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "vpn_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_devices" ADD CONSTRAINT "subscription_devices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_sessions" ADD CONSTRAINT "activation_sessions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "vpn_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

