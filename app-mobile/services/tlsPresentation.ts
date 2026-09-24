/**
 * tlsPresentation.ts — ce que l'application MONTRE au réseau, et quoi faire
 * quand ce réseau le refuse.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ — une seule façon de se présenter
 * ═══════════════════════════════════════════════════════════════════════════
 * Symptôme rapporté : une configuration identique monte chez l'exploitant et
 * chez la plupart des clients, mais reste indéfiniment « en connexion » chez
 * certains — alors que la MÊME configuration fonctionne chez eux dans un autre
 * client (HTTP Custom, v2rayNG…).
 *
 * Ce n'est pas la configuration qui diffère : c'est la POIGNÉE DE MAIN.
 *
 * Avant le moindre octet utile, un équipement d'inspection ne voit que trois
 * choses du ClientHello TLS :
 *
 *   1. le NOM PRÉSENTÉ (SNI) — traité ailleurs, dans `vlessUri.ts` ;
 *   2. la LISTE ALPN — les protocoles applicatifs proposés ;
 *   3. l'EMPREINTE du ClientHello — l'ordre et la nature des extensions.
 *
 * Or notre moteur imposait deux valeurs que le profil n'avait jamais
 * demandées : une empreinte uTLS « chrome » dès que TLS est actif, et un ALPN
 * `http/1.1` sur les transports à Upgrade. Prises séparément, chacune corrige
 * un vrai défaut. Ensemble, elles produisent un ClientHello qui **se présente
 * comme Chrome tout en annonçant une liste ALPN que Chrome n'envoie jamais** —
 * Chrome propose toujours `h2` avant `http/1.1`. Cette incohérence est
 * exactement ce qu'un classificateur de flux retient.
 *
 * Un client ordinaire n'a pas ce problème : il n'usurpe aucune empreinte et
 * n'annonce aucun ALPN. C'est pourquoi il passe là où nous échouons.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PRINCIPE : NE JAMAIS RÉPÉTER CE QUI VIENT D'ÊTRE REFUSÉ
 * ═══════════════════════════════════════════════════════════════════════════
 * Le correctif ne consiste pas à choisir une autre valeur — il n'en existe
 * aucune qui convienne à tous les réseaux. Il consiste à ne plus dépendre d'un
 * seul choix : quand une présentation n'aboutit pas, l'application essaie la
 * suivante, seule, sans rien demander à l'utilisateur.
 *
 * L'échelle descend du plus SPÉCIFIQUE au plus BANAL :
 *
 *   0. `profil`          — ce que demande le profil (comportement actuel,
 *                          inchangé : personne qui fonctionne aujourd'hui ne
 *                          change de présentation) ;
 *   1. `sans_alpn`       — on cesse d'annoncer un ALPN que nous avons déduit ;
 *   2. `sans_empreinte`  — on cesse aussi d'usurper une empreinte : le moteur
 *                          présente alors son propre ClientHello, c'est-à-dire
 *                          exactement ce que font les clients qui passent ;
 *   3. `avec_fragment`   — le ClientHello passe toujours pour ce qu'il est,
 *                          mais on le fragmente au niveau de l'enregistrement
 *                          TLS (`record_fragment` côté moteur). Certaines
 *                          sondes n'inspectent que le premier segment TCP :
 *                          c'est le mécanisme que des clients comme HTTP
 *                          Injector exposent sous « Fragments de paquets », et
 *                          qui explique qu'un même profil y passe alors qu'il
 *                          reste bloqué chez nous après les trois premiers
 *                          échelons ;
 *   4. `avec_fragment_fort` — quand `record_fragment` seul ne suffit toujours
 *                          pas, on ajoute la segmentation TCP du ClientHello
 *                          lui-même (`fragment` côté moteur). C'est plus coûteux
 *                          en latence — la documentation officielle du moteur
 *                          réserve ce niveau aux réseaux qui filtrent encore
 *                          après `record_fragment` — mais les deux mécanismes
 *                          restent actifs ensemble à cet échelon, exactement
 *                          l'ordre que sing-box recommande.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CETTE ÉCHELLE NE FAIT JAMAIS
 * ═══════════════════════════════════════════════════════════════════════════
 * • Elle ne touche PAS un ALPN choisi par l'exploitant. Seule la valeur que
 *   nous avons nous-mêmes déduite (`http/1.1` sur un transport à Upgrade) peut
 *   être retirée — la retirer nous ramène au comportement d'un client
 *   ordinaire, jamais à un choix inventé.
 * • Elle ne DÉSACTIVE JAMAIS la vérification du certificat. D'autres clients
 *   posent `allowInsecure: true` par défaut ; le copier reviendrait à laisser
 *   l'opérateur — celui-là même dont on se protège — lire le tunnel. Un profil
 *   qui en a réellement besoin l'exprime avec `allowInsecure=1`.
 * • Elle ne s'applique pas à Reality, dont l'empreinte uTLS fait partie du
 *   protocole : la retirer ne produirait pas une autre présentation, mais un
 *   profil cassé.
 * • Elle ne change ni l'adresse jointe, ni le nom présenté, ni l'en-tête Host :
 *   ces trois valeurs viennent du profil et n'ont pas d'alternative.
 */

/** ALPN que la traduction déduit elle-même — voir `alpnPolicy.ts`. */
export const ALPN_DEDUIT = 'http/1.1';

/** Transports qui négocient par un Upgrade HTTP/1.1, et eux seuls. */
const TRANSPORTS_UPGRADE = new Set(['ws', 'websocket', 'httpupgrade', 'http-upgrade']);

/**
 * Valeur d'empreinte signifiant « n'usurpe rien ».
 *
 * Le moteur natif impose « chrome » dès que TLS est actif et qu'aucune
 * empreinte n'est demandée ; une chaîne vide ne suffit donc pas à exprimer le
 * refus. Ce marqueur, lui, est explicite et le natif le reconnaît.
 */
export const EMPREINTE_AUCUNE = 'none';

/** Les libellés de journal disponibles pour un échelon. */
export type LibellePresentation =
  | 'log_presentation_profil'
  | 'log_presentation_sans_alpn'
  | 'log_presentation_sans_empreinte'
  | 'log_presentation_fragment'
  | 'log_presentation_fragment_fort';

export interface PresentationTls {
  /** Identifiant stable, utilisé par les tests et les diagnostics. */
  readonly cle: string;
  /**
   * Clé de traduction affichée dans le journal — jamais une valeur technique.
   *
   * Le type est l'union littérale des trois clés existantes, et non `string` :
   * un libellé absent des traductions devient ainsi une erreur de compilation
   * plutôt qu'une ligne de journal vide sur le téléphone de l'utilisateur.
   */
  readonly libelle: LibellePresentation;
  /** Conserver l'ALPN que nous avons déduit ? */
  readonly alpnDeduit: boolean;
  /** Conserver l'empreinte uTLS ? */
  readonly empreinte: boolean;
  /** Fragmenter l'enregistrement TLS du ClientHello (`record_fragment`) ? */
  readonly fragment: boolean;
  /** Segmenter aussi le ClientHello au niveau TCP (`fragment`), en plus de `record_fragment` ? */
  readonly fragmentFort: boolean;
}

export const ECHELLE_TLS: readonly PresentationTls[] = Object.freeze([
  { cle: 'profil', libelle: 'log_presentation_profil', alpnDeduit: true, empreinte: true, fragment: false, fragmentFort: false },
  { cle: 'sans_alpn', libelle: 'log_presentation_sans_alpn', alpnDeduit: false, empreinte: true, fragment: false, fragmentFort: false },
  { cle: 'sans_empreinte', libelle: 'log_presentation_sans_empreinte', alpnDeduit: false, empreinte: false, fragment: false, fragmentFort: false },
  { cle: 'avec_fragment', libelle: 'log_presentation_fragment', alpnDeduit: false, empreinte: false, fragment: true, fragmentFort: false },
  { cle: 'avec_fragment_fort', libelle: 'log_presentation_fragment_fort', alpnDeduit: false, empreinte: false, fragment: true, fragmentFort: true },
]);

/** Dernier échelon atteignable. */
export const DERNIER_ESSAI = ECHELLE_TLS.length - 1;

function borner(essai: number): number {
  if (!Number.isFinite(essai)) return 0;
  const entier = Math.trunc(essai);
  if (entier < 0) return 0;
  return entier > DERNIER_ESSAI ? DERNIER_ESSAI : entier;
}

/** Présentation correspondant à un rang d'essai. Les rangs hors échelle sont bornés. */
export function presentationPourEssai(essai: number): PresentationTls {
  return ECHELLE_TLS[borner(essai)];
}

/**
 * L'échelle a-t-elle un sens pour cette configuration ?
 *
 * Elle n'en a un que si la présentation TLS est BIEN CE QUE NOUS AVONS CHOISI :
 * il faut donc TLS actif, un transport à Upgrade — les seuls pour lesquels nous
 * déduisons un ALPN — et l'absence de Reality, qui impose sa propre empreinte.
 */
export function echelleApplicable(config: Record<string, any> | null | undefined): boolean {
  if (!config || typeof config !== 'object') return false;
  if (config.tls !== true) return false;
  if (String(config.publicKey ?? '').trim() !== '') return false;
  const reseau = String(config.network ?? '').trim().toLowerCase();
  return TRANSPORTS_UPGRADE.has(reseau);
}

/** L'ALPN porté par la configuration est-il celui que nous avons déduit ? */
function alpnEstDeduit(config: Record<string, any>): boolean {
  const valeurs = String(config.alpn ?? '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(v => v !== '');
  return valeurs.length === 1 && valeurs[0] === ALPN_DEDUIT;
}

/**
 * Rend une COPIE de la configuration présentée selon le rang demandé.
 *
 * L'objet d'origine n'est jamais modifié : il reste la référence du profil, et
 * une tentative ne doit pas laisser de trace sur la suivante.
 */
export function appliquerPresentationTls<T extends Record<string, any>>(config: T, essai: number): T {
  if (!echelleApplicable(config)) return config;
  const presentation = presentationPourEssai(essai);
  const copie: Record<string, any> = { ...config };

  // L'ALPN de l'exploitant n'est jamais retiré : seule notre propre déduction
  // peut l'être, et la retirer revient exactement au comportement par défaut
  // d'un client ordinaire.
  if (!presentation.alpnDeduit && alpnEstDeduit(copie)) delete copie.alpn;
  if (!presentation.empreinte) copie.fingerprint = EMPREINTE_AUCUNE;
  // Additif uniquement : au premier échelon, ne rien poser du tout — sans
  // quoi la garantie « premier essai STRICTEMENT identique au profil » serait
  // rompue par un simple `fragment: false` que le profil n'a jamais demandé.
  if (presentation.fragment) copie.fragment = true;
  if (presentation.fragmentFort) copie.fragmentComplet = true;

  return copie as T;
}

/**
 * Codes d'échec pour lesquels changer de présentation a un sens.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE LISTE BLANCHE, ET NON UNE LISTE D'EXCLUSIONS
 * ═══════════════════════════════════════════════════════════════════════════
 * L'échelle relance la connexion et remplace donc le message d'échec par une
 * nouvelle tentative. Appliquée au mauvais échec, elle CACHE la seule
 * information dont l'utilisateur a besoin : mot de passe refusé, forfait
 * épuisé, accès révoqué, profil que le moteur ne sait pas exécuter. Aucun de
 * ces cas ne se règle en changeant de poignée de main, et les masquer derrière
 * trois tentatives silencieuses transformerait un diagnostic clair en panne
 * incompréhensible.
 *
 * Une liste d'exclusions se périme dès qu'un code est ajouté ailleurs — et se
 * périme SILENCIEUSEMENT, dans le sens dangereux. Une liste blanche, elle,
 * échoue du bon côté : un code inconnu ne déclenche rien.
 *
 * La chaîne vide couvre les échecs annoncés sans code : ce sont les pannes
 * génériques du moteur, exactement celles que l'échelle vise.
 */
export const ECHECS_DE_PRESENTATION: ReadonlySet<string> = new Set([
  '',
  'VPN_FAILED',
  'TCP_TIMEOUT',
  'SERVER_UNREACHABLE',
  'TLS_FAILED',
  'TRANSPORT_ERROR',
  'HTTP_UNEXPECTED',
  'TUNNEL_REFUSED',
]);

/** L'échec annoncé peut-il venir de la façon dont nous nous présentons ? */
export function refusDePresentation(code?: string | null): boolean {
  return ECHECS_DE_PRESENTATION.has(String(code ?? '').trim().toUpperCase());
}

/**
 * Rang suivant à tenter, ou `null` quand le budget d'exploration est épuisé.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI L'ÉCHELLE BOUCLE, ET POURQUOI ELLE EST BORNÉE
 * ═══════════════════════════════════════════════════════════════════════════
 * L'application RETIENT la présentation qui a fini par aboutir, afin de ne pas
 * refaire toute l'exploration au démarrage suivant. Mais un téléphone change de
 * réseau : celle qui passait hier au bureau peut être refusée ce soir en
 * mobile. Si l'échelle ne savait que descendre, un rang mémorisé élevé ne
 * laisserait plus rien à essayer — la mémoire se transformerait en impasse.
 *
 * Elle boucle donc, quel que soit le rang de départ. Le budget `dejaTentes` la
 * borne : on essaie chaque présentation AU PLUS UNE FOIS par cycle, jamais
 * davantage. Sans lui, un réseau qui refuse tout ferait tourner l'application
 * en rond indéfiniment.
 *
 * `null` ne signifie donc pas « abandonner », mais « toutes les présentations
 * ont été refusées » : la panne est ailleurs, et l'échec doit redevenir
 * visible.
 */
export function essaiSuivant(
  config: Record<string, any> | null | undefined,
  essai: number,
  dejaTentes = 0,
): number | null {
  if (!echelleApplicable(config)) return null;
  if (dejaTentes >= DERNIER_ESSAI) return null;
  return (borner(essai) + 1) % ECHELLE_TLS.length;
}
