/**
 * Moteur de risque mobile — ce que l'appareil observe, ce que le serveur décide.
 *
 * L'application envoie des OBSERVATIONS, jamais un verdict. Un client compromis
 * est précisément celui dont on ne peut pas croire la conclusion : s'il lui
 * suffisait d'annoncer « tout va bien », toute la chaîne ne servirait à rien.
 * Le score, la gravité et l'action sont donc calculés ici, côté serveur, et
 * l'application n'a aucun moyen de les influencer autrement qu'en disant la
 * vérité sur ce qu'elle a vu.
 *
 * Les poids reflètent ce qu'un signal PROUVE, pas la peur qu'il inspire :
 *  • une signature d'APK qui ne correspond pas prouve un remballage — c'est le
 *    signal le plus fort, car il n'a aucune cause légitime ;
 *  • un leurre touché prouve qu'un tiers lit la configuration ;
 *  • une instrumentation active (Frida, Xposed, hook) prouve qu'un processus
 *    étranger est dans l'application ;
 *  • un appareil rooté ne prouve rien à lui seul : beaucoup d'utilisateurs
 *    honnêtes rootent leur téléphone. Il pèse, il n'accuse pas.
 */

/** Observations acceptées. Liste FERMÉE : un champ libre finirait en fourre-tout. */
export const SIGNAUX_MOBILES = [
  'signatureInvalid',
  'decoyTouched',
  'hooked',
  'frida',
  'xposed',
  'attestationFailed',
  'debugger',
  'rooted',
  'emulator',
] as const;
export type SignalMobile = (typeof SIGNAUX_MOBILES)[number];

/**
 * Poids de chaque observation.
 *
 * Les trois premiers atteignent seuls le seuil de blocage : ils n'ont pas de
 * cause légitime. Les autres doivent se cumuler pour y parvenir, ce qui évite
 * de couper l'accès d'un utilisateur honnête sur un unique indice ambigu.
 */
const POIDS: Record<SignalMobile, number> = {
  signatureInvalid: 80,
  decoyTouched: 80,
  hooked: 70,
  frida: 70,
  xposed: 50,
  attestationFailed: 40,
  debugger: 30,
  rooted: 25,
  emulator: 15,
};

/** Au-delà, l'accès de l'appareil est coupé. */
export const SEUIL_BLOCAGE = 70;
/** Au-delà, l'alerte demande un examen sans rien couper. */
export const SEUIL_AVERTISSEMENT = 25;

export type ActionRisque = 'none' | 'watch' | 'block';

export interface EvaluationRisque {
  score: number;
  severity: 'info' | 'warning' | 'critical';
  action: ActionRisque;
  signaux: SignalMobile[];
}

/** Ne retient que les observations connues et vraies. */
export function normaliserSignaux(brut: unknown): SignalMobile[] {
  if (!brut || typeof brut !== 'object') return [];
  const source = brut as Record<string, unknown>;
  return SIGNAUX_MOBILES.filter((signal) => source[signal] === true);
}

/**
 * Évalue un ensemble d'observations.
 *
 * Le score est plafonné à 100 : au-delà du seuil de blocage, un total plus
 * élevé ne change plus rien à la décision et ne ferait qu'exagérer le chiffre
 * affiché à l'exploitant.
 */
export function evaluerRisque(signaux: SignalMobile[]): EvaluationRisque {
  const retenus = [...new Set(signaux)].filter((signal) => signal in POIDS);
  const score = Math.min(100, retenus.reduce((total, signal) => total + POIDS[signal], 0));
  if (score >= SEUIL_BLOCAGE) {
    return { score, severity: 'critical', action: 'block', signaux: retenus };
  }
  if (score >= SEUIL_AVERTISSEMENT) {
    return { score, severity: 'warning', action: 'watch', signaux: retenus };
  }
  return { score, severity: 'info', action: 'none', signaux: retenus };
}

/**
 * Le rapport mérite-t-il une trace ?
 *
 * Un appareil sain qui se signale toutes les quelques minutes n'a rien à
 * raconter. Sans ce filtre, le flux d'alertes se remplirait de « rien à
 * signaler » et noierait ce qui compte.
 */
export function meriteUneTrace(evaluation: EvaluationRisque): boolean {
  return evaluation.signaux.length > 0;
}
