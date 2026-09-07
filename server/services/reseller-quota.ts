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
export type TypeMouvementQuota =
  | "ADMIN_ALLOCATION"
  | "ADMIN_WITHDRAWAL"
  | "ADMIN_CORRECTION"
  | "QUOTA_COMMITMENT"
  | "QUOTA_RELEASE";

export type AuteurQuota = {
  userId?: string | null;
  name?: string | null;
  email?: string | null;
};

export class PlafondQuotaDepasse extends Error {
  readonly code = "RESELLER_QUOTA_EXCEEDED";
  readonly alloue: bigint;
  readonly plafond: bigint;

  constructor(alloue: bigint, plafond: bigint) {
    super("Le plafond du revendeur serait depasse.");
    this.alloue = alloue;
    this.plafond = plafond;
  }
}

export class AccesHistoriqueQuotaRefuse extends Error {
  readonly code = "RESELLER_QUOTA_HISTORY_FORBIDDEN";
}

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

function nomAuteur(auteur: AuteurQuota): string {
  return auteur.name?.trim() || auteur.email?.trim() || "Systeme";
}

function nomRevendeur(fiche: any): string {
  return fiche.user?.name?.trim() || fiche.user?.email?.trim() || "Revendeur";
}

async function verrouillerRevendeur(tx: any, userId: string): Promise<void> {
  if (typeof tx.$queryRawUnsafe === "function") {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "resellers" WHERE "userId" = $1 FOR UPDATE',
      userId
    );
  }
}

async function ajouterMouvement(tx: any, data: {
  fiche: any;
  auteur: AuteurQuota;
  kind: TypeMouvementQuota;
  reason: string;
  deltaBytes: bigint;
  quotaBeforeBytes: bigint;
  quotaAfterBytes: bigint;
  allocatedBeforeBytes: bigint;
  allocatedAfterBytes: bigint;
  referenceType?: string;
  referenceId?: string;
}) {
  return tx.resellerQuotaMovement.create({
    data: {
      resellerId: data.fiche.id,
      resellerUserId: data.fiche.userId,
      resellerName: nomRevendeur(data.fiche),
      actorUserId: data.auteur.userId || null,
      actorName: nomAuteur(data.auteur),
      kind: data.kind,
      reason: data.reason.trim(),
      deltaBytes: data.deltaBytes,
      quotaBeforeBytes: data.quotaBeforeBytes,
      quotaAfterBytes: data.quotaAfterBytes,
      allocatedBeforeBytes: data.allocatedBeforeBytes,
      allocatedAfterBytes: data.allocatedAfterBytes,
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
    },
  });
}

/**
 * Execute une mutation qui peut changer l'engagement d'un revendeur.
 * Mutation, controle, compteur materialise et audit partagent une transaction.
 */
export async function executerMutationQuota<T>(
  db: any,
  params: {
    resellerUserId: string;
    auteur: AuteurQuota;
    reason: string;
    referenceType?: string;
    referenceId?: string;
  },
  mutation: (tx: any) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx: any) => {
    let fiche = await tx.reseller.findUnique({
      where: { userId: params.resellerUserId },
      include: { user: true },
    });
    if (!fiche) return mutation(tx);

    await verrouillerRevendeur(tx, params.resellerUserId);
    fiche = await tx.reseller.findUnique({
      where: { userId: params.resellerUserId },
      include: { user: true },
    });

    const avant = await calculerAllocation(tx, params.resellerUserId);
    const resultat = await mutation(tx);
    const apres = await calculerAllocation(tx, params.resellerUserId);
    const plafond = BigInt(fiche.quotaBytes ?? 0);
    if (!estIllimite(plafond) && apres.alloue > plafond) {
      throw new PlafondQuotaDepasse(apres.alloue, plafond);
    }

    await tx.reseller.update({
      where: { id: fiche.id },
      data: { quotaUsedBytes: apres.alloue },
    });

    const delta = apres.alloue - avant.alloue;
    if (delta !== BigInt(0)) {
      await ajouterMouvement(tx, {
        fiche,
        auteur: params.auteur,
        kind: delta > BigInt(0) ? "QUOTA_COMMITMENT" : "QUOTA_RELEASE",
        reason: params.reason,
        deltaBytes: delta,
        quotaBeforeBytes: plafond,
        quotaAfterBytes: plafond,
        allocatedBeforeBytes: avant.alloue,
        allocatedAfterBytes: apres.alloue,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      });
    }
    return resultat;
  }, { isolationLevel: "Serializable" });
}

/** Modifie un plafond et ecrit le mouvement correspondant atomiquement. */
export async function modifierPlafondQuota(
  db: any,
  params: {
    resellerId: string;
    nouveauPlafond: bigint;
    auteur: AuteurQuota;
    reason: string;
    correction?: boolean;
  }
) {
  return db.$transaction(async (tx: any) => {
    let fiche = await tx.reseller.findUnique({
      where: { id: params.resellerId },
      include: { user: { include: { role: true } } },
    });
    if (!fiche) return null;

    await verrouillerRevendeur(tx, fiche.userId);
    fiche = await tx.reseller.findUnique({
      where: { id: params.resellerId },
      include: { user: { include: { role: true } } },
    });
    const avant = BigInt(fiche.quotaBytes ?? 0);
    const allocation = await calculerAllocation(tx, fiche.userId);
    if (!estIllimite(params.nouveauPlafond) && allocation.alloue > params.nouveauPlafond) {
      throw new PlafondQuotaDepasse(allocation.alloue, params.nouveauPlafond);
    }

    const updated = await tx.reseller.update({
      where: { id: params.resellerId },
      data: {
        quotaBytes: params.nouveauPlafond,
        quotaUsedBytes: allocation.alloue,
      },
      include: { user: true },
    });
    if (avant !== params.nouveauPlafond) {
      const kind: TypeMouvementQuota = params.correction
        ? "ADMIN_CORRECTION"
        : estIllimite(params.nouveauPlafond) || (!estIllimite(avant) && params.nouveauPlafond > avant)
          ? "ADMIN_ALLOCATION"
          : "ADMIN_WITHDRAWAL";
      await ajouterMouvement(tx, {
        fiche,
        auteur: params.auteur,
        kind,
        reason: params.reason,
        deltaBytes: estIllimite(avant) || estIllimite(params.nouveauPlafond)
          ? BigInt(0)
          : params.nouveauPlafond - avant,
        quotaBeforeBytes: avant,
        quotaAfterBytes: params.nouveauPlafond,
        allocatedBeforeBytes: allocation.alloue,
        allocatedAfterBytes: allocation.alloue,
        referenceType: "reseller",
        referenceId: fiche.id,
      });
    }
    return updated;
  }, { isolationLevel: "Serializable" });
}

export function porteeHistoriqueQuota(
  role: string | undefined,
  userId: string | undefined,
  resellerId?: string
): Record<string, unknown> {
  if (role === "RESELLER" && userId) return { resellerUserId: userId };
  if (["OWNER", "SUPER_ADMIN", "ADMIN"].includes(role || "")) {
    return resellerId ? { resellerId } : {};
  }
  throw new AccesHistoriqueQuotaRefuse("Acces a l'historique des quotas refuse.");
}

/** Tous les BigInt restent des chaines afin de preserver leur precision JSON. */
export function serialiserMouvementQuota(mouvement: any) {
  return {
    reseller: mouvement.resellerName,
    author: mouvement.actorName,
    kind: mouvement.kind,
    reason: mouvement.reason,
    deltaBytes: BigInt(mouvement.deltaBytes).toString(),
    quotaBeforeBytes: BigInt(mouvement.quotaBeforeBytes).toString(),
    quotaAfterBytes: BigInt(mouvement.quotaAfterBytes).toString(),
    allocatedBeforeBytes: BigInt(mouvement.allocatedBeforeBytes).toString(),
    allocatedAfterBytes: BigInt(mouvement.allocatedAfterBytes).toString(),
    referenceType: mouvement.referenceType,
    createdAt: mouvement.createdAt,
  };
}

export type RefusQuota = { status: number; body: { error: string; message: string } };

/**
 * Autorise ou refuse une allocation imputée au plafond d'un revendeur donné.
 *
 * Le contrôle porte sur le revendeur **destinataire**, quel que soit l'auteur
 * de l'appel : un administrateur qui crée un client sous un revendeur puise
 * dans le quota de ce revendeur, et doit donc être arrêté de la même façon.
 */
export async function verifierPlafond(
  prisma: any,
  userId: string,
  demande: bigint,
  options: { exclureSubscriptionId?: string; exclureClientId?: string } = {}
): Promise<RefusQuota | null> {
  const fiche = await prisma.reseller.findUnique({ where: { userId } });
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

  const { alloue } = await calculerAllocation(prisma, userId, options);
  const projete = alloue + demande;
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

/**
 * Variante réservée aux actions qu'un revendeur mène sur ses propres clients :
 * les autres rôles ne portent aucun quota et ne sont donc jamais contraints.
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
  return verifierPlafond(prisma, params.userId, params.demande, {
    exclureSubscriptionId: params.exclureSubscriptionId,
    exclureClientId: params.exclureClientId,
  });
}

/** Rôles qui pilotent la plateforme : ils ne peuvent pas porter de quota. */
export const ROLES_SANS_QUOTA = ["OWNER", "SUPER_ADMIN", "ADMIN"];

export function porteUnQuotaInterdit(roleName: string | null | undefined): boolean {
  return !!roleName && ROLES_SANS_QUOTA.includes(roleName);
}
