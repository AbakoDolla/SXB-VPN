import { NO_CONSENT, type PrivacyConsent } from './privacyPolicy';

/**
 * Consentement de confidentialité — accordé d'office.
 *
 * Ce mécanisme existait pour la publication Google Play, qui exige un écran de
 * divulgation bloquant avant toute connexion VPN. SXB n'y publie plus, et le
 * canal direct n'a jamais posé cette barrière : l'utilisateur qui installe
 * l'APK et saisit son jeton consent par le geste même.
 *
 * La forme est conservée — les écrans lisent toujours `getPrivacyConsent()` —
 * mais elle ne peut plus REFUSER. Le retrait du canal Play supprime donc la
 * barrière sans toucher aux appelants.
 *
 * `savePrivacyConsent` reste présent et refuse explicitement : un écran qui
 * tenterait encore de retirer le consentement échouerait bruyamment plutôt que
 * de laisser croire à un retrait qui n'aurait aucun effet.
 */
const consent: PrivacyConsent = { ...NO_CONSENT, vpn: true, diagnostics: true, notifications: true };
let generation = new AbortController();
const listeners = new Set<() => void>();

export const getPrivacyConsent = () => consent;
export const getPrivacySignal = () => generation.signal;
export const subscribePrivacyConsent = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * Garde conservée aux points d'entrée du tunnel.
 *
 * Elle ne peut plus échouer, et c'est délibéré : la laisser en place évite
 * qu'un futur retour de la notion de consentement doive retrouver tous les
 * endroits où elle devait être posée.
 */
export function requireVpnConsent(): void {
  if (!consent.vpn) throw new Error('privacy_consent_required');
}

/** Sans canal Play, il n'y a rien à charger : le consentement est acquis. */
export async function loadPrivacyConsent(): Promise<void> {
  generation.abort();
  generation = new AbortController();
  listeners.forEach(listener => listener());
}

/** Plus aucun écran ne retire le consentement : l'appeler est une erreur. */
export async function savePrivacyConsent(_next: PrivacyConsent): Promise<void> {
  throw new Error('privacy_consent_immutable');
}
