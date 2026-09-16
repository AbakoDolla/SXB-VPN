/**
 * security-events — ce que la plateforme a CONSTATÉ.
 *
 * Distinct du journal d'audit, et c'est délibéré : l'audit trace ce qu'un
 * administrateur a FAIT, ce flux trace ce que la plateforme a OBSERVÉ. Les
 * mélanger obligerait à chercher quelques lignes décisives au milieu de
 * plusieurs milliers d'entrées de routine.
 *
 * RÈGLE ABSOLUE : aucun secret n'entre ici. Ni identifiant VPN, ni jeton, ni
 * mot de passe, ni clé. Une adresse source n'est conservée que sous forme
 * d'empreinte non réversible, suffisante pour regrouper des tentatives sans
 * jamais désigner une personne.
 *
 * L'enregistrement ne doit JAMAIS faire échouer l'action qu'il observe : une
 * connexion refusée doit être refusée même si la base de journalisation est
 * indisponible. Toutes les écritures sont donc silencieusement absorbées.
 */
import { prisma } from '../database';

/** Gravités, de la plus faible à la plus forte. */
export const SECURITY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

/**
 * Types d'événements reconnus.
 *
 * Liste FERMÉE : un type libre finirait par accumuler des variantes
 * orthographiques qu'aucun filtre ne rattraperait.
 */
export const SECURITY_EVENT_TYPES = [
  'LOGIN_FAILED',
  'LOGIN_ABUSE',
  'DEVICE_REGISTERED',
  'DEVICE_BLOCKED',
  'DEVICE_UNBLOCKED',
  'SESSION_REVOKED',
  'TOKEN_REUSE',
  'CONFIG_ABUSE',
  'RATE_LIMIT_TRIGGERED',
  'INTEGRITY_FAILED',
  'SECURITY_GATE_REJECTED',
  'SECURITY_GATE_OPENED',
  'SECURITY_GATE_PASSWORD_ROTATED',
  'SECURITY_PASSKEY_ENROLLED',
  'SECURITY_PASSKEY_REMOVED',
  'SECURITY_PASSKEY_REJECTED',
  'DEVICE_INTEGRITY_ALERT',
  'DEVICE_AUTO_BLOCKED',
  'DEVICE_DECOY_TOUCHED',
  'DEVICE_ATTESTATION_FAILED',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface SecurityEventInput {
  eventType: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: string | null;
  deviceId?: string | null;
  ipHash?: string | null;
  appVersion?: string | null;
  actionTaken?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Bornes de pagination : une console ne lit jamais toute une table. */
export const SECURITY_EVENTS_PAGE_SIZE = 50;
export const SECURITY_EVENTS_MAX_PAGE_SIZE = 200;

/**
 * Champs autorisés dans `metadata`.
 *
 * Une allowlist, pas une denylist : ce qui n'est pas prévu ne passe pas, ce qui
 * empêche un appelant distrait d'y déverser un corps de requête entier.
 */
const METADATA_KEYS = new Set([
  'reason', 'route', 'method', 'attempts', 'windowMinutes', 'status',
  'role', 'target', 'profileId', 'subscriptionId', 'count', 'label',
  // Attribution d'une alerte mobile. L'exploitant a besoin de savoir QUI et
  // D'OÙ, sans quoi il lit un incident sans pouvoir agir dessus. Ces champs ne
  // sortent que par la console propriétaire, qui est déjà cloisonnée.
  'ip', 'clientName', 'deviceModel', 'appVersion',
  'signals', 'riskScore', 'action', 'attestation',
]);

function nettoyerMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const propre: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(metadata)) {
    if (!METADATA_KEYS.has(cle)) continue;
    if (valeur === null || valeur === undefined) continue;
    if (typeof valeur === 'number' || typeof valeur === 'boolean') propre[cle] = valeur;
    else if (typeof valeur === 'string') propre[cle] = valeur.slice(0, 200);
  }
  const clefs = Object.keys(propre);
  if (clefs.length === 0) return null;
  return JSON.stringify(propre).slice(0, 2000);
}

/**
 * Enregistre un événement. Ne rejette JAMAIS.
 *
 * Renvoie `true` quand la ligne est écrite, afin que les tests puissent le
 * vérifier sans que l'appelant ait à s'en soucier.
 */
export async function recordSecurityEvent(entree: SecurityEventInput): Promise<boolean> {
  if (!prisma) return false;
  try {
    const severity = SECURITY_SEVERITIES.includes(entree.severity as any) ? entree.severity : 'info';
    await (prisma as any).securityEvent.create({
      data: {
        eventType: entree.eventType,
        severity,
        userId: entree.userId ?? null,
        deviceId: entree.deviceId ?? null,
        ipHash: entree.ipHash ?? null,
        appVersion: entree.appVersion ?? null,
        actionTaken: entree.actionTaken ?? null,
        metadata: nettoyerMetadata(entree.metadata),
      },
    });
    return true;
  } catch (error: any) {
    // Observer ne doit pas casser ce qui est observé.
    console.warn(`[security] événement non enregistré: ${error?.message || error}`);
    return false;
  }
}

export interface SecurityEventQuery {
  severity?: string;
  eventType?: string;
  acknowledged?: boolean;
  limit?: number;
  offset?: number;
}

export function normaliserPagination(query: SecurityEventQuery) {
  const limitBrut = Number(query.limit);
  const offsetBrut = Number(query.offset);
  const limit = Number.isSafeInteger(limitBrut) && limitBrut > 0
    ? Math.min(limitBrut, SECURITY_EVENTS_MAX_PAGE_SIZE)
    : SECURITY_EVENTS_PAGE_SIZE;
  const offset = Number.isSafeInteger(offsetBrut) && offsetBrut > 0 ? offsetBrut : 0;
  return { limit, offset };
}

export function construireFiltre(query: SecurityEventQuery): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (SECURITY_SEVERITIES.includes(query.severity as any)) where.severity = query.severity;
  if (SECURITY_EVENT_TYPES.includes(query.eventType as any)) where.eventType = query.eventType;
  if (query.acknowledged === true || query.acknowledged === false) where.acknowledged = query.acknowledged;
  return where;
}

/**
 * Actions écrites avant que le serveur ne stocke des codes.
 *
 * Ces lignes portent une phrase française figée, qui s'afficherait telle quelle
 * à un opérateur anglophone. On les relit sous leur code, que le tableau de bord
 * sait traduire ; la base n'est pas réécrite pour autant.
 */
const ACTIONS_HERITEES = new Map<string, string>([
  ['Toutes les ouvertures en cours ont été fermées', 'SESSIONS_CLOSED'],
]);

/** Page d'événements, la plus récente d'abord, avec son total filtré. */
export async function listSecurityEvents(query: SecurityEventQuery) {
  if (!prisma) return { events: [], total: 0, limit: SECURITY_EVENTS_PAGE_SIZE, offset: 0 };
  const { limit, offset } = normaliserPagination(query);
  const where = construireFiltre(query);
  const [events, total] = await Promise.all([
    (prisma as any).securityEvent.findMany({
      where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset,
    }),
    (prisma as any).securityEvent.count({ where }),
  ]);
  const lisibles = events.map((evenement: any) => (
    evenement?.actionTaken && ACTIONS_HERITEES.has(evenement.actionTaken)
      ? { ...evenement, actionTaken: ACTIONS_HERITEES.get(evenement.actionTaken) }
      : evenement
  ));
  return { events: lisibles, total, limit, offset };
}

/** Compteurs de l'aperçu. Une seule lecture groupée, pas une par carte. */
export async function securityOverview() {
  if (!prisma) {
    return { total: 0, critical: 0, warning: 0, info: 0, unacknowledged: 0, last24h: 0, latestAt: null };
  }
  const depuis24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [parGravite, unacknowledged, last24h, dernier] = await Promise.all([
    (prisma as any).securityEvent.groupBy({ by: ['severity'], _count: { _all: true } }),
    (prisma as any).securityEvent.count({ where: { acknowledged: false } }),
    (prisma as any).securityEvent.count({ where: { createdAt: { gte: depuis24h } } }),
    (prisma as any).securityEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  const compte = (gravite: string) =>
    Number(parGravite.find((ligne: any) => ligne.severity === gravite)?._count?._all ?? 0);
  return {
    total: parGravite.reduce((somme: number, ligne: any) => somme + Number(ligne._count?._all ?? 0), 0),
    critical: compte('critical'),
    warning: compte('warning'),
    info: compte('info'),
    unacknowledged,
    last24h,
    latestAt: dernier?.createdAt ? new Date(dernier.createdAt).toISOString() : null,
  };
}

/** Marque des alertes comme traitées. Rend le nombre réellement modifié. */
export async function acknowledgeSecurityEvents(ids: string[], adminId: string): Promise<number> {
  if (!prisma || ids.length === 0) return 0;
  const result = await (prisma as any).securityEvent.updateMany({
    where: { id: { in: ids.slice(0, SECURITY_EVENTS_MAX_PAGE_SIZE) }, acknowledged: false },
    data: { acknowledged: true, acknowledgedAt: new Date(), acknowledgedById: adminId },
  });
  return result.count;
}
