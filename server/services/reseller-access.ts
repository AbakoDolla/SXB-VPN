/**
 * Accès revendeur — couche branchée sur la base et middlewares Express.
 *
 * Les calculs purs (états, résumés, portée, propriété) vivent dans
 * `reseller-state.ts` : ils sont testables sans base ni client Prisma. Ce
 * module les réexporte afin que les routes n'aient qu'un seul point d'entrée.
 */
import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { prisma, inMemoryDb } from "../database";
import { calculerAllocation, estIllimite } from "./reseller-quota";
import {
  CODES_REVENDEUR,
  RefusRevendeur,
  refusPourEtatAcces,
  refusPourQuotaAtteint,
  resumerAccesRevendeur,
} from "./reseller-state";

export * from "./reseller-state";

/** Charge la fiche revendeur d'un utilisateur (null si le compte n'en a pas). */
export async function chargerFicheRevendeur(db: any, userId: string | undefined | null): Promise<any | null> {
  if (!userId) return null;
  if (!db) {
    // Mode mémoire : même contrat, la fiche est reconstituée avec son porteur.
    const fiche = (inMemoryDb as any).resellers?.find((r: any) => r.userId === userId);
    if (!fiche) return null;
    const user = (inMemoryDb as any).users?.find((u: any) => u.id === userId);
    return { ...fiche, user };
  }
  return db.reseller.findUnique({ where: { userId }, include: { user: true } });
}

/** Résout le revendeur propriétaire d'un client, explicite puis historique. */
export async function chargerFicheProprietaireClient(db: any, client: any): Promise<any | null> {
  if (!client) return null;
  if (!db) {
    if (client.resellerId) {
      const fiche = (inMemoryDb as any).resellers?.find((r: any) => r.id === client.resellerId);
      if (fiche) {
        const user = (inMemoryDb as any).users?.find((u: any) => u.id === fiche.userId);
        return { ...fiche, user };
      }
    }
    return chargerFicheRevendeur(null, client.userId);
  }
  if (client.resellerId) {
    return db.reseller.findUnique({
      where: { id: client.resellerId },
      include: { user: true },
    });
  }
  return chargerFicheRevendeur(db, client.userId);
}

/** Refuse une augmentation sous un agrément propriétaire expiré/suspendu. */
export async function refusAccesProprietaireClient(db: any, client: any): Promise<RefusRevendeur | null> {
  const fiche = await chargerFicheProprietaireClient(db, client);
  return fiche ? refusPourEtatAcces(resumerAccesRevendeur(fiche)) : null;
}

/**
 * Garde centrale des mutations revendeur.
 *
 * Posée sur une route, elle refuse toute écriture d'un revendeur expiré ou
 * suspendu, et attache `req.reseller` pour éviter aux routes de recharger la
 * fiche. Les rôles supérieurs ne portent aucune validité : ils passent.
 *
 * `autoriserReduction: true` marque les routes qui RÉDUISENT l'exposition
 * (suspension, révocation, suppression). Elles restent ouvertes quand le
 * plafond est atteint — c'est précisément par elles qu'on en sort — mais pas
 * quand l'accès est expiré ou suspendu.
 */
export function exigerAccesRevendeur(options: { autoriserReduction?: boolean } = {}) {
  return async function garde(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (req.user?.role !== "RESELLER") return next();
    try {
      const fiche = await chargerFicheRevendeur(prisma, req.user.userId);
      if (!fiche) {
        // Le garde-fou d'authentification rétrograde déjà un RESELLER sans fiche
        // en CLIENT ; si on arrive ici, la fiche a disparu entre-temps.
        return res.status(403).json({
          error: "errors.resellers.not_found",
          code: CODES_REVENDEUR.ACCOUNT_REQUIRED,
          message: "Aucune fiche revendeur associée à ce compte.",
        });
      }
      const resume = resumerAccesRevendeur(fiche);
      const refus = refusPourEtatAcces(resume);
      if (refus) return res.status(refus.status).json(refus.body);
      (req as any).reseller = fiche;
      (req as any).resellerAccess = resume;
      (req as any).resellerReducesExposure = options.autoriserReduction === true;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Plafond métier des rôles, indépendant du RBAC configurable.
 *
 * Le rôle SUPPORT porte en production des permissions héritées
 * (`clients.edit`, et selon les instances davantage) qui lui ouvriraient la
 * propriété commerciale, les quotas et les forfaits. Une permission mal
 * cochée ne doit pas suffire à changer qui possède quoi : le plafond est
 * fermé ici, en dur, et une permission obsolète ne le rouvre pas.
 */
export function interdireMutationSupport() {
  return function garde(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (req.user?.role !== "SUPPORT") return next();
    return res.status(403).json({
      error: "errors.auth.forbidden",
      code: CODES_REVENDEUR.SUPPORT_READ_ONLY,
      message: "Le rôle SUPPORT est en lecture seule sur ce domaine.",
    });
  };
}

/**
 * Garde de plafond pour une action qui AUGMENTE l'engagement.
 * Renvoie un refus structuré quand le plafond est déjà atteint ; les rôles
 * sans quota et les revendeurs illimités passent sans requête supplémentaire.
 */
export async function refusSiPlafondAtteint(
  db: any,
  params: { role?: string; userId?: string; fiche?: any }
): Promise<RefusRevendeur | null> {
  if (!db || (params.role !== "RESELLER" && !params.fiche) || (!params.userId && !params.fiche?.userId)) return null;
  const fiche = params.fiche ?? (await chargerFicheRevendeur(db, params.userId));
  if (!fiche) {
    return {
      status: 403,
      body: {
        error: "errors.resellers.not_found",
        code: CODES_REVENDEUR.ACCOUNT_REQUIRED,
        message: "Aucune fiche revendeur : impossible d'engager du quota.",
      },
    };
  }
  const plafond = BigInt(fiche.quotaBytes ?? 0);
  if (estIllimite(plafond)) return null;
  const { alloue } = await calculerAllocation(db, fiche);
  return refusPourQuotaAtteint(resumerAccesRevendeur(fiche, alloue));
}

/** Réponse unifiée lorsqu'une transaction rejette pour dépassement de plafond. */
export function reponsePlafondDepasse(alloueBytes?: bigint | number, plafondBytes?: bigint | number) {
  return {
    error: "errors.resellers.quota_exceeded",
    code: CODES_REVENDEUR.QUOTA_REACHED,
    message: "Plafond de quota atteint — cette opération dépasserait le volume attribué.",
    allocatedBytes: alloueBytes === undefined ? undefined : BigInt(alloueBytes).toString(),
    quotaBytes: plafondBytes === undefined ? undefined : BigInt(plafondBytes).toString(),
  };
}
