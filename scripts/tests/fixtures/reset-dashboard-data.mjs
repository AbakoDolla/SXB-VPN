export const resetCountKeys = [
  "users", "resellers", "clients", "registrations", "activations", "subscriptions",
  "subscriptionDevices", "tokens", "vouchers", "profiles", "profileAssignments",
  "sshAccounts", "xrayAccounts", "singboxAccounts", "payloads", "traffic", "vpnLogs",
  "pushTokens", "healthReports", "healthDevices", "supportTickets", "adminTokens",
];
export const resetPreview = {
  mode: "production", confirmationText: "RESET SXB VPN",
  challenge: "fixture-original-reset-nonce", expiresAt: "2026-09-09T06:08:00.000Z",
  backupRequired: true,
  counts: Object.fromEntries(resetCountKeys.map(key => [key, 2])),
  preserved: {
    usersByRole: { OWNER: 1, ADMIN: 3, SUPER_ADMIN: 2 },
    roles: 5, permissions: 50, servers: 1, serverConfigs: 2,
    auditLogs: 40, quotaMovements: 60, settings: 4, projectFiles: true,
  },
  warnings: [
    "RESET_LOCKED_CONFIGS_INCLUDED", "RESET_ADMIN_VPN_DATA_INCLUDED",
    "RESET_PRIVATE_BACKUP_REQUIRED", "RESET_STORAGE_REUSED_NOT_FREED",
  ],
};
export const resetResult = {
  status: "completed", resetId: "fixture-reset-receipt", completedAt: "2026-09-09T06:01:00.000Z",
  deletedCounts: resetPreview.counts,
  countsAfter: Object.fromEntries(resetCountKeys.map(key => [key, 0])),
  retainedUsersByRole: resetPreview.preserved.usersByRole,
  backup: { id: "fixture-private-backup", bytes: 1024, sha256: "a".repeat(64) },
  maintenanceRestored: true,
};
