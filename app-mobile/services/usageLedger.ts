/**
 * usageLedger.ts — Livre de comptes de la consommation data.
 *
 * LE DÉFAUT CORRIGÉ
 * ─────────────────
 * La consommation était calculée à la volée, en mémoire, par un simple
 * `Math.max(0, compteur - dernierCompteurRemonté)`. Deux conséquences, toutes
 * deux observées en production :
 *
 *  1. Le compteur natif repart de zéro à chaque reconnexion du tunnel. Après
 *     une reconnexion, `compteur` (5 Mo) était INFÉRIEUR à `dernierCompteur`
 *     (20 Mo) : le delta valait zéro, et il valait zéro tant que la nouvelle
 *     session n'avait pas repassé 20 Mo. Tout le trafic intermédiaire — 78 Mo
 *     dans le cas signalé — disparaissait définitivement.
 *
 *  2. Le delta pas encore remonté ne vivait qu'en mémoire. Le système tue
 *     régulièrement une application dont le service VPN tourne depuis des
 *     heures : le delta mourait avec elle.
 *
 * CE QUE FAIT CE MODULE
 * ─────────────────────
 * Il tient un livre de comptes PERSISTANT (AsyncStorage) :
 *
 *  - `counterUp`/`counterDown` : dernière lecture du compteur kilométrique du
 *    service natif. Une lecture INFÉRIEURE à la précédente signifie une remise
 *    à zéro : le delta vaut alors la nouvelle valeur ENTIÈRE, jamais zéro.
 *    C'est la même règle que `SxbUsageOdometer.step` côté Kotlin.
 *
 *  - `entries` : la file des octets mesurés mais pas encore acceptés par le
 *    serveur. Elle est écrite sur disque avant chaque envoi, donc elle survit
 *    à la mort de l'application et est rejouée au démarrage suivant.
 *
 * IDEMPOTENCE
 * ───────────
 * Une entrée reçoit son couple (`sessionId`, `seq`) à sa création. Dès sa
 * première tentative d'envoi elle est GELÉE : ni son montant ni ses
 * identifiants ne changent plus. Un rejeu après coupure réseau — ou après
 * redémarrage de l'application — renvoie donc exactement le même rapport, que
 * le serveur reconnaît et refuse de compter deux fois. Un octet peut être
 * perdu si le stockage est effacé ; il ne peut jamais être facturé deux fois.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@sxb_usage_ledger';

/**
 * Le serveur rejette tout rapport de plus de 5 Go en un appel (garde
 * anti-abus de `applyUsageDelta`). Un rapport accumulé pendant une longue
 * panne réseau est donc découpé sous cette limite au lieu d'être rejeté —
 * rejet qui aurait fait perdre TOUT le retard d'un coup.
 */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024 * 1024;

/** Au-delà, le livre cesse d'accumuler : une mesure aberrante ne doit pas devenir une facture. */
export const MAX_PENDING_BYTES = 64 * 1024 * 1024 * 1024;

export interface UsageCounters {
  up: number;
  down: number;
}

export interface UsageEntry {
  /** Forfait qui a réellement porté ce trafic. */
  subscriptionId: string | null;
  sessionId: string;
  seq: number;
  up: number;
  down: number;
  /** Tentée au moins une fois : montants et identifiants figés à jamais. */
  frozen: boolean;
}

export interface UsageLedger {
  counterUp: number;
  counterDown: number;
  nextSeq: number;
  entries: UsageEntry[];
}

export interface UsageReport {
  subscriptionId: string | null;
  sessionId: string;
  seq: number;
  bytesUp: number;
  bytesDown: number;
}

export function emptyLedger(): UsageLedger {
  return { counterUp: 0, counterDown: 0, nextSeq: 0, entries: [] };
}

function safeCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER);
}

/**
 * Delta entre deux lectures d'un compteur cumulatif, remise à zéro comprise.
 *
 * Règle unique, partagée avec `SxbUsageOdometer.step` (Kotlin) : une valeur
 * INFÉRIEURE à la précédente est une remise à zéro, donc la nouvelle valeur
 * est entièrement du trafic neuf.
 */
export function counterStep(previous: number, current: number): number {
  const next = safeCount(current);
  if (next <= 0) return 0;
  const floor = safeCount(previous);
  return next < floor ? next : next - floor;
}

export function pendingBytes(ledger: UsageLedger): number {
  return ledger.entries.reduce((total, entry) => total + entry.up + entry.down, 0);
}

/**
 * Cale le livre sur la lecture courante SANS rien facturer.
 *
 * Utilisé au tout premier démarrage : le compteur kilométrique du service peut
 * déjà valoir plusieurs gigaoctets alors que le livre, lui, vient de naître.
 * L'ancrage interdit de facturer rétroactivement un passé qu'on n'a pas mesuré.
 */
export function anchorLedger(ledger: UsageLedger, counters: UsageCounters): UsageLedger {
  return { ...ledger, counterUp: safeCount(counters.up), counterDown: safeCount(counters.down) };
}

/** Livre qui n'a encore jamais rien observé : il doit s'ancrer, pas facturer. */
export function isFreshLedger(ledger: UsageLedger): boolean {
  return ledger.counterUp === 0 && ledger.counterDown === 0 &&
    ledger.nextSeq === 0 && ledger.entries.length === 0;
}

/**
 * Enregistre la consommation mesurée depuis la lecture précédente.
 *
 * Les octets rejoignent la dernière entrée encore ouverte du même forfait, ou
 * ouvrent une nouvelle entrée. Le compteur est avancé même quand les octets
 * sont refusés (plafond atteint) : le livre reste aligné sur le natif.
 */
export function accumulate(
  ledger: UsageLedger,
  counters: UsageCounters,
  context: { subscriptionId: string | null; sessionId: string },
): UsageLedger {
  const up = counterStep(ledger.counterUp, counters.up);
  const down = counterStep(ledger.counterDown, counters.down);
  const advanced: UsageLedger = {
    ...ledger,
    // Une lecture NULLE ne prouve rien : le service peut être en cours de
    // démarrage et n'avoir pas encore rechargé son compteur durable. Reculer le
    // livre à zéro sur cette lecture ferait refacturer tout le cumul à la
    // lecture suivante. Chaque axe n'avance donc que sur une valeur réelle.
    counterUp: counters.up > 0 ? safeCount(counters.up) : ledger.counterUp,
    counterDown: counters.down > 0 ? safeCount(counters.down) : ledger.counterDown,
    entries: [...ledger.entries],
  };
  if (up <= 0 && down <= 0) return advanced;
  if (pendingBytes(ledger) >= MAX_PENDING_BYTES) return advanced;

  const last = advanced.entries[advanced.entries.length - 1];
  if (last && !last.frozen && last.subscriptionId === context.subscriptionId) {
    advanced.entries[advanced.entries.length - 1] = { ...last, up: last.up + up, down: last.down + down };
    return advanced;
  }
  advanced.entries.push({
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    seq: advanced.nextSeq,
    up,
    down,
    frozen: false,
  });
  advanced.nextSeq += 1;
  return advanced;
}

/**
 * Prépare le prochain rapport à envoyer, en gelant l'entrée de tête.
 *
 * Le gel est ce qui rend le rejeu sûr : une fois l'entrée gelée, toute
 * nouvelle mesure va dans une entrée suivante, et la tête sera retransmise à
 * l'identique — mêmes octets, mêmes `sessionId`/`seq` — jusqu'à ce que le
 * serveur l'accepte ou la reconnaisse comme déjà comptée.
 */
export function nextReport(ledger: UsageLedger): { ledger: UsageLedger; report: UsageReport } | null {
  const head = ledger.entries[0];
  if (!head) return null;
  if (head.up + head.down <= 0) return null;

  const entries = [...ledger.entries];
  let bytesUp = head.up;
  let bytesDown = head.down;
  if (bytesUp + bytesDown > MAX_REPORT_BYTES) {
    bytesUp = Math.min(head.up, MAX_REPORT_BYTES);
    bytesDown = Math.min(head.down, MAX_REPORT_BYTES - bytesUp);
  }
  const next: UsageLedger = { ...ledger, entries };
  entries[0] = { ...head, up: bytesUp, down: bytesDown, frozen: true };

  const remainderUp = head.up - bytesUp;
  const remainderDown = head.down - bytesDown;
  if (remainderUp > 0 || remainderDown > 0) {
    entries.splice(1, 0, {
      subscriptionId: head.subscriptionId,
      sessionId: head.sessionId,
      seq: next.nextSeq,
      up: remainderUp,
      down: remainderDown,
      frozen: false,
    });
    next.nextSeq += 1;
  }

  return {
    ledger: next,
    report: {
      subscriptionId: head.subscriptionId,
      sessionId: head.sessionId,
      seq: head.seq,
      bytesUp,
      bytesDown,
    },
  };
}

/** Retire l'entrée que le serveur a acceptée — ou reconnue comme déjà comptée. */
export function settle(ledger: UsageLedger, report: UsageReport): UsageLedger {
  const head = ledger.entries[0];
  if (!head || head.sessionId !== report.sessionId || head.seq !== report.seq) return ledger;
  return { ...ledger, entries: ledger.entries.slice(1) };
}

function sanitize(value: unknown): UsageLedger {
  if (!value || typeof value !== 'object') return emptyLedger();
  const raw = value as Partial<UsageLedger>;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const clean: UsageEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<UsageEntry>;
    if (typeof candidate.sessionId !== 'string' || !candidate.sessionId) continue;
    if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 0) continue;
    const up = safeCount(candidate.up);
    const down = safeCount(candidate.down);
    if (up + down <= 0) continue;
    clean.push({
      subscriptionId: typeof candidate.subscriptionId === 'string' ? candidate.subscriptionId : null,
      sessionId: candidate.sessionId,
      seq: candidate.seq as number,
      up,
      down,
      // Une entrée relue après un redémarrage a pu être reçue par le serveur
      // sans que la réponse nous parvienne : elle est donc gelée d'office.
      frozen: true,
    });
  }
  const highestSeq = clean.reduce((max, entry) => Math.max(max, entry.seq + 1), 0);
  return {
    counterUp: safeCount(raw.counterUp),
    counterDown: safeCount(raw.counterDown),
    nextSeq: Math.max(safeCount(raw.nextSeq), highestSeq),
    entries: clean,
  };
}

/** Relit le livre. Un stockage absent ou corrompu rend un livre vierge, jamais une exception. */
export async function loadLedger(): Promise<UsageLedger> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLedger();
    return sanitize(JSON.parse(raw));
  } catch {
    return emptyLedger();
  }
}

/** Écrit le livre. Appelé AVANT chaque envoi réseau : rien ne part sans trace sur disque. */
export async function saveLedger(ledger: UsageLedger): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    /* Un stockage indisponible ne doit jamais interrompre le tunnel. */
  }
}

export async function clearLedger(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
