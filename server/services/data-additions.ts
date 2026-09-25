/**
 * « Données ajoutées » — l'historique des Go ajoutés aux connexions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI L'ENREGISTREMENT VIT ICI, ET NON DANS CHAQUE ROUTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Un forfait reçoit du volume par sept chemins : création unitaire, PUT,
 * déploiement groupé, `set`, `add_data`, `apply`, et les gestes d'essai gratuit.
 * Écrire la trace dans chacun garantissait qu'un chemin l'oublierait — et un
 * ajout sans trace est exactement ce que l'exploitant ne veut plus voir.
 *
 * Tous ces chemins passent déjà par `executerMutationQuota`, qui ouvre la
 * transaction. C'est donc là que le délégué `subscription` est observé : le
 * quota de chaque forfait est lu AVANT sa première écriture, relu à la fin, et
 * toute hausse devient une ligne d'historique DANS LA MÊME TRANSACTION. Un
 * ajout annulé (plafond dépassé, erreur) n'a donc jamais de trace, et une
 * trace ne peut pas exister sans l'ajout qu'elle décrit.
 *
 * Un nouveau chemin d'ajout, écrit demain, sera consigné sans qu'on y pense.
 */
import type { AuteurQuota } from "./reseller-quota";

/** Volume initial d'un forfait, ou hausse d'un forfait qui existait déjà. */
export type NatureAjout = "creation" | "ajout";

export interface JournalAjouts {
  /** Transaction à transmettre à la mutation : c'est elle qui est observée. */
  tx: any;
  /** Écrit les lignes d'historique. À appeler une fois la mutation acceptée. */
  consigner(): Promise<void>;
}

const INACTIF = (tx: any): JournalAjouts => ({ tx, consigner: async () => {} });

function octets(valeur: unknown): bigint {
  if (typeof valeur === "bigint") return valeur;
  if (typeof valeur === "number" && Number.isFinite(valeur)) return BigInt(Math.trunc(valeur));
  if (typeof valeur === "string" && /^-?\d+$/.test(valeur.trim())) return BigInt(valeur.trim());
  return BigInt(0);
}

async function nomActeur(tx: any, auteur: AuteurQuota): Promise<string> {
  const direct = auteur.name?.trim();
  if (direct) return direct;
  if (auteur.userId && tx?.user?.findUnique) {
    try {
      const compte = await tx.user.findUnique({ where: { id: auteur.userId }, select: { name: true, email: true } });
      const nom = compte?.name?.trim() || compte?.email?.trim();
      if (nom) return nom;
    } catch { /* le nom est un confort d'affichage : il ne bloque jamais l'ajout */ }
  }
  return auteur.email?.trim() || "Système";
}

/**
 * Observe les écritures de forfaits d'une transaction.
 *
 * Sans délégué `dataAddition` (base qui ne connaît pas encore la table, bancs
 * d'essai minimaux), le journal s'efface : la mutation s'exécute exactement
 * comme avant. Rien, ici, ne peut empêcher un ajout de Go d'aboutir.
 */
export function journaliserAjouts(tx: any, contexte: { auteur: AuteurQuota }): JournalAjouts {
  const delegue = tx?.subscription;
  if (!delegue || typeof delegue.findMany !== "function" || typeof tx?.dataAddition?.create !== "function") {
    return INACTIF(tx);
  }

  // Quota connu AVANT la première écriture de la transaction. Un forfait
  // modifié deux fois dans la même transaction garde son point de départ réel.
  const avant = new Map<string, bigint>();
  const crees = new Set<string>();
  const touches = new Set<string>();

  const noterExistants = async (where: unknown) => {
    const lignes = await delegue.findMany({ where: where ?? {}, select: { id: true, quotaBytes: true } });
    for (const ligne of lignes as Array<{ id: string; quotaBytes: unknown }>) {
      touches.add(ligne.id);
      if (!avant.has(ligne.id)) avant.set(ligne.id, octets(ligne.quotaBytes));
    }
  };
  const noterEcrit = (ligne: any) => {
    const id = typeof ligne?.id === "string" ? ligne.id : null;
    if (!id) return;
    touches.add(id);
    if (!avant.has(id)) {
      avant.set(id, BigInt(0));
      crees.add(id);
    }
  };

  const subscription = new Proxy(delegue, {
    get(cible, propriete) {
      const valeur = Reflect.get(cible, propriete);
      if (typeof valeur !== "function") return valeur;
      if (propriete === "create") {
        return async (args: any) => {
          const ligne = await valeur.call(cible, args);
          noterEcrit(ligne);
          return ligne;
        };
      }
      if (propriete === "update" || propriete === "upsert") {
        return async (args: any) => {
          await noterExistants(args?.where);
          const ligne = await valeur.call(cible, args);
          noterEcrit(ligne);
          return ligne;
        };
      }
      if (propriete === "updateMany") {
        return async (args: any) => {
          await noterExistants(args?.where);
          return valeur.call(cible, args);
        };
      }
      return valeur.bind(cible);
    },
  });

  const observe = new Proxy(tx, {
    get(cible, propriete) {
      if (propriete === "subscription") return subscription;
      const valeur = Reflect.get(cible, propriete);
      return typeof valeur === "function" ? valeur.bind(cible) : valeur;
    },
  });

  return {
    tx: observe,
    async consigner() {
      if (touches.size === 0) return;
      const lignes = await delegue.findMany({
        where: { id: { in: [...touches] } },
        select: {
          id: true, name: true, profileId: true, clientId: true, quotaBytes: true, freeTrialRequestId: true,
          profile: { select: { name: true } },
          client: { select: { user: { select: { name: true, email: true } } } },
        },
      });
      const ajouts: Array<Record<string, unknown>> = [];
      for (const ligne of lignes as any[]) {
        const apres = octets(ligne.quotaBytes);
        const initial = avant.get(ligne.id) ?? BigInt(0);
        // Un volume illimité (valeur négative) n'a pas d'écart mesurable : le
        // consigner inventerait un « ajout » qui n'a pas eu lieu.
        if (apres < BigInt(0) || initial < BigInt(0)) continue;
        const ajoute = apres - initial;
        if (ajoute <= BigInt(0)) continue;
        ajouts.push({
          subscriptionId: ligne.id,
          subscriptionName: String(ligne.name ?? "").slice(0, 200),
          profileId: String(ligne.profileId ?? ""),
          profileName: String(ligne.profile?.name ?? "").slice(0, 200),
          clientId: String(ligne.clientId ?? ""),
          clientName: String(ligne.client?.user?.name || ligne.client?.user?.email || "").slice(0, 200),
          kind: (crees.has(ligne.id) ? "creation" : "ajout") satisfies NatureAjout,
          addedBytes: ajoute,
          quotaBeforeBytes: initial,
          quotaAfterBytes: apres,
          freeTrial: Boolean(ligne.freeTrialRequestId),
        });
      }
      if (ajouts.length === 0) return;
      const actorName = await nomActeur(tx, contexte.auteur);
      for (const ajout of ajouts) {
        await tx.dataAddition.create({
          data: { ...ajout, actorUserId: contexte.auteur.userId || null, actorName },
        });
      }
    },
  };
}

/** Ligne d'historique prête pour JSON : les octets restent des chaînes exactes. */
export function serialiserAjout(ligne: any) {
  return {
    id: ligne.id,
    subscriptionId: ligne.subscriptionId,
    subscriptionName: ligne.subscriptionName,
    profileId: ligne.profileId,
    profileName: ligne.profileName,
    clientId: ligne.clientId,
    clientName: ligne.clientName,
    actorName: ligne.actorName,
    kind: ligne.kind === "creation" ? "creation" : "ajout",
    addedBytes: octets(ligne.addedBytes).toString(),
    quotaBeforeBytes: octets(ligne.quotaBeforeBytes).toString(),
    quotaAfterBytes: octets(ligne.quotaAfterBytes).toString(),
    createdAt: ligne.createdAt instanceof Date ? ligne.createdAt.toISOString() : String(ligne.createdAt),
  };
}

export { octets as versOctets };
