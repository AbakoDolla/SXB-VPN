/**
 * security-gate — le verrou du Centre de sécurité.
 *
 * POURQUOI UN SECOND VERROU
 * ─────────────────────────
 * Être connecté au tableau de bord, même en OWNER, ne suffit pas à ouvrir le
 * Centre de sécurité. Une session laissée ouverte sur un poste, un onglet
 * oublié, un vol de jeton : chacun de ces cas donnerait accès aux événements de
 * sécurité, aux appareils bloqués et aux motifs de blocage.
 *
 * Le Centre exige donc, EN PLUS du rôle :
 *   1. un mot de passe défini par le propriétaire, distinct de son mot de passe
 *      de connexion — le connaître ne donne aucun autre droit ;
 *   2. une clé d'accès (WebAuthn) dès qu'au moins une est enrôlée, c'est-à-dire
 *      l'empreinte digitale du poste.
 *
 * CE QUE CE MODULE REPREND DE `profile-lock`
 * ──────────────────────────────────────────
 * Exactement la même mécanique, déjà éprouvée pour les configurations VPN :
 * hachage bcrypt, preuve signée à durée de vie courte, transportée par EN-TÊTE
 * — jamais dans une URL, jamais dans le stockage persistant du navigateur, et
 * donc jamais dans les journaux d'accès du serveur.
 *
 * CE QUE LE VERROU NE FAIT PAS
 * ────────────────────────────
 * Il ne remplace ni le rôle, ni les permissions. Un compte sans le rôle requis
 * ne franchit pas le verrou même avec le mot de passe : la vérification du rôle
 * précède toujours celle de la preuve.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator, type RateLimitExceededEventHandler } from 'express-rate-limit';
import { config } from '../config';
import { prisma } from '../database';
import type { AuthenticatedRequest } from '../middleware/auth';

/** Clé de réglage portant le verrou. */
export const SECURITY_GATE_SETTING_KEY = 'sxb.security-gate.v1';

/** Durée de validité d'une ouverture. Courte : c'est une console sensible. */
export const SECURITY_UNLOCK_SECONDS = 600;

/** En-tête qui porte la preuve d'ouverture. */
export const SECURITY_UNLOCK_HEADER = 'X-SXB-Security-Unlock';

/**
 * Rôles admis dans le Centre.
 *
 * `OWNER` définit le mot de passe ; `SUPER_ADMIN` peut s'en servir. Aucun autre
 * rôle n'entre, quelles que soient ses permissions RBAC : une permission mal
 * cochée ne doit pas ouvrir une console de sécurité.
 */
export const SECURITY_CENTER_ROLES = ['OWNER', 'SUPER_ADMIN'] as const;

const audience = 'sxb:security-unlock';
const signingKey = () => createHmac('sha256', config.JWT_SECRET).update(audience).digest();

export class SecurityGateError extends Error {
  // Champs déclarés explicitement : une propriété de paramètre
  // (`constructor(public status)`) n'est pas compilable par le mode
  // « strip-only » de Node, celui qu'utilisent les tests du dépôt.
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function handleSecurityGateError(error: unknown, res: Response): boolean {
  if (error instanceof SecurityGateError) {
    res.status(error.status).json({ error: error.code, code: error.code });
    return true;
  }
  return false;
}

export interface SecurityGateState {
  passwordHash: string;
  version: number;
  updatedAt: string;
  updatedById: string | null;
}

/**
 * Exigences du mot de passe.
 *
 * Douze caractères minimum — plus que les huit du verrou de configuration :
 * ce mot de passe ouvre la console qui décrit les défenses elles-mêmes. La
 * borne haute de 72 octets est celle de bcrypt, qui tronque silencieusement
 * au-delà ; l'accepter ferait croire à une longueur qui n'est pas vérifiée.
 */
export function validateGatePassword(value: unknown): string {
  if (typeof value !== 'string' || [...value].length < 12 ||
      Buffer.byteLength(value, 'utf8') > 72 || value.includes('\0') || !value.trim()) {
    throw new SecurityGateError(400, 'SECURITY_GATE_PASSWORD_INVALID');
  }
  return value;
}

export async function readSecurityGate(): Promise<SecurityGateState | null> {
  if (!prisma) return null;
  const row = await (prisma as any).setting.findUnique({ where: { key: SECURITY_GATE_SETTING_KEY } });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed?.passwordHash !== 'string' || !parsed.passwordHash) return null;
    return {
      passwordHash: parsed.passwordHash,
      version: Number.isSafeInteger(parsed.version) ? parsed.version : 1,
      updatedAt: String(parsed.updatedAt || new Date(0).toISOString()),
      updatedById: typeof parsed.updatedById === 'string' ? parsed.updatedById : null,
    };
  } catch {
    // Un réglage illisible n'ouvre pas le verrou : il le ferme.
    return null;
  }
}

/**
 * Définit ou fait tourner le mot de passe.
 *
 * Une rotation INCRÉMENTE la version, ce qui invalide instantanément toutes les
 * preuves d'ouverture déjà émises : changer le mot de passe doit fermer les
 * consoles ouvertes, sinon la rotation ne protègerait de rien.
 */
export async function writeSecurityGate(password: unknown, ownerId: string): Promise<SecurityGateState> {
  if (!prisma) throw new SecurityGateError(503, 'DB_UNAVAILABLE');
  const current = await readSecurityGate();
  const next: SecurityGateState = {
    passwordHash: await bcrypt.hash(validateGatePassword(password), 12),
    version: (current?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedById: ownerId,
  };
  await (prisma as any).setting.upsert({
    where: { key: SECURITY_GATE_SETTING_KEY },
    create: { key: SECURITY_GATE_SETTING_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

/** Vérifie le mot de passe du verrou. Ne dit jamais POURQUOI il échoue. */
export async function verifyGatePassword(password: unknown): Promise<SecurityGateState> {
  const gate = await readSecurityGate();
  // Comparer quand même, pour que l'absence de verrou ne se distingue pas d'un
  // mauvais mot de passe par le temps de réponse.
  const candidate = typeof password === 'string' ? password : '';
  const hash = gate?.passwordHash ?? '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = await bcrypt.compare(candidate, hash);
  if (!gate || !ok) throw new SecurityGateError(403, 'SECURITY_GATE_REJECTED');
  return gate;
}

/**
 * Émet la preuve d'ouverture.
 *
 * `passkeyVerified` est inscrit DANS la preuve : une console ouverte sans clé
 * d'accès ne doit pas pouvoir s'en réclamer plus tard pour une opération qui
 * l'exige.
 */
export function issueSecurityUnlock(gate: SecurityGateState, userId: string, passkeyVerified: boolean) {
  const exp = Math.floor(Date.now() / 1000) + SECURITY_UNLOCK_SECONDS;
  const unlockToken = jwt.sign(
    { sub: userId, version: gate.version, passkey: passkeyVerified, exp },
    signingKey(),
    { algorithm: 'HS256', audience },
  );
  return { unlockToken, expiresAt: new Date(exp * 1000).toISOString(), passkeyVerified };
}

export interface SecurityUnlockClaims {
  expiresAt: number;
  passkeyVerified: boolean;
}

/** Relit la preuve portée par l'en-tête. `null` = fermé, sans exception. */
export function readSecurityUnlock(
  req: AuthenticatedRequest,
  gate: SecurityGateState | null,
): SecurityUnlockClaims | null {
  const token = req.get(SECURITY_UNLOCK_HEADER);
  if (!gate || !req.user || typeof token !== 'string' || token.length > 2048) return null;
  try {
    const payload = jwt.verify(token, signingKey(), { algorithms: ['HS256'], audience });
    if (typeof payload === 'string' || payload.sub !== req.user.userId ||
        payload.version !== gate.version ||
        typeof payload.exp !== 'number' || typeof payload.iat !== 'number' ||
        payload.exp - payload.iat > SECURITY_UNLOCK_SECONDS) return null;
    return { expiresAt: payload.exp * 1000, passkeyVerified: (payload as any).passkey === true };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return null;
    throw error;
  }
}

/** Le rôle est-il admis dans le Centre ? Vérifié AVANT toute preuve. */
export function hasSecurityCenterRole(req: AuthenticatedRequest): boolean {
  return SECURITY_CENTER_ROLES.includes(req.user?.role as any);
}

/** Comparaison à temps constant de deux chaînes encodées. */
export function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const rateLimitHandler: RateLimitExceededEventHandler = (_req, res) => {
  res.status(429).json({
    error: 'SECURITY_GATE_RATE_LIMITED', code: 'SECURITY_GATE_RATE_LIMITED',
    retryAfterSeconds: Number(res.getHeader('Retry-After')) || 900,
  });
};

/**
 * Budgets INDÉPENDANTS : changer d'adresse ne remet pas à zéro le compteur du
 * compte, et inversement. Aucun mot de passe ni preuve n'entre dans une clé de
 * limitation — une clé dérivée du secret le ferait fuir par les métriques.
 */
export const securityUnlockLimiters = [
  rateLimit({
    windowMs: 900_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(req.ip || 'unknown'),
    handler: rateLimitHandler,
  }),
  rateLimit({
    windowMs: 900_000, limit: 5, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req: AuthenticatedRequest) => `security:${req.user?.userId ?? 'anon'}`,
    handler: rateLimitHandler,
  }),
];
