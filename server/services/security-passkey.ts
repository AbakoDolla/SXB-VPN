/**
 * security-passkey — l'empreinte digitale du Centre de sécurité (WebAuthn).
 *
 * CE QUI EST RÉELLEMENT VÉRIFIÉ
 * ─────────────────────────────
 * L'empreinte ne quitte JAMAIS le poste. Le capteur déverrouille une clé privée
 * détenue par l'authentificateur de plateforme (Windows Hello, Touch ID,
 * capteur Android) ; celui-ci signe un défi que nous avons émis. Le serveur ne
 * stocke que la clé PUBLIQUE et vérifie la signature.
 *
 * Contrôles appliqués à chaque authentification, tous nécessaires :
 *  • le défi signé est bien celui que nous venons d'émettre, à usage unique ;
 *  • l'origine annoncée par le navigateur est exactement la nôtre — sans ce
 *    contrôle, un site tiers pourrait relayer une signature ;
 *  • l'empreinte du domaine (`rpIdHash`) correspond au nôtre ;
 *  • le drapeau « présence utilisateur » est levé ;
 *  • le drapeau « vérification utilisateur » est levé — c'est LUI qui distingue
 *    une simple présence d'une véritable empreinte ou d'un code local ;
 *  • le compteur anti-rejeu n'a pas reculé.
 *
 * POURQUOI AUCUNE DÉPENDANCE
 * ──────────────────────────
 * Une bibliothèque WebAuthn sert surtout à décoder le CBOR de l'attestation.
 * On l'évite entièrement : à l'enrôlement, le NAVIGATEUR expose déjà la clé
 * publique au format SPKI (`getPublicKey()`), que `node:crypto` sait vérifier
 * telle quelle. Rien n'est réimplémenté à la main côté cryptographie.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { config } from '../config';
import { prisma } from '../database';
import { SecurityGateError, equalsConstantTime } from './security-gate';

/** Durée de vie d'un défi. Assez pour poser un doigt, pas pour être rejoué. */
const CHALLENGE_TTL_MS = 120_000;

/** Algorithmes COSE acceptés : ES256 puis RS256, les deux universels. */
export const SUPPORTED_ALGORITHMS = [-7, -257] as const;

/**
 * Origine du tableau de bord.
 *
 * WebAuthn lie une clé à un domaine : s'en remettre à l'en-tête `Origin` de la
 * requête reviendrait à laisser l'attaquant choisir le domaine qu'il vérifie.
 * La valeur est donc de configuration, jamais lue dans la requête.
 */
export function dashboardOrigin(): string {
  const brut = (process.env.DASHBOARD_ORIGIN || 'https://vpnsxb.afrihall.com').trim();
  return brut.replace(/\/+$/, '');
}

/** Domaine relié (`rpId`) : l'hôte de l'origine, sans port ni schéma. */
export function relyingPartyId(): string {
  try {
    return new URL(dashboardOrigin()).hostname;
  } catch {
    return 'vpnsxb.afrihall.com';
  }
}

interface DefiEnCours {
  challenge: string;
  userId: string;
  usage: 'register' | 'authenticate';
  expiresAt: number;
}

/**
 * Défis en mémoire.
 *
 * Volontairement NON persistés : un défi doit mourir avec le processus qui l'a
 * émis. Le volume est négligeable — un défi par ouverture de console — et la
 * purge est faite à chaque émission, donc sans minuterie qui tournerait pour
 * rien.
 */
const defis = new Map<string, DefiEnCours>();

function purger(maintenant = Date.now()): void {
  for (const [id, defi] of defis) if (defi.expiresAt <= maintenant) defis.delete(id);
}

export function issueChallenge(userId: string, usage: 'register' | 'authenticate') {
  purger();
  const challengeId = randomBytes(16).toString('base64url');
  const challenge = randomBytes(32).toString('base64url');
  defis.set(challengeId, { challenge, userId, usage, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return {
    challengeId,
    challenge,
    rpId: relyingPartyId(),
    timeoutMs: CHALLENGE_TTL_MS,
    algorithms: [...SUPPORTED_ALGORITHMS],
  };
}

/**
 * Identifiants des empreintes enrôlées par ce compte.
 *
 * Le navigateur en a BESOIN pour retrouver la bonne clé. Une empreinte de
 * plateforme n'est pas forcément « découvrable » : Windows Hello et plusieurs
 * capteurs Android créent une clé que l'authentificateur ne sait retrouver que
 * si on lui présente son identifiant. Sans cette liste, la vérification ne
 * trouve rien et le propriétaire reste dehors, sans aucun recours — c'est
 * exactement ce qui est arrivé.
 *
 * La liste ne révèle rien d'exploitable : elle n'est servie qu'après un mot de
 * passe valide, et un identifiant de clé publique ne permet aucune signature.
 */
export async function credentialIdsFor(userId: string): Promise<string[]> {
  if (!prisma) return [];
  try {
    const lignes = await (prisma as any).securityPasskey.findMany({
      where: { userId },
      select: { credentialId: true },
      orderBy: { createdAt: 'asc' },
    });
    return lignes.map((ligne: any) => String(ligne.credentialId)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Retire TOUTES les empreintes d'un compte. Voie de secours du propriétaire.
 *
 * Renvoie le nombre d'empreintes retirées. Aucune autre donnée n'est touchée :
 * le mot de passe de la porte, lui, reste en place.
 */
export async function deleteAllPasskeys(userId: string): Promise<number> {
  if (!prisma) return 0;
  const resultat = await (prisma as any).securityPasskey.deleteMany({ where: { userId } });
  return Number(resultat?.count ?? 0);
}

/** Consomme un défi : un même défi ne peut jamais servir deux fois. */
function consommerDefi(challengeId: unknown, userId: string, usage: 'register' | 'authenticate'): string {
  purger();
  if (typeof challengeId !== 'string') throw new SecurityGateError(400, 'SECURITY_CHALLENGE_INVALID');
  const defi = defis.get(challengeId);
  defis.delete(challengeId);
  if (!defi || defi.userId !== userId || defi.usage !== usage || defi.expiresAt <= Date.now()) {
    throw new SecurityGateError(400, 'SECURITY_CHALLENGE_INVALID');
  }
  return defi.challenge;
}

function base64url(valeur: unknown, champ: string): Buffer {
  if (typeof valeur !== 'string' || !valeur || valeur.length > 20_000) {
    throw new SecurityGateError(400, `SECURITY_PASSKEY_${champ}_INVALID`);
  }
  try {
    return Buffer.from(valeur, 'base64url');
  } catch {
    throw new SecurityGateError(400, `SECURITY_PASSKEY_${champ}_INVALID`);
  }
}

/** Vérifie le bloc `clientDataJSON` commun à l'enrôlement et à la connexion. */
function verifierClientData(brut: Buffer, attendu: string, type: 'webauthn.create' | 'webauthn.get'): void {
  let donnees: any;
  try {
    donnees = JSON.parse(brut.toString('utf8'));
  } catch {
    throw new SecurityGateError(400, 'SECURITY_PASSKEY_CLIENTDATA_INVALID');
  }
  if (donnees?.type !== type) throw new SecurityGateError(400, 'SECURITY_PASSKEY_TYPE_INVALID');
  if (typeof donnees?.challenge !== 'string' || !equalsConstantTime(donnees.challenge, attendu)) {
    throw new SecurityGateError(400, 'SECURITY_CHALLENGE_INVALID');
  }
  // Comparaison EXACTE de l'origine : un sous-domaine voisin n'est pas la même
  // origine, et c'est précisément ce qu'un hameçonnage exploiterait.
  if (donnees?.origin !== dashboardOrigin()) {
    throw new SecurityGateError(400, 'SECURITY_PASSKEY_ORIGIN_INVALID');
  }
}

/**
 * Enrôle une clé d'accès.
 *
 * La clé publique arrive déjà au format SPKI, exposé par le navigateur : elle
 * est validée en la chargeant réellement, pas en faisant confiance à sa forme.
 */
export async function registerPasskey(userId: string, corps: any) {
  if (!prisma) throw new SecurityGateError(503, 'DB_UNAVAILABLE');
  const attendu = consommerDefi(corps?.challengeId, userId, 'register');
  verifierClientData(base64url(corps?.clientDataJSON, 'CLIENTDATA'), attendu, 'webauthn.create');

  const algorithm = Number(corps?.algorithm);
  if (!SUPPORTED_ALGORITHMS.includes(algorithm as any)) {
    throw new SecurityGateError(400, 'SECURITY_PASSKEY_ALGORITHM_UNSUPPORTED');
  }
  const spki = base64url(corps?.publicKey, 'PUBLICKEY');
  try {
    createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new SecurityGateError(400, 'SECURITY_PASSKEY_PUBLICKEY_INVALID');
  }
  const credentialId = String(corps?.credentialId || '');
  if (!credentialId || credentialId.length > 512) {
    throw new SecurityGateError(400, 'SECURITY_PASSKEY_CREDENTIAL_INVALID');
  }
  const label = typeof corps?.label === 'string' ? corps.label.trim().slice(0, 80) : '';

  return (prisma as any).securityPasskey.create({
    data: {
      userId,
      credentialId,
      publicKey: spki.toString('base64'),
      algorithm,
      signCount: Number.isSafeInteger(Number(corps?.signCount)) ? Math.max(0, Number(corps.signCount)) : 0,
      label: label || null,
    },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
  });
}

/** Drapeaux du bloc `authenticatorData`. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/**
 * Vérifie une authentification par clé d'accès.
 *
 * Rend `true` uniquement si TOUT concorde. Toute anomalie lève : on ne rend
 * jamais « à moitié vérifié ».
 */
export async function verifyPasskeyAssertion(userId: string, corps: any): Promise<void> {
  if (!prisma) throw new SecurityGateError(503, 'DB_UNAVAILABLE');
  const attendu = consommerDefi(corps?.challengeId, userId, 'authenticate');

  const credentialId = String(corps?.credentialId || '');
  const cle = credentialId
    ? await (prisma as any).securityPasskey.findUnique({ where: { credentialId } })
    : null;
  // Une clé inconnue et une clé appartenant à quelqu'un d'autre donnent le même
  // refus : la réponse ne doit pas dire laquelle des deux.
  if (!cle || cle.userId !== userId) throw new SecurityGateError(403, 'SECURITY_PASSKEY_REJECTED');

  const clientDataJSON = base64url(corps?.clientDataJSON, 'CLIENTDATA');
  verifierClientData(clientDataJSON, attendu, 'webauthn.get');

  const authenticatorData = base64url(corps?.authenticatorData, 'AUTHDATA');
  if (authenticatorData.length < 37) throw new SecurityGateError(400, 'SECURITY_PASSKEY_AUTHDATA_INVALID');

  const rpIdHash = authenticatorData.subarray(0, 32);
  const attenduRpId = createHash('sha256').update(relyingPartyId()).digest();
  if (!rpIdHash.equals(attenduRpId)) throw new SecurityGateError(403, 'SECURITY_PASSKEY_RPID_INVALID');

  const flags = authenticatorData[32];
  if (!(flags & FLAG_USER_PRESENT)) throw new SecurityGateError(403, 'SECURITY_PASSKEY_PRESENCE_REQUIRED');
  // C'est ce drapeau qui atteste d'une empreinte, d'un visage ou d'un code
  // local — sans lui, une clé simplement branchée suffirait.
  if (!(flags & FLAG_USER_VERIFIED)) throw new SecurityGateError(403, 'SECURITY_PASSKEY_VERIFICATION_REQUIRED');

  const signCount = authenticatorData.readUInt32BE(33);
  // Un compteur qui recule trahit une clé clonée. Les authentificateurs qui ne
  // comptent pas renvoient zéro en permanence : ce cas reste accepté.
  if (signCount !== 0 && signCount <= cle.signCount) {
    throw new SecurityGateError(403, 'SECURITY_PASSKEY_REPLAY_DETECTED');
  }

  const signature = base64url(corps?.signature, 'SIGNATURE');
  const signe = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
  const publique = createPublicKey({ key: Buffer.from(cle.publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!verifySignature('sha256', signe, publique, signature)) {
    throw new SecurityGateError(403, 'SECURITY_PASSKEY_REJECTED');
  }

  await (prisma as any).securityPasskey.update({
    where: { id: cle.id },
    data: { signCount: Math.max(signCount, cle.signCount), lastUsedAt: new Date() },
  });
}

/** Clés enrôlées pour ce compte. Ne renvoie jamais la clé publique. */
export async function listPasskeys(userId: string) {
  if (!prisma) return [];
  return (prisma as any).securityPasskey.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
  });
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  if (!prisma) throw new SecurityGateError(503, 'DB_UNAVAILABLE');
  const result = await (prisma as any).securityPasskey.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** Empreinte non réversible d'une adresse, pour regrouper sans jamais exposer. */
export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${config.JWT_SECRET}:${ip}`).digest('base64url').slice(0, 22);
}
