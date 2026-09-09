/**
 * Décision d'activation d'un appareil mobile — fonction pure, testable.
 *
 * DÉFAUT CORRIGÉ : la route d'activation répondait 403 pour quatre situations
 * sans rapport entre elles (compte suspendu, jeton périmé, jeton déjà lié à un
 * autre appareil, revendeur hors service). Le mobile, ne pouvant les
 * distinguer, affichait « expiré » dans tous les cas — y compris pour un jeton
 * créé la minute d'avant. L'exploitant renouvelait alors un accès valide et le
 * problème réapparaissait.
 *
 * CAUSE RACINE du 403 sur jeton frais : `/api/devices/generate-token` inscrit
 * un `deviceId` au moment de la CRÉATION, à partir de l'identifiant saisi au
 * tableau de bord. Le téléphone, lui, présente l'identifiant qu'il calcule
 * lui-même. Les deux diffèrent presque toujours, et la comparaison
 * « déjà lié à un autre appareil » rejetait la toute première activation.
 *
 * Distinction retenue : un `deviceId` PRÉ-ASSIGNÉ (aucun `activatedAt`) est
 * une intention d'affectation, pas un lien. Le premier appareil qui active
 * réellement le jeton s'y substitue. Une fois `activatedAt` posé, le lien est
 * ferme et tout autre appareil reçoit un 409 explicite.
 *
 * Aucune comparaison de chaînes de dates : uniquement des `Date`.
 */
import { calculerEtatAcces, estDateDepassee } from "./reseller-state";

export const CODES_ACTIVATION = {
  TOKEN_NOT_FOUND: "TOKEN_NOT_FOUND",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_USED: "TOKEN_USED",
  DEVICE_BOUND: "DEVICE_BOUND",
  DEVICE_CLAIMED: "DEVICE_CLAIMED_BY_ANOTHER_ACCOUNT",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  RESELLER_EXPIRED: "RESELLER_EXPIRED",
  RESELLER_SUSPENDED: "RESELLER_SUSPENDED",
  CLIENT_MISCONFIGURED: "CLIENT_MISCONFIGURED",
} as const;

export type ActionActivation = "bind" | "rebind" | "already_bound" | "no_device" | "refused";

/**
 * Décision unique, sans union discriminée : la configuration TypeScript du
 * dépôt n'active pas `strict`, et le rétrécissement par `ok` n'y est pas
 * fiable. Un objet plat se lit de la même façon partout et se teste sans
 * gymnastique de types.
 */
export type DecisionActivation = {
  ok: boolean;
  /** Code HTTP à renvoyer : 200 quand la décision est favorable. */
  status: number;
  /** Code métier stable ; "OK" quand la décision est favorable. */
  code: string;
  error: string | null;
  message: string | null;
  action: ActionActivation;
  /** true quand rien n'est à écrire : même jeton, même appareil. */
  idempotent: boolean;
  deviceId: string | null;
};

const STATUTS_BLOQUANTS = new Set(["suspended", "revoked", "disabled", "blocked", "deleted"]);

function refus(status: number, code: string, error: string, message: string): DecisionActivation {
  return { ok: false, status, code, error, message, action: "refused", idempotent: false, deviceId: null };
}

function accord(action: ActionActivation, idempotent: boolean, deviceId: string | null): DecisionActivation {
  return { ok: true, status: 200, code: "OK", error: null, message: null, action, idempotent, deviceId };
}

export function evaluerActivation(params: {
  client: any;
  deviceId?: string | null;
  reseller?: any | null;
  maintenant?: Date;
}): DecisionActivation {
  const { client, reseller } = params;
  const maintenant = params.maintenant ?? new Date();
  const deviceId = params.deviceId ? String(params.deviceId).trim() : "";

  if (!client) {
    return refus(404, CODES_ACTIVATION.TOKEN_NOT_FOUND, "errors.mobile.token_not_found", "Token de compte introuvable");
  }

  const statut = String(client.status || "active").toLowerCase();

  if (statut === "used") {
    return refus(409, CODES_ACTIVATION.TOKEN_USED, "errors.mobile.token_used", "Ce token a déjà été consommé");
  }

  if (STATUTS_BLOQUANTS.has(statut) || (client.user?.status && client.user.status !== "active")) {
    return refus(
      403,
      CODES_ACTIVATION.ACCOUNT_SUSPENDED,
      "errors.mobile.account_blocked",
      "Ce compte VPN est suspendu, révoqué ou désactivé"
    );
  }

  // Validité du revendeur propriétaire : elle conditionne l'activation de ses
  // appareils, jamais la lecture d'un état déjà acquis.
  if (reseller) {
    const etat = calculerEtatAcces(reseller, maintenant);
    if (etat === "expired") {
      return refus(
        403,
        CODES_ACTIVATION.RESELLER_EXPIRED,
        "errors.resellers.access_expired",
        "Accès expiré — veuillez renouveler"
      );
    }
    if (etat === "suspended") {
      return refus(
        403,
        CODES_ACTIVATION.RESELLER_SUSPENDED,
        "errors.resellers.suspended",
        "Accès revendeur suspendu — contactez l'administrateur"
      );
    }
  }

  // 410 GONE : réservé à une échéance RÉELLEMENT dépassée. C'est le seul cas
  // où le mobile doit afficher « expiré ».
  if (statut === "expired" || estDateDepassee(client.expireAt, maintenant)) {
    return refus(410, CODES_ACTIVATION.TOKEN_EXPIRED, "errors.mobile.token_expired", "Ce token d'activation a expiré");
  }

  if (!client.user) {
    return refus(500, CODES_ACTIVATION.CLIENT_MISCONFIGURED, "errors.server", "Compte client mal configuré");
  }

  if (!deviceId) {
    return accord("no_device", true, null);
  }

  const lie = client.deviceId ? String(client.deviceId).trim() : "";

  if (lie === deviceId) {
    // Rejouer l'activation avec le même couple jeton/appareil est sans effet :
    // le mobile réessaie après une coupure réseau, il ne doit pas être puni.
    // Si `activatedAt` est encore nul, il s'agit toutefois de la toute
    // première confirmation de la pré-affectation et elle doit être persistée.
    return accord("already_bound", !!client.activatedAt, deviceId);
  }

  if (lie && client.activatedAt) {
    return refus(409, CODES_ACTIVATION.DEVICE_BOUND, "errors.mobile.device_bound", "Ce token est déjà lié à un autre appareil");
  }

  // `lie` non vide sans `activatedAt` = pré-affectation faite au tableau de
  // bord ; la première activation réelle la remplace.
  return accord(lie ? "rebind" : "bind", false, deviceId);
}
