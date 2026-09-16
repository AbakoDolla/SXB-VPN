/**
 * Attestation Play Integrity — vérifier que l'installation est authentique.
 *
 * Google signe un jugement sur l'installation : binaire reconnu, compte Play
 * légitime, appareil non compromis. C'est le seul signal de cette chaîne qui ne
 * repose pas sur ce que l'appareil veut bien dire de lui-même — et donc le seul
 * qu'un client remballé ne puisse pas simplement taire.
 *
 * TANT QUE LES IDENTIFIANTS NE SONT PAS CONFIGURÉS, CE MODULE EST INERTE.
 * Il renvoie `not_configured`, ce qui ne produit AUCUN signal. C'est
 * délibéré : une attestation absente n'est pas une attestation refusée, et
 * traiter l'une comme l'autre déclencherait une alerte critique sur chaque
 * appareil du parc le jour du déploiement.
 *
 * Configuration attendue :
 *   PLAY_INTEGRITY_PACKAGE   nom du paquet à exiger dans le verdict
 *   PLAY_INTEGRITY_API_KEY   clé d'API Google Cloud autorisée sur playintegrity
 *
 * Le jeton est déchiffré par Google, pas ici : on ne détient aucune clé de
 * déchiffrement, et le verdict n'est jamais fabriqué localement.
 */
import { config } from '../config';

export type ResultatAttestation =
  | { statut: 'not_configured' }
  | { statut: 'valid'; verdicts: Record<string, string> }
  | { statut: 'refused'; raison: string }
  | { statut: 'unavailable'; raison: string };

const POINT_GOOGLE = 'https://playintegrity.googleapis.com/v1';

function lireConfiguration(): { paquet: string; cle: string } | null {
  const paquet = (config as any).PLAY_INTEGRITY_PACKAGE;
  const cle = (config as any).PLAY_INTEGRITY_API_KEY;
  if (typeof paquet !== 'string' || typeof cle !== 'string') return null;
  if (!paquet.trim() || !cle.trim()) return null;
  return { paquet: paquet.trim(), cle: cle.trim() };
}

/** L'attestation est-elle exploitable sur cette installation ? */
export function attestationConfiguree(): boolean {
  return lireConfiguration() !== null;
}

/**
 * Soumet un jeton à Google et interprète son verdict.
 *
 * Toute panne — réseau, quota, Google indisponible — rend `unavailable` et non
 * `refused`. Confondre les deux ferait d'une coupure de réseau chez Google une
 * vague de blocages chez nous.
 */
export async function verifierAttestation(jeton: string): Promise<ResultatAttestation> {
  const reglages = lireConfiguration();
  if (!reglages) return { statut: 'not_configured' };
  if (typeof jeton !== 'string' || jeton.length < 20 || jeton.length > 8000) {
    return { statut: 'refused', raison: 'token_malformed' };
  }

  let charge: any;
  try {
    const reponse = await fetch(
      `${POINT_GOOGLE}/${encodeURIComponent(reglages.paquet)}:decodeIntegrityToken?key=${encodeURIComponent(reglages.cle)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrityToken: jeton }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!reponse.ok) {
      return { statut: 'unavailable', raison: `http_${reponse.status}` };
    }
    charge = await reponse.json();
  } catch (erreur: any) {
    return { statut: 'unavailable', raison: erreur?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }

  const verdict = charge?.tokenPayloadExternal;
  if (!verdict) return { statut: 'unavailable', raison: 'empty_verdict' };

  // Le paquet doit être le nôtre : un jeton valide émis pour une AUTRE
  // application resterait cryptographiquement correct.
  const paquetAtteste = verdict?.appIntegrity?.packageName;
  if (paquetAtteste && paquetAtteste !== reglages.paquet) {
    return { statut: 'refused', raison: 'package_mismatch' };
  }

  const appIntegrity = String(verdict?.appIntegrity?.appRecognitionVerdict ?? '');
  const deviceIntegrity: string[] = Array.isArray(verdict?.deviceIntegrity?.deviceRecognitionVerdict)
    ? verdict.deviceIntegrity.deviceRecognitionVerdict
    : [];
  const compte = String(verdict?.accountDetails?.appLicensingVerdict ?? '');

  const verdicts = {
    app: appIntegrity || 'unknown',
    device: deviceIntegrity.join(',') || 'none',
    licensing: compte || 'unknown',
  };

  // Le binaire n'est pas celui que Google a signé : c'est un remballage.
  if (appIntegrity && appIntegrity !== 'PLAY_RECOGNIZED') {
    return { statut: 'refused', raison: `app_${appIntegrity.toLowerCase()}` };
  }
  // Aucun verdict d'appareil : l'installation tourne hors d'un Android intègre.
  if (deviceIntegrity.length === 0) {
    return { statut: 'refused', raison: 'device_unrecognized' };
  }

  return { statut: 'valid', verdicts };
}

/**
 * Traduit un résultat en observation pour le moteur de risque.
 *
 * Seul un refus produit un signal. Une attestation absente ou indisponible n'en
 * produit aucun : elle ne prouve rien.
 */
export function signalDepuisAttestation(resultat: ResultatAttestation): boolean {
  return resultat.statut === 'refused';
}
