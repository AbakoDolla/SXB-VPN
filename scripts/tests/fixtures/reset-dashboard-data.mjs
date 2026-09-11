import { readFileSync } from "node:fs";

// La liste vient du tableau de bord lui-même, lue dans sa source : la dupliquer
// ici laissait le banc d'essai valider un aperçu incomplet, que l'interface
// refuse à juste titre — l'échec ressemblait alors à un défaut du composant.
const source = readFileSync(new URL("../../../artifacts/sxb-dashboard/src/api/reset.ts", import.meta.url), "utf8");
const declaration = source.match(/export const RESET_COUNT_KEYS = \[([\s\S]*?)\] as const;/);
if (!declaration) throw new Error("RESET_COUNT_KEYS introuvable dans le tableau de bord");
export const resetCountKeys = [...declaration[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
if (!resetCountKeys.length) throw new Error("RESET_COUNT_KEYS vide");
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
