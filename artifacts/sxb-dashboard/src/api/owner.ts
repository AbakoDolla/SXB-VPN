/// api/owner.ts — API du rôle racine OWNER (invisible des autres rôles).
/// Mode maintenance (pause/play du dashboard) + Journal propriétaire.
/// Les endpoints serveur sont réservés OWNER : /ops/maintenance et
/// /audit-logs/owner. Le 503 { error: 'maintenance' } informe le frontend
/// public qu'une maintenance est en cours (sans fuite d'information).
import { apiRequest } from "./client";
import { ActivityLog } from "../types";

export interface MaintenanceState {
  enabled: boolean;
  key: string;
}

/// État courant du mode maintenance.
///  - OWNER → 200 { enabled }
///  - maintenance active (non-OWNER) → 503 { error: 'maintenance' }
///  - maintenance inactive (non-OWNER) → 403
export async function fetchMaintenanceState(): Promise<MaintenanceState> {
  return await apiRequest<MaintenanceState>("/ops/maintenance");
}

/// Bascule pause/play du dashboard (OWNER uniquement).
export async function setMaintenanceMode(enabled: boolean): Promise<MaintenanceState> {
  return await apiRequest<MaintenanceState>("/ops/maintenance", {
    method: "POST",
    body: { enabled },
  });
}

/// Journal propriétaire — traçabilité de sécurité (OWNER uniquement) :
/// authentifications OWNER, suspensions/révocations, bascules maintenance.
export async function fetchOwnerLogs(limit = 100): Promise<ActivityLog[]> {
  const data = await apiRequest<{ logs: ActivityLog[] }>(`/audit-logs/owner?limit=${limit}`);
  return data.logs || [];
}
