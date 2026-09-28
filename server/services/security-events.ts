/**
 * security-events — ce que la plateforme a CONSTATÉ.
 *
 * Distinct du journal d'audit, et c'est délibéré : l'audit trace ce qu'un
 * administrateur a FAIT, ce flux trace ce que la plateforme a OBSERVÉ. Les
 * mélanger obligerait à chercher quelques lignes décisives au milieu de
 * plusieurs milliers d'entrées de routine.
 *
 * RÈGLE ABSOLUE : aucun secret n'entre ici. Ni identifiant VPN, ni jeton, ni
 * mot de passe, ni clé privée. Le champ ipHash regroupe les tentatives ; les
 * métadonnées historiques ip/clientName restent réservées à la console owner.
 *
 * Une observation facultative ne doit pas casser l'action observée ; son
 * échec est journalisé. En revanche, l'acquittement d'un événement durable
 * utilise l'écrivain transactionnel strict et exige une persistance réussie.
 */
import { prisma } from '../database';
import type { Prisma, PrismaClient } from '@prisma/client';
import { sendSecurityAlertPush } from './fcm';

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
  'VPN_STARTED', 'VPN_STOPPED', 'VPN_REVOKED', 'VPN_CONFLICT',
  'ROOT_DETECTED', 'DEBUG_DETECTED', 'HOOKING_RISK', 'INSTRUMENTATION_RISK',
  'APP_INTEGRITY_FAILED', 'TOKEN_REPLAY', 'DEVICE_MISMATCH', 'SESSION_REPLAY',
  'CAPTURE_RISK_DETECTED', 'CONTROL_RISK_DETECTED', 'SECURITY_POLICY_BLOCK',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface SecurityEventInput {
  eventType: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  sessionGeneration?: number | null;
  connectionId?: string | null;
  eventKey?: string | null;
  policyVersion?: number | null;
  riskLevel?: string | null;
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
  'riskLevel', 'evidence', 'policyVersion', 'observedAt',
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

/** Strict writer for durable client acknowledgments inside the caller's transaction. */
export async function persistSecurityEvent(tx: Prisma.TransactionClient | PrismaClient, entree: SecurityEventInput) {
    const severity: SecuritySeverity = SECURITY_SEVERITIES.includes(entree.severity as any)
      ? entree.severity as SecuritySeverity
      : 'info';
    const data = {
        eventType: entree.eventType,
        severity,
        userId: entree.userId ?? null,
        deviceId: entree.deviceId ?? null,
        sessionId: entree.sessionId ?? null,
        sessionGeneration: entree.sessionGeneration ?? null,
        connectionId: entree.connectionId ?? null,
        eventKey: entree.eventKey ?? null,
        policyVersion: entree.policyVersion ?? null,
        riskLevel: entree.riskLevel ?? null,
        ipHash: entree.ipHash ?? null,
        appVersion: entree.appVersion ?? null,
        actionTaken: entree.actionTaken ?? null,
        metadata: nettoyerMetadata(entree.metadata),
      };
    return entree.eventKey
      ? tx.securityEvent.upsert({ where: { eventKey: entree.eventKey }, create: data, update: {} })
      : tx.securityEvent.create({ data });
}

export async function recordSecurityEvent(entree: SecurityEventInput): Promise<boolean> {
  if (!prisma) return false;
  try {
    const event = await persistSecurityEvent(prisma, entree);
    const severity = event.severity as SecuritySeverity;
    if (severity === 'critical' || severity === 'warning') {
      void sendSecurityAlertPush({
        eventId: event.id,
        eventType: entree.eventType,
        severity,
      }).catch((error: unknown) => {
        console.warn(`[security] alerte owner non envoyée: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return true;
  } catch (error: any) {
    if (error?.code === 'P2002' && entree.eventKey) return true;
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
  userId?: string;
  deviceId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  riskLevel?: string;
  search?: string;
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

export function construireFiltre(query: SecurityEventQuery): Prisma.SecurityEventWhereInput {
  const where: Prisma.SecurityEventWhereInput = {};
  if (SECURITY_SEVERITIES.includes(query.severity as any)) where.severity = query.severity;
  if (SECURITY_EVENT_TYPES.includes(query.eventType as any)) where.eventType = query.eventType;
  if (query.acknowledged === true || query.acknowledged === false) where.acknowledged = query.acknowledged;
  for (const key of ['userId', 'deviceId', 'sessionId'] as const) {
    if (query[key]) where[key] = query[key];
  }
  if (query.from || query.to) where.createdAt = {
    ...(query.from ? { gte: new Date(query.from) } : {}),
    ...(query.to ? { lte: new Date(query.to) } : {}),
  };
  if (query.riskLevel) where.riskLevel = query.riskLevel;
  if (query.search) where.OR = ['id', 'userId', 'deviceId', 'sessionId', 'connectionId', 'actionTaken', 'metadata'].map(key => ({
    [key]: { contains: query.search, mode: 'insensitive' },
  }));
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
export async function listSecurityEvents(query: SecurityEventQuery, visibility: Prisma.SecurityEventWhereInput = {}) {
  if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
  const { limit, offset } = normaliserPagination(query);
  const where = { AND: [visibility, construireFiltre(query)] };
  const [events, total] = await Promise.all([
    prisma.securityEvent.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset,
    }),
    prisma.securityEvent.count({ where }),
  ]);
  const lisibles = events.map((evenement: any) => (
    evenement?.actionTaken && ACTIONS_HERITEES.has(evenement.actionTaken)
      ? { ...evenement, actionTaken: ACTIONS_HERITEES.get(evenement.actionTaken) }
      : evenement
  ));
  return { events: lisibles, total, limit, offset };
}

/** Compteurs de l'aperçu. Une seule lecture groupée, pas une par carte. */
export async function securityOverview(visibility: Prisma.SecurityEventWhereInput = {}) {
  if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
  const depuis24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [parGravite, unacknowledged, last24h, dernier] = await Promise.all([
    prisma.securityEvent.groupBy({ by: ['severity'], where: visibility, _count: { _all: true } }),
    prisma.securityEvent.count({ where: { AND: [visibility, { acknowledged: false }] } }),
    prisma.securityEvent.count({ where: { AND: [visibility, { createdAt: { gte: depuis24h } }] } }),
    prisma.securityEvent.findFirst({ where: visibility, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
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
export async function acknowledgeSecurityEvents(
  ids: string[], adminId: string, visibility: Prisma.SecurityEventWhereInput = {}, acknowledged = true,
): Promise<number> {
  if (!prisma) throw new Error('SECURITY_DATABASE_REQUIRED');
  const result = await prisma.securityEvent.updateMany({
    where: { AND: [visibility, { id: { in: ids.slice(0, SECURITY_EVENTS_MAX_PAGE_SIZE) }, acknowledged: !acknowledged }] },
    data: { acknowledged, acknowledgedAt: acknowledged ? new Date() : null, acknowledgedById: acknowledged ? adminId : null },
  });
  return result.count;
}
