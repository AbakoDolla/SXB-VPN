import { TrafficDataPoint, UserDataPoint, ActivityLog, ResellerAccessSummary } from "../types";
import { apiRequest } from "./client";

export interface DashboardResellerQuota {
  /** Quota du revendeur connecté ou agrégat des revendeurs administrés. */
  scope: "self" | "platform";
  assignedBytes: string;
  committedBytes: string;
  consumedBytes: string;
  remainingBytes: string | null;
  /** Vrai uniquement pour le revendeur connecté explicitement illimité. */
  unlimited: boolean;
  resellerCount: number;
  limitedResellers: number;
  unlimitedResellers: number;
}

export interface DashboardStats {
  /**
   * Nombre de COMPTES ouverts. Ce n'est pas un nombre de personnes en ligne :
   * la carte « CONNECTÉS » affichait cette valeur, d'où un parc de 82 comptes
   * présenté comme 82 utilisateurs en train de se servir du VPN.
   */
  activeAccounts?: number;
  /** Alias historique de `activeAccounts`, conservé pour compatibilité. */
  activeUsers: number;
  /**
   * Connexions RÉELLEMENT observées à l'instant. `null` signifie « non
   * mesuré » — jamais « personne n'est connecté » : les deux doivent rester
   * distinguables à l'écran.
   */
  connectedNow?: number | null;
  /**
   * Connectés issus d'un essai gratuit, comptés à part.
   *
   * `connectedNow` ne compte que les connexions COMMERCIALES. Sur un parc
   * surtout composé d'essais, ce seul nombre laissait un « 0 » à l'écran
   * pendant que des dizaines de personnes étaient en ligne.
   */
  connectedTrials?: number | null;
  connectedNowMeasured?: boolean;
  /** Dernier battement reçu, tous appareils confondus. `null` si aucun. */
  lastPresenceSignalAt?: string | null;
  /**
   * Vrai quand les essais gratuits ont été retranchés de ces indicateurs.
   *
   * Ils y étaient additionnés, ce qui gonflait comptes, trafic et connexions
   * avec des accès offerts. Ils ont désormais leurs propres compteurs dans
   * « Essais gratuits ». Le drapeau permet à l'écran de l'annoncer au lieu de
   * laisser lire un total.
   */
  freeTrialExcluded?: boolean;
  /** Nombre de comptes d'essai retranchés, à titre indicatif. */
  freeTrialAccountsExcluded?: number;
  /** Fenêtre au-delà de laquelle un silence cesse de valoir présence. */
  presenceWindowMinutes?: number;
  presenceHeartbeatMinutes?: number;
  expiredAccounts: number;
  consumedTraffic: number;
  provisionedTraffic: number;
  remainingTraffic: number;
  consumedTrafficBytes?: string;
  provisionedTrafficBytes?: string;
  /** « own » : les chiffres ne portent que sur les clients du revendeur. */
  quotaScope?: "own" | "platform";
  /** Faux pour un administrateur : son compte ne porte aucun quota. */
  hasPersonalQuota?: boolean;
  personalQuota?: { attribue: string; alloue: string; illimite: boolean } | null;
  /** Validité + plafond du revendeur connecté, même contrat que les refus. */
  resellerAccess?: ResellerAccessSummary | null;
  /** Enveloppes attribuées aux revendeurs, jamais un agrégat des clients. */
  resellerQuota?: DashboardResellerQuota | null;
  activeServers: number;
  activeResellers: number;
  totalRevenue: number;
}

export async function fetchDashboardStats(): Promise<DashboardStats | null> {
  try {
    return await apiRequest<DashboardStats>("/dashboard/stats");
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    return null;
  }
}

export async function fetchTrafficAnalytics(): Promise<TrafficDataPoint[]> {
  try {
    return await apiRequest<TrafficDataPoint[]>("/dashboard/traffic");
  } catch (error) {
    console.error("Error fetching traffic analytics:", error);
    return [];
  }
}

export async function fetchUserAnalytics(): Promise<UserDataPoint[]> {
  try {
    return await apiRequest<UserDataPoint[]>("/dashboard/users");
  } catch (error) {
    console.error("Error fetching user analytics:", error);
    return [];
  }
}

export async function fetchActivityLogs(): Promise<ActivityLog[]> {
  try {
    const data = await apiRequest<{ logs: ActivityLog[] }>("/audit-logs?limit=50");
    return data.logs || [];
  } catch (error) {
    console.error("Error fetching activity logs:", error);
    return [];
  }
}
