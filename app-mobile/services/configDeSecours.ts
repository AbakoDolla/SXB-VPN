/**
 * configDeSecours.ts — Vers quelle autre configuration se tourner ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE MANQUE CORRIGÉ
 * ═══════════════════════════════════════════════════════════════════════════
 * L'application sait déjà garder plusieurs configurations (jusqu'à quatre
 * venues du serveur) et passer de l'une à l'autre. Mais quand la connexion
 * ÉCHOUAIT — délai dépassé, moteur en erreur, configuration illisible —
 * l'accueil ne proposait rien : le bandeau « Sortie de secours » ne paraissait
 * que pour un accès retiré ou suspendu. L'utilisateur qui détenait un second
 * forfait parfaitement valable devait deviner qu'il pouvait ouvrir le
 * sélecteur et essayer celui-là.
 *
 * Ce module décide, sans rien connaître de React ni du natif :
 *   1. quelle configuration proposer — une seule, et seulement si elle MÈNE
 *      quelque part ;
 *   2. quelles configurations viennent d'échouer, pour ne jamais reproposer
 *      celle qu'on vient d'essayer ;
 *   3. quand lancer la connexion après une bascule demandée depuis le bandeau.
 *
 * Une configuration à la fois, toujours : on bascule PUIS on connecte. Jamais
 * deux tunnels en parallèle.
 */
import { profilEpuiseOuExpire } from './activeProfile';

/**
 * États qui rendent une configuration inutilisable.
 *
 * Servent à ne proposer un changement que s'il MÈNE quelque part : suggérer
 * une configuration elle aussi retirée ferait recommencer l'utilisateur pour
 * rien. `deleted` est le cas le plus courant — le forfait a disparu de
 * l'inventaire du serveur alors que l'appareil en garde la trace.
 */
export const ETATS_BLOQUANTS: ReadonlySet<string> = new Set(['deleted', 'revoked', 'suspended', 'expired', 'exhausted']);

/** Ce que l'accueil sait d'une configuration stockée sur l'appareil. */
export interface ConfigCandidate {
  id: string;
  isActive: boolean;
  status?: string;
  expiryDate?: string | null;
  /** Identité d'abonnement du registre, lue seulement (voir `forfaitDeLaConfig`). */
  subscriptionId?: string;
  source?: 'backend' | 'manual';
}

/**
 * Ce que le serveur dit d'un forfait (`/mobile/connections`) : `id` est
 * l'identifiant du FORFAIT, pas forcément celui de la configuration.
 */
export interface ConnexionServeur {
  id: string;
  status?: string;
  expiresAt?: string | null;
  providerExpired?: boolean;
}

/**
 * Le forfait serveur dont une configuration tire ses droits, ou `null`.
 *
 * Même identité que le compteur de consommation : le forfait porté par la
 * configuration, sinon son propre identifiant si elle vient du tableau de
 * bord. Un ALIAS local — configuration dont l'identifiant diffère de celui de
 * son forfait — lit donc l'état de SON forfait. Une configuration manuelle
 * non liée n'en a aucun : elle n'hérite pas d'une entrée serveur qui
 * porterait son identifiant par hasard.
 *
 * Lecture seule : rien n'est réécrit, et la sélection se fait toujours par
 * `id`.
 */
export function forfaitDeLaConfig(config: Pick<ConfigCandidate, 'id' | 'subscriptionId' | 'source'>): string | null {
  return config.subscriptionId || (config.source === 'backend' ? config.id : null);
}

/**
 * La configuration à proposer, ou `undefined` quand aucune ne convient.
 *
 * `undefined` fait disparaître le bandeau : mieux vaut se taire que promener
 * l'utilisateur d'un échec à l'autre. Sont écartées, dans l'ordre :
 *   - la configuration active — basculer sur soi-même n'apprendrait rien ;
 *   - celles qui viennent d'échouer pendant cet épisode ;
 *   - un état bloquant, qu'il vienne de l'appareil OU du serveur : l'état
 *     local peut dater de la dernière synchronisation ;
 *   - une échéance passée. Le registre local la connaît hors ligne ; le
 *     serveur la connaît plus fraîche. L'une OU l'autre suffit à écarter,
 *     avec la même règle que le choix du profil actif (`activeProfile.ts`) ;
 *   - un compte fournisseur arrivé à échéance : le serveur continue de dire
 *     le forfait « actif », mais le compte acheté chez le fournisseur n'ouvre
 *     plus rien. Le proposer, ce serait activer à coup sûr un échec.
 *
 * Ce que dit le serveur se lit sur le forfait de la configuration
 * (`forfaitDeLaConfig`), alias compris.
 *
 * L'ordre du registre est conservé : c'est celui que l'utilisateur voit dans
 * le sélecteur, la suggestion reste donc prévisible.
 */
export function choisirConfigDeSecours<T extends ConfigCandidate>(
  configs: ReadonlyArray<T>,
  options: {
    connexions?: ReadonlyArray<ConnexionServeur>;
    dejaEssayees?: ReadonlyArray<string>;
    maintenant?: Date;
  } = {},
): T | undefined {
  const maintenant = options.maintenant ?? new Date();
  const essayees = new Set(options.dejaEssayees ?? []);
  const serveur = new Map((options.connexions ?? []).map((c) => [c.id, c] as const));
  return configs.find((config) => {
    if (config.isActive || essayees.has(config.id)) return false;
    if (ETATS_BLOQUANTS.has(String(config.status ?? 'active'))) return false;
    if (profilEpuiseOuExpire({ expiryDate: config.expiryDate }, maintenant)) return false;
    const forfait = forfaitDeLaConfig(config);
    const distante = forfait ? serveur.get(forfait) : undefined;
    if (!distante) return true;
    if (ETATS_BLOQUANTS.has(String(distante.status ?? 'active'))) return false;
    if (distante.providerExpired === true) return false;
    return !profilEpuiseOuExpire({ expiryDate: distante.expiresAt }, maintenant);
  });
}

/**
 * Tient la liste des configurations qui viennent d'échouer.
 *
 * Seul le PASSAGE à `error` compte : l'état y reste tant que rien ne se
 * passe, et chaque rendu ne doit pas recompter le même échec. La liste se vide
 * dès qu'une connexion aboutit — l'épisode est clos, un échec ancien ne doit
 * pas écarter indéfiniment une configuration qui a pu revenir.
 *
 * Renvoie la MÊME liste quand rien ne change : React n'a alors rien à
 * redessiner.
 */
export function suivreEchecs(
  echouees: ReadonlyArray<string>,
  evenement: { avant: string; apres: string; configId: string | null; connecte: boolean },
): ReadonlyArray<string> {
  if (evenement.connecte) return echouees.length === 0 ? echouees : [];
  const nouvelEchec = evenement.apres === 'error' && evenement.avant !== 'error';
  if (!nouvelEchec || !evenement.configId || echouees.includes(evenement.configId)) return echouees;
  return [...echouees, evenement.configId];
}

/**
 * Que faire d'une connexion demandée « après la bascule » ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI ATTENDRE LE RENDU SUIVANT
 * ═══════════════════════════════════════════════════════════════════════════
 * Appeler `connect()` juste après `switchConfig()` lirait la fermeture React
 * capturée AVANT la bascule — donc l'ancienne configuration. La demande est
 * posée une fois la bascule rendue, puis honorée ici au rendu où la nouvelle
 * configuration est déjà active.
 *
 *   - `rien`       : aucune demande en attente ;
 *   - `attendre`   : la bascule n'est pas finie ;
 *   - `abandonner` : la bascule a échoué (l'ancienne configuration est restée
 *                    active) ou une connexion est déjà en route — en lancer
 *                    une seconde reviendrait à doubler le tunnel ;
 *   - `connecter`  : la cible est active et rien ne tourne.
 */
export type SuiteBascule = 'rien' | 'attendre' | 'abandonner' | 'connecter';

export function suiteApresBascule(etat: {
  cible: string | null;
  basculeEnCours: boolean;
  activeConfigId: string | null;
  connecte: boolean;
  enConnexion: boolean;
}): SuiteBascule {
  if (!etat.cible) return 'rien';
  if (etat.basculeEnCours) return 'attendre';
  if (etat.activeConfigId !== etat.cible || etat.connecte || etat.enConnexion) return 'abandonner';
  return 'connecter';
}
