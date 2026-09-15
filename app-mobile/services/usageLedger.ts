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
 *  - `counterUp`/`counterDown` : dernière lecture de l'odomètre durable natif.
 *    Un recul positif peut venir d'une ancienne sauvegarde non terminée :
 *    il recale l'ancre sans refacturer cet historique. Les remises à zéro
 *    des compteurs de session sont déjà absorbées par l'odomètre natif.
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

export class UsageLedgerReadError extends Error {
  readonly code = 'VPN_USAGE_LEDGER_UNAVAILABLE';

  constructor(readonly reason: 'read' | 'corrupt') {
    super('VPN_USAGE_LEDGER_UNAVAILABLE');
    this.name = 'UsageLedgerReadError';
  }
}

/**
 * Le serveur rejette tout rapport de plus de 5 Go en un appel (garde
 * anti-abus de `applyUsageDelta`). Un rapport accumulé pendant une longue
 * panne réseau est donc découpé sous cette limite au lieu d'être rejeté —
 * rejet qui aurait fait perdre TOUT le retard d'un coup.
 */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024 * 1024;

export interface UsageCounters {
  up: number;
  down: number;
}

export interface UsageContext {
  subscriptionId: string | null;
  configId?: string | null;
  sessionId: string;
}

export interface UsageQuotaSnapshot {
  usedBytes: number;
  totalBytes: number;
}

export interface UsageEntry {
  /** Forfait qui a réellement porté ce trafic. */
  subscriptionId: string | null;
  configId?: string | null;
  sessionId: string;
  seq: number;
  up: number;
  down: number;
  /** Tentée au moins une fois : montants et identifiants figés à jamais. */
  frozen: boolean;
}

export interface UsageLedger {
  /** Même une ancre à zéro est une mesure, pas un livre encore vierge. */
  initialized?: boolean;
  counterUp: number;
  counterDown: number;
  nextSeq: number;
  entries: UsageEntry[];
  /** Dernier profil mesuré, encore identifiable si le service s'est arrêté hors JS. */
  context?: UsageContext;
  /** Snapshots appariés aux acquittements, jamais à un compteur de session remis à zéro. */
  quotas?: Record<string, UsageQuotaSnapshot>;
}

export interface UsageReport {
  subscriptionId: string | null;
  configId?: string | null;
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

function scopeKey(context: Pick<UsageContext, 'subscriptionId' | 'configId'>): string | null {
  return context.subscriptionId || context.configId || null;
}

export function pendingUsage(ledger: UsageLedger, context: Pick<UsageContext, 'subscriptionId' | 'configId'>): UsageCounters {
  const key = scopeKey(context);
  return ledger.entries.reduce((sum, entry) => scopeKey(entry) === key
    ? { up: sum.up + entry.up, down: sum.down + entry.down }
    : sum, { up: 0, down: 0 });
}

export function recordQuota(
  ledger: UsageLedger,
  context: Pick<UsageContext, 'subscriptionId' | 'configId'>,
  quota: UsageQuotaSnapshot,
): UsageLedger {
  const key = scopeKey(context);
  if (!key) return ledger;
  const totalBytes = safeCount(quota.totalBytes);
  const previous = ledger.quotas?.[key];
  const usedBytes = Math.max(safeCount(quota.usedBytes),
    previous?.totalBytes === totalBytes ? previous.usedBytes : 0);
  return { ...ledger, quotas: { ...ledger.quotas, [key]: {
    usedBytes, totalBytes,
  } } };
}

/** Somme du retard durable et du delta natif non encore échantillonné par le reporter. */
export function quotaProjection(
  ledger: UsageLedger | null,
  context: Pick<UsageContext, 'subscriptionId' | 'configId'>,
  counters?: UsageCounters | null,
): { pendingBytes: number; accountedUsedBytes?: number } {
  const key = scopeKey(context);
  const quota = key ? ledger?.quotas?.[key] : undefined;
  // Un ancien livre sans snapshot ne permet pas de savoir si sa tête a déjà
  // atteint le serveur : attendre son rejeu plutôt que l'additionner deux fois.
  if (!ledger || !quota) return { pendingBytes: 0 };
  const pending = pendingUsage(ledger, context);
  const live = counters && !isFreshLedger(ledger)
    // Le dernier rendu peut précéder la lecture du reporter. Une lecture UI
    // plus ancienne n'est PAS une remise à zéro de l'odomètre durable.
    ? Math.max(0, safeCount(counters.up) - ledger.counterUp) + Math.max(0, safeCount(counters.down) - ledger.counterDown)
    : 0;
  return { pendingBytes: pending.up + pending.down + live, accountedUsedBytes: quota.usedBytes };
}

/**
 * Cale le livre sur la lecture courante SANS rien facturer.
 *
 * Utilisé au tout premier démarrage : le compteur kilométrique du service peut
 * déjà valoir plusieurs gigaoctets alors que le livre, lui, vient de naître.
 * L'ancrage interdit de facturer rétroactivement un passé qu'on n'a pas mesuré.
 */
export function anchorLedger(ledger: UsageLedger, counters: UsageCounters): UsageLedger {
  return { ...ledger, initialized: true, counterUp: safeCount(counters.up), counterDown: safeCount(counters.down) };
}

/** Livre qui n'a encore jamais rien observé : il doit s'ancrer, pas facturer. */
export function isFreshLedger(ledger: UsageLedger): boolean {
  return !ledger.initialized && ledger.counterUp === 0 && ledger.counterDown === 0 &&
    ledger.nextSeq === 0 && ledger.entries.length === 0;
}

/**
 * Enregistre la consommation mesurée depuis la lecture précédente.
 *
 * Les octets rejoignent la dernière entrée encore ouverte du même forfait, ou
 * ouvrent une nouvelle entrée. Seuls les envois sont plafonnés ; plafonner le
 * cumul en attente jetterait du trafic réel pendant une longue panne réseau.
 */
export function accumulate(
  ledger: UsageLedger,
  counters: UsageCounters,
  context: UsageContext,
): UsageLedger {
  const up = counters.up < ledger.counterUp ? 0 : counterStep(ledger.counterUp, counters.up);
  const down = counters.down < ledger.counterDown ? 0 : counterStep(ledger.counterDown, counters.down);
  const advanced: UsageLedger = {
    ...ledger,
    initialized: true,
    context,
    // Une lecture NULLE ne prouve rien : le service peut être en cours de
    // démarrage et n'avoir pas encore rechargé son compteur durable. Reculer le
    // livre à zéro sur cette lecture ferait refacturer tout le cumul à la
    // lecture suivante. Chaque axe n'avance donc que sur une valeur réelle.
    counterUp: counters.up > 0 ? safeCount(counters.up) : ledger.counterUp,
    counterDown: counters.down > 0 ? safeCount(counters.down) : ledger.counterDown,
    entries: [...ledger.entries],
  };
  if (up <= 0 && down <= 0) return advanced;
  const last = advanced.entries[advanced.entries.length - 1];
  if (last && !last.frozen && last.subscriptionId === context.subscriptionId && last.sessionId === context.sessionId) {
    advanced.entries[advanced.entries.length - 1] = { ...last, up: last.up + up, down: last.down + down };
    return advanced;
  }
  advanced.entries.push({
    subscriptionId: context.subscriptionId,
    configId: context.configId,
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
      configId: head.configId,
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
      configId: head.configId,
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
  const isCount = (count: unknown): count is number =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  const isOptionalId = (id: unknown): boolean => id == null || typeof id === 'string';
  const corrupt = (): never => { throw new UsageLedgerReadError('corrupt'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return corrupt();
  const raw = value as Partial<UsageLedger>;
  if (!isCount(raw.counterUp) || !isCount(raw.counterDown) || !isCount(raw.nextSeq) ||
      !Array.isArray(raw.entries)) return corrupt();
  if (raw.initialized !== undefined && typeof raw.initialized !== 'boolean') return corrupt();
  if (raw.context !== undefined && (!raw.context || typeof raw.context !== 'object' ||
      typeof raw.context.sessionId !== 'string' || !raw.context.sessionId ||
      !isOptionalId(raw.context.subscriptionId) || !isOptionalId(raw.context.configId))) return corrupt();
  const entries = raw.entries;
  const clean: UsageEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return corrupt();
    const candidate = entry as Partial<UsageEntry>;
    if (typeof candidate.sessionId !== 'string' || !candidate.sessionId ||
        !isCount(candidate.seq) || !isCount(candidate.up) || !isCount(candidate.down) ||
        !isOptionalId(candidate.subscriptionId) || !isOptionalId(candidate.configId)) return corrupt();
    const up = candidate.up;
    const down = candidate.down;
    if (up + down <= 0) return corrupt();
    clean.push({
      subscriptionId: typeof candidate.subscriptionId === 'string' ? candidate.subscriptionId : null,
      configId: typeof candidate.configId === 'string' ? candidate.configId : undefined,
      sessionId: candidate.sessionId,
      seq: candidate.seq,
      up,
      down,
      // Une entrée relue après un redémarrage a pu être reçue par le serveur
      // sans que la réponse nous parvienne : elle est donc gelée d'office.
      frozen: true,
    });
  }
  const highestSeq = clean.reduce((max, entry) => Math.max(max, entry.seq + 1), 0);
  const quotas: Record<string, UsageQuotaSnapshot> = {};
  if (raw.quotas !== undefined && (!raw.quotas || typeof raw.quotas !== 'object' || Array.isArray(raw.quotas))) return corrupt();
  if (raw.quotas && typeof raw.quotas === 'object') {
    for (const [id, quota] of Object.entries(raw.quotas)) {
      if (!quota || typeof quota !== 'object' || !isCount(quota.usedBytes) || !isCount(quota.totalBytes)) return corrupt();
      quotas[id] = { usedBytes: quota.usedBytes, totalBytes: quota.totalBytes };
    }
  }
  const context = raw.context && typeof raw.context.sessionId === 'string'
    ? {
      sessionId: raw.context.sessionId,
      subscriptionId: typeof raw.context.subscriptionId === 'string' ? raw.context.subscriptionId : null,
      configId: typeof raw.context.configId === 'string' ? raw.context.configId : undefined,
    }
    : undefined;
  return {
    initialized: raw.initialized === true,
    counterUp: safeCount(raw.counterUp),
    counterDown: safeCount(raw.counterDown),
    nextSeq: Math.max(safeCount(raw.nextSeq), highestSeq),
    entries: clean,
    context,
    quotas,
  };
}

/** Seule l'absence réelle du livre autorise un nouvel ancrage. */
export async function loadLedger(): Promise<UsageLedger> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    throw new UsageLedgerReadError('read');
  }
  if (raw === null) return emptyLedger();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    throw new UsageLedgerReadError('corrupt');
  }
}

/** Écrit le livre. Appelé AVANT chaque envoi réseau : rien ne part sans trace sur disque. */
export async function saveLedger(ledger: UsageLedger): Promise<void> {
  // Le reporter diffère l'envoi si cette écriture échoue. Masquer l'erreur
  // autoriserait un envoi sans clé de rejeu durable, donc une double facture.
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
}

export async function clearLedger(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
