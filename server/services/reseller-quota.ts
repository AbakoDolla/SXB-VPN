/**
 * Quota revendeur — sémantique unique et contrôles partagés.
 *
 * Historique du défaut corrigé ici : les gardes de quota testaient
 * `if (quotaLimit === 0n) return null`, c'est-à-dire « pas de quota saisi donc
 * aucune limite ». Comme la colonne `quotaBytes` vaut 0 par défaut, **aucun
 * revendeur n'a jamais été limité**, et un compte sans fiche revendeur du tout
 * passait également au travers. Un revendeur à 0 Go avait ainsi distribué 16 Go.
 *
 * Sémantique retenue, la seule qui donne un sens à « l'administrateur attribue
 * un quota » :
 *   - `quotaBytes > 0` → plafond exprimé en octets ;
 *   - `quotaBytes = 0` → aucune allocation possible, il faut d'abord recevoir
 *     un quota de l'administrateur ;
 *   - `quotaBytes < 0` → illimité, choix explicite de l'administrateur.
 */

export const QUOTA_ILLIMITE = BigInt(-1);

export type Allocation = { alloue: bigint; consomme: bigint };

/** Un plafond négatif signifie « illimité » ; 0 signifie « rien à distribuer ». */
export function estIllimite(quotaBytes: bigint | number | null | undefined): boolean {
  if (quotaBytes === null || quotaBytes === undefined) return false;
  return BigInt(quotaBytes) < BigInt(0);
}

/**
 * Somme ce qu'un revendeur a déjà engagé auprès de ses clients.
 *
 * Un forfait (`Subscription`) prime sur le quota porté par la fiche client,
 * exactement comme le fait `selectDeviceSubscription()` côté appareil : sans
 * cette règle, un client doté des deux serait compté deux fois. Les forfaits
 * révoqués sont relâchés — le revendeur récupère le volume correspondant.
 */
export async function calculerAllocation(
  prisma: any,
  userId: string,
  options: { exclureSubscriptionId?: string; exclureClientId?: string } = {}
): Promise<Allocation> {
  const clients = await prisma.vpnClient.findMany({
    where: { userId },
    select: {
      id: true,
      quotaTotal: true,
      quotaUsed: true,
      subscriptions: { select: { id: true, quotaBytes: true, quotaUsed: true, status: true } },
    },
  });

  let alloue = BigInt(0);
  let consomme = BigInt(0);
  for (const client of clients) {
    if (options.exclureClientId && client.id === options.exclureClientId) continue;
    const forfaits = (client.subscriptions || []).filter(
      (s: any) => s.status !== "revoked" && s.id !== options.exclureSubscriptionId
    );
    if (forfaits.length > 0) {
      for (const forfait of forfaits) {
        alloue += BigInt(forfait.quotaBytes ?? 0);
        consomme += BigInt(forfait.quotaUsed ?? 0);
      }
    } else {
      alloue += BigInt(client.quotaTotal ?? 0);
      consomme += BigInt(client.quotaUsed ?? 0);
    }
  }
  return { alloue, consomme };
}

export type RefusQuota = { status: number; body: { error: string; message: string } };

/**
 * Autorise ou refuse une nouvelle allocation pour le revendeur authentifié.
 *
 * Ne s'applique qu'au rôle RESELLER : administrateurs et super-administrateurs
 * ne portent aucun quota et ne sont donc jamais contraints ici.
 *
 * @param demande volume que le revendeur veut engager en plus
 */
export async function verifierAllocation(
  prisma: any,
  params: {
    role?: string;
    userId?: string;
    demande: bigint;
    exclureSubscriptionId?: string;
    exclureClientId?: string;
  }
): Promise<RefusQuota | null> {
  if (params.role !== "RESELLER" || !prisma || !params.userId) return null;

  const fiche = await prisma.reseller.findUnique({ where: { userId: params.userId } });
  // Absence de fiche : le compte n'est pas un revendeur reconnu. Refuser plutôt
  // que de laisser passer, ce que faisait `reseller?.quotaBytes ?? 0n`.
  if (!fiche) {
    return {
      status: 403,
      body: {
        error: "errors.resellers.not_found",
        message: "Aucune fiche revendeur : impossible d'attribuer du quota.",
      },
    };
  }

  const plafond = BigInt(fiche.quotaBytes ?? 0);
  if (estIllimite(plafond)) return null;

  const { alloue } = await calculerAllocation(prisma, params.userId, {
    exclureSubscriptionId: params.exclureSubscriptionId,
    exclureClientId: params.exclureClientId,
  });
  const projete = alloue + params.demande;
  if (projete > plafond) {
    const enGo = (v: bigint) => (Number(v) / 1024 ** 3).toFixed(2);
    return {
      status: 409,
      body: {
        error: "errors.resellers.quota_exceeded",
        message:
          plafond === BigInt(0)
            ? "Aucun quota ne vous a encore été attribué par l'administrateur."
            : `Quota revendeur insuffisant : ${enGo(alloue)} Go déjà engagés sur ${enGo(plafond)} Go attribués.`,
      },
    };
  }
  return null;
}

/** Rôles qui pilotent la plateforme : ils ne peuvent pas porter de quota. */
export const ROLES_SANS_QUOTA = ["OWNER", "SUPER_ADMIN", "ADMIN"];

export function porteUnQuotaInterdit(roleName: string | null | undefined): boolean {
  return !!roleName && ROLES_SANS_QUOTA.includes(roleName);
}
