/**
 * nouveautes — ce que le guide raconte, et quand il se montre.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN REGISTRE PLUTÔT QU'UN TEXTE DANS LE COMPOSANT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le guide doit apparaître UNE SEULE FOIS par personne, puis réapparaître à
 * CHAQUE nouvelle livraison. Ces deux exigences tiennent à une seule donnée :
 * un numéro de version que l'on compare à ce que le navigateur a retenu.
 *
 * Le séparer du composant rend la règle vérifiable sans navigateur, et surtout
 * rend la prochaine livraison triviale : on ajoute des étapes, on change la
 * version, et tout le monde revoit le guide exactement une fois.
 *
 * LES TEXTES NE SONT PAS ICI. Seules les CLÉS le sont : le guide se lit dans
 * la langue choisie, et une phrase écrite en dur dans ce fichier ne pourrait
 * pas se traduire.
 */

/** Une étape du guide. Le texte vit dans les dictionnaires, pas ici. */
export interface EtapeNouveaute {
  /** Suffixe de clé de traduction : `nouveautes.etapes.<id>.*`. */
  id: string;
  /**
   * Lien externe proposé par l'étape, quand elle en porte un.
   *
   * Absolu et en HTTPS : ces liens sortent du tableau de bord, et un chemin
   * relatif enverrait la personne sur une page du tableau de bord qui
   * n'existe pas.
   */
  lien?: string;
}

/**
 * Version du guide.
 *
 * LA RÈGLE : changer cette valeur fait revoir le guide à TOUT LE MONDE, une
 * fois. Ne pas la changer laisse tranquilles ceux qui l'ont déjà vu.
 *
 * Datée plutôt que numérotée : « 2026-09-20 » se relie à une livraison réelle,
 * là où « v3 » n'apprend rien à celui qui la lit six mois plus tard.
 */
export const VERSION_NOUVEAUTES = '2026-09-20';

/** Page publique de téléchargement de l'application Android. */
export const LIEN_TELECHARGEMENT = 'https://vpnsxb.afrihall.com/telecharger.html';

/**
 * Les étapes, dans l'ordre où elles se lisent.
 *
 * L'ordre suit le parcours de l'exploitant, pas l'ordre des livraisons :
 * d'abord ce qu'il donne au client (l'application), puis ce qu'il fait pour
 * lui (convertir), puis ce qu'il voit changer (le badge), enfin ce qui change
 * à l'import.
 */
export const ETAPES_NOUVEAUTES: EtapeNouveaute[] = [
  { id: 'telechargement', lien: LIEN_TELECHARGEMENT },
  { id: 'conversion' },
  { id: 'appareilEnEssai' },
  { id: 'badgeVip' },
  { id: 'configsV2ray' },
];

/** Clé de mémorisation dans le navigateur. */
export const CLE_NOUVEAUTES_VUES = 'sxb_nouveautes_vues_v1';

/**
 * Faut-il montrer le guide ?
 *
 * Fonction PURE : elle ne lit ni le navigateur ni l'horloge, on lui donne ce
 * qui a été retenu. C'est ce qui permet de vérifier la règle — « une fois,
 * puis à chaque livraison » — sans monter d'interface.
 *
 * Une valeur retenue ILLISIBLE ou d'une autre version fait réapparaître le
 * guide. C'est le bon défaut : revoir un guide est sans gravité, le manquer
 * prive quelqu'un d'une information qu'on a décidé de lui donner.
 */
export function doitAfficherNouveautes(
  vueRetenue: string | null | undefined,
  version: string = VERSION_NOUVEAUTES,
): boolean {
  return String(vueRetenue ?? '').trim() !== version;
}
