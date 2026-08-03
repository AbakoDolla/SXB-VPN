/**
 * Maintenance mode — service central.
 *
 * Stockage : table `settings` (clé/valeur) via Prisma ; fallback mémoire
 * si la base n'est pas configurée (mode preview). Clé : 'maintenance_mode'.
 *
 * Le mode maintenance est piloté UNIQUEMENT par le rôle OWNER
 * (routes /api/ops/maintenance). Le middleware maintenanceGuard
 * applique le 503 global à tout /api/* sauf auth/login, auth/refresh
 * et ops/* (l'OWNER doit pouvoir se connecter et basculer le mode).
 */
import { prisma, inMemoryDb } from "../database";

export const MAINTENANCE_KEY = "maintenance_mode";
export const MAINTENANCE_ENABLED_VALUE = "true";

export async function getMaintenanceMode(): Promise<boolean> {
  if (prisma) {
    try {
      const setting = await prisma.setting.findUnique({
        where: { key: MAINTENANCE_KEY },
      });
      return setting?.value === MAINTENANCE_ENABLED_VALUE;
    } catch (err) {
      console.warn("⚠️ getMaintenanceMode (prisma) failed:", err);
      return inMemoryDb.settings?.[MAINTENANCE_KEY] === MAINTENANCE_ENABLED_VALUE;
    }
  }
  return inMemoryDb.settings?.[MAINTENANCE_KEY] === MAINTENANCE_ENABLED_VALUE;
}

export async function setMaintenanceMode(enabled: boolean): Promise<boolean> {
  const value = enabled ? MAINTENANCE_ENABLED_VALUE : "false";
  if (prisma) {
    await prisma.setting.upsert({
      where: { key: MAINTENANCE_KEY },
      update: { value },
      create: { key: MAINTENANCE_KEY, value },
    });
  }
  inMemoryDb.settings = { ...(inMemoryDb.settings || {}), [MAINTENANCE_KEY]: value };
  return enabled;
}
