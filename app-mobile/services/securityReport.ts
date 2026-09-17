/**
 * Remontée d'intégrité — ce que l'appareil observe, envoyé tel quel.
 *
 * Le module natif sait depuis longtemps repérer un environnement altéré :
 * root, Frida, Xposed, hook, émulateur, signature d'APK non conforme. Ces
 * constats restaient dans les journaux de l'appareil, c'est-à-dire à l'endroit
 * exact où personne ne les lit. Ce service les fait sortir.
 *
 * Trois règles tiennent ce fichier :
 *
 *  1. On envoie des OBSERVATIONS, jamais un verdict. Le score, la gravité et
 *     l'éventuelle sanction appartiennent au serveur. Un appareil compromis est
 *     précisément celui dont la conclusion ne vaut rien.
 *
 *  2. La remontée ne bloque JAMAIS l'application. Une sonde qui échoue, un
 *     réseau absent, un serveur muet : tout est avalé en silence. La sécurité
 *     ne doit pas devenir la cause d'une panne.
 *
 *  3. Rien n'est envoyé quand il n'y a rien à dire. Un appareil sain ne remplit
 *     pas le flux d'alertes de « rien à signaler ».
 */
import { InteractionManager, NativeModules, Platform } from 'react-native';
import apiClient from './apiClient';

interface RapportNatif {
  isRooted?: boolean;
  hasFrida?: boolean;
  hasXposed?: boolean;
  isEmulator?: boolean;
  isHooked?: boolean;
  isSafe?: boolean;
  signatureStatus?: string;
}

interface ModuleNatif {
  checkSecurity?: () => Promise<RapportNatif>;
}

/** Intervalle minimal entre deux remontées, pour ne pas bavarder. */
const INTERVALLE_MS = 30 * 60 * 1000;

/**
 * Délai supplémentaire après le retour au repos.
 *
 * `runAfterInteractions` se déclenche dès la fin des animations en cours ; ce
 * délai laisse en plus respirer le démarrage, où le pont natif est déjà
 * sollicité par l'authentification, le stockage et la configuration.
 */
const DELAI_REPOS_MS = 1_500;

let dernierEnvoi = 0;
let derniereEmpreinte = '';

function natif(): ModuleNatif | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.SxbVpnNative as ModuleNatif | undefined) ?? null;
}

/** Traduit le rapport natif dans le vocabulaire attendu par le serveur. */
export function signauxDepuisRapport(rapport: RapportNatif | null | undefined): Record<string, boolean> {
  if (!rapport) return {};
  const signaux: Record<string, boolean> = {};
  if (rapport.isRooted) signaux.rooted = true;
  if (rapport.hasFrida) signaux.frida = true;
  if (rapport.hasXposed) signaux.xposed = true;
  if (rapport.isHooked) signaux.hooked = true;
  if (rapport.isEmulator) signaux.emulator = true;
  // Seul `INVALID` accuse. `NOT_CONFIGURED` signifie que l'empreinte attendue
  // n'a pas été injectée au build, et `UNAVAILABLE` que la lecture a échoué :
  // ni l'un ni l'autre ne prouve un remballage, et les remonter fabriquerait
  // une alerte critique à chaque build non signé.
  if (rapport.signatureStatus === 'INVALID') signaux.signatureInvalid = true;
  return signaux;
}

/**
 * Collecte et remonte, au plus une fois par intervalle.
 *
 * ELLE N'EST JAMAIS SUR LE CHEMIN D'UNE INTERACTION. Les sondes natives sont
 * coûteuses — deux connexions de socket, la lecture de `/proc/self/maps` — et
 * s'exécutent sur le thread des modules natifs, où chaque autre appel du pont
 * fait la queue derrière. Appelée au démarrage, cette collecte rendait donc
 * toute l'interface poussive pendant plusieurs secondes.
 *
 * Elle attend maintenant que l'application soit au repos, puis laisse encore
 * passer un délai. L'utilisateur n'attend jamais après elle ; au pire, le
 * constat arrive une seconde plus tard, ce dont personne ne dépend.
 *
 * `force` sert aux moments qui comptent — l'ouverture du tunnel — où l'on veut
 * un constat frais même si le précédent est récent. Une observation identique à
 * la précédente n'est pas renvoyée : ce qui intéresse l'exploitant, c'est le
 * changement d'état, pas la répétition.
 */
export async function remonterIntegrite(options: { force?: boolean; decoy?: string } = {}): Promise<void> {
  const module = natif();
  if (!module?.checkSecurity) return;

  const maintenant = Date.now();
  if (!options.force && maintenant - dernierEnvoi < INTERVALLE_MS) return;
  // Le rythme est noté TOUT DE SUITE, avant la moindre sonde. Sans cela, une
  // remontée qui échoue — réseau coupé, serveur muet — laissait le compteur à
  // zéro et faisait relancer les sondes coûteuses à chaque déclenchement
  // suivant, transformant une panne réseau en ralentissement général.
  dernierEnvoi = maintenant;

  // Le travail attend que l'interface ait fini ce qu'elle faisait.
  await new Promise<void>((resoudre) => {
    InteractionManager.runAfterInteractions(() => {
      setTimeout(resoudre, DELAI_REPOS_MS);
    });
  });

  try {
    const rapport = await module.checkSecurity();
    const signaux = signauxDepuisRapport(rapport);
    if (options.decoy) signaux.decoyTouched = true;

    const noms = Object.keys(signaux).sort();
    if (noms.length === 0) {
      // Rien à signaler : on laisse le flux d'alertes tranquille.
      derniereEmpreinte = '';
      return;
    }

    const empreinte = noms.join(',');
    if (!options.force && empreinte === derniereEmpreinte) return;

    await apiClient.post('/mobile-security/report', {
      signals: signaux,
      ...(options.decoy ? { decoy: options.decoy } : {}),
    }, { timeout: 8_000 });

    derniereEmpreinte = empreinte;
  } catch {
    // Silence délibéré : une remontée de sécurité qui échoue ne doit jamais
    // priver l'utilisateur de son VPN ni faire remonter d'exception à l'écran.
  }
}

/** Remet le rythme à zéro. Utilisé à la déconnexion et par les tests. */
export function reinitialiserRemontee(): void {
  dernierEnvoi = 0;
  derniereEmpreinte = '';
}
