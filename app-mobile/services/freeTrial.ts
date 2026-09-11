import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TranslationKey } from '@/localization';
import { apiClient } from './apiClient';

/**
 * Essai gratuit — client mobile.
 *
 * PRINCIPE NON NÉGOCIABLE : le jeton d'essai n'est PAS une configuration VPN.
 * Il ne sert qu'à créer une demande en attente. Tant que l'administration n'a
 * pas déployé l'accès, le backend ne renvoie ni serveur, ni quota, ni dates,
 * ni fichier de configuration. Ce module ne doit donc jamais tenter de dériver
 * un accès à partir du jeton : il se contente de relayer un statut.
 */

/** Statuts renvoyés par `POST /free-trial/status`. */
export type FreeTrialStatus = 'pending' | 'deployed' | 'rejected';

/**
 * Intervalle de vérification automatique du statut.
 *
 * La spécification impose une fenêtre de 2 à 10 minutes, configurable côté
 * développeur. La valeur par défaut se place volontairement au milieu : assez
 * réactive pour l'utilisateur, assez rare pour ne pas réveiller la radio en
 * permanence. Le backend renvoie sa propre borne (`pollIntervalSeconds`) que
 * l'on respecte lorsqu'elle est présente.
 */
export const INTERVALLE_VERIFICATION_MS = 3 * 60 * 1000;
export const INTERVALLE_VERIFICATION_MIN_MS = 2 * 60 * 1000;
export const INTERVALLE_VERIFICATION_MAX_MS = 10 * 60 * 1000;

/** Borne l'intervalle serveur dans la fenêtre autorisée. */
export function intervalleVerificationMs(pollIntervalSeconds?: number | null): number {
  if (typeof pollIntervalSeconds !== 'number' || !Number.isFinite(pollIntervalSeconds)) {
    return INTERVALLE_VERIFICATION_MS;
  }
  const propose = Math.round(pollIntervalSeconds) * 1000;
  if (propose < INTERVALLE_VERIFICATION_MIN_MS) return INTERVALLE_VERIFICATION_MIN_MS;
  if (propose > INTERVALLE_VERIFICATION_MAX_MS) return INTERVALLE_VERIFICATION_MAX_MS;
  return propose;
}

/**
 * Preuve locale d'inscription.
 *
 * `claimSecret` est le seul élément qui autorise cet appareil à relire SA
 * demande. Il n'ouvre aucun accès VPN : il empêche simplement qu'un tiers
 * connaissant un identifiant de demande puisse en consulter le statut.
 */
export interface DemandeEssaiLocale {
  requestId: string;
  claimSecret: string;
  name: string;
  /** Pays déclaré, réaffiché sur l'écran d'attente. */
  country: string | null;
  submittedAt: string;
  status: FreeTrialStatus;
}

/** Réponse d'inscription : strictement descriptive, jamais un accès. */
export interface ReponseInscriptionEssai {
  success: true;
  requestId: string;
  claimSecret: string;
  name: string;
  device: string;
  /** Pays tel qu'il a été ENREGISTRÉ côté serveur (ISO 3166-1 alpha-2). */
  country: string | null;
  status: FreeTrialStatus;
  message: string;
  submittedAt: string;
  pollIntervalSeconds: number;
}

/**
 * Réponse de statut.
 *
 * `accountToken` n'apparaît QUE lorsque l'accès a réellement été déployé pour
 * cet appareil précis. Avant cela, la réponse ne contient rien d'autre que
 * « en attente ».
 */
export interface ReponseStatutEssai {
  requestId: string;
  name: string;
  device: string;
  status: FreeTrialStatus;
  message: string;
  submittedAt: string;
  pollIntervalSeconds: number;
  accountToken?: string;
  reloadRequired?: boolean;
}

const CLE_DEMANDE = '@sxb_free_trial_request';

/** Relit la demande en cours pour ne pas redemander le jeton à l'utilisateur. */
export async function lireDemandeLocale(): Promise<DemandeEssaiLocale | null> {
  try {
    const brut = await AsyncStorage.getItem(CLE_DEMANDE);
    if (!brut) return null;
    const valeur = JSON.parse(brut) as Partial<DemandeEssaiLocale>;
    if (!valeur?.requestId || !valeur?.claimSecret) return null;
    return {
      requestId: valeur.requestId,
      claimSecret: valeur.claimSecret,
      name: valeur.name ?? '',
      country: valeur.country ?? null,
      submittedAt: valeur.submittedAt ?? '',
      status: (valeur.status as FreeTrialStatus) ?? 'pending',
    };
  } catch {
    return null;
  }
}

export async function ecrireDemandeLocale(demande: DemandeEssaiLocale): Promise<void> {
  try {
    await AsyncStorage.setItem(CLE_DEMANDE, JSON.stringify(demande));
  } catch {
    // Une écriture impossible ne doit pas faire échouer l'inscription : la
    // demande existe déjà côté serveur, seule la reprise sera moins fluide.
  }
}

export async function effacerDemandeLocale(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CLE_DEMANDE);
  } catch {
    // Sans conséquence : la demande sera simplement relue une fois de trop.
  }
}

/**
 * ÉTAPE 2 — inscrit l'appareil.
 *
 * Le nom ET le pays sont obligatoires, ici comme côté serveur.
 *
 * `deviceFingerprint` est l'empreinte d'appareil stable à travers une
 * réinstallation. Elle part une seule fois, par cette requête, et n'est jamais
 * conservée localement : c'est elle qui garantit qu'un appareil n'obtient pas
 * un second essai en désinstallant l'application.
 */
export async function inscrireEssaiGratuit(input: {
  token: string;
  name: string;
  country: string;
  deviceId: string;
  deviceFingerprint: string;
  platform?: string;
  appVersion?: string;
}): Promise<ReponseInscriptionEssai> {
  const reponse = await apiClient.post<ReponseInscriptionEssai>('/free-trial/enroll', {
    token: input.token.trim().toUpperCase(),
    name: input.name.trim(),
    country: input.country.trim().toUpperCase(),
    deviceId: input.deviceId,
    deviceFingerprint: input.deviceFingerprint,
    platform: input.platform,
    appVersion: input.appVersion,
  });
  return reponse.data;
}

/** ÉTAPE 5 — interroge le statut. Ne révèle rien tant que rien n'est déployé. */
export async function verifierStatutEssai(input: {
  requestId: string;
  claimSecret: string;
  deviceId: string;
}): Promise<ReponseStatutEssai> {
  const reponse = await apiClient.post<ReponseStatutEssai>('/free-trial/status', {
    requestId: input.requestId,
    claimSecret: input.claimSecret,
    deviceId: input.deviceId,
  });
  return reponse.data;
}

/** Normalise la saisie du jeton : majuscules, sans espaces parasites. */
export function normaliserJetonEssai(valeur: string): string {
  return valeur.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Traduit une erreur d'inscription en clé de traduction.
 *
 * Aucun message serveur brut n'est affiché : il pourrait contenir un détail
 * technique et l'application est bilingue.
 */
export function cleErreurEssai(erreur: unknown): TranslationKey {
  // Empreinte impossible à lire : l'erreur naît dans l'application, pas dans
  // une réponse serveur, et doit être annoncée sans jargon.
  if ((erreur as { name?: string })?.name === 'EmpreinteIndisponible') {
    return 'free_trial_error_fingerprint';
  }
  const code = (erreur as { response?: { data?: { error?: string } } })?.response?.data?.error;
  switch (code) {
    case 'errors.free_trial.token_invalid':
      return 'free_trial_error_token';
    case 'errors.free_trial.token_revoked':
      return 'free_trial_error_revoked';
    case 'errors.free_trial.token_expired':
      return 'free_trial_error_expired';
    case 'errors.free_trial.token_exhausted':
      return 'free_trial_error_exhausted';
    case 'errors.free_trial.device_required':
      return 'free_trial_error_device';
    case 'errors.free_trial.fingerprint_required':
      return 'free_trial_error_fingerprint';
    // Refus volontairement sobre : l'appareil a déjà eu son essai, et rien
    // n'est dit de la personne qui l'a utilisé.
    case 'errors.free_trial.device_already_used':
      return 'free_trial_error_already_used';
    case 'errors.free_trial.country_invalid':
      return 'free_trial_error_country';
    case 'errors.validation':
      return 'free_trial_error_name';
    default:
      return 'free_trial_error_generic';
  }
}
