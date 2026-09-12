/**
 * app-build-manifest — la dernière APK réellement déployée sur le VPS.
 *
 * POURQUOI CE FICHIER EXISTE
 * ──────────────────────────
 * Publier une mise à jour mobile exige trois valeurs exactes : le versionCode,
 * l'URL de l'APK et son condensat SHA-256. Jusqu'ici l'exploitant devait les
 * ressaisir à la main dans le tableau de bord, en les recopiant depuis le
 * journal d'intégration continue. Deux fautes de frappe possibles, toutes deux
 * silencieuses au moment de la publication et coûteuses ensuite :
 *
 *  • un condensat erroné — chaque appareil télécharge les 62 Mo, calcule
 *    l'empreinte, constate l'écart et REFUSE d'installer (`integrity_mismatch`).
 *    La mise à jour échoue partout, sans que rien ne l'annonce à la publication ;
 *  • un versionCode erroné — trop bas, Android refuse l'installation comme un
 *    retour en arrière ; trop haut, l'APK réelle ne sera plus jamais proposée.
 *
 * La chaîne de construction connaît déjà ces valeurs : elle dépose désormais un
 * manifeste à côté de l'APK, dont le condensat et la taille sont relus SUR LE
 * FICHIER DÉPLOYÉ — pas recopiés depuis la machine de build. Ce qui est annoncé
 * au tableau de bord est donc exactement ce que les appareils téléchargeront.
 *
 * Ce manifeste ne publie RIEN par lui-même : il ne fait que proposer. La
 * décision — quels appareils, quels rôles, mise à jour forcée ou non — reste
 * entièrement celle de l'exploitant.
 */
import fs from "fs";
import { normalizeApkSha256 } from "./apk-digest";

/**
 * Emplacement du manifeste déposé par la chaîne de construction.
 *
 * `/var/www/apk` n'est pas servi publiquement et survit au nettoyage des
 * archives (seuls les `.apk` y sont supprimés après chaque build).
 */
const BUILD_MANIFEST_PATH =
  process.env.MOBILE_APP_BUILD_MANIFEST || "/var/www/apk/latest-build.json";

export interface AppBuildManifest {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  apkSha256: string;
  sizeBytes: number;
  releaseTag: string;
  releaseUrl: string;
  commit: string;
  builtAt: string;
}

/**
 * Lit le manifeste de la dernière APK déployée.
 *
 * Rend `null` — jamais une erreur — quand le fichier est absent, illisible ou
 * incomplet : un poste de développement n'en a pas, et l'écran de publication
 * doit rester utilisable à la main dans ce cas.
 *
 * Une URL non HTTPS est refusée ici plutôt que proposée puis rejetée par la
 * validation de publication, qui l'exige déjà.
 */
export function readLatestBuildManifest(): AppBuildManifest | null {
  try {
    if (!fs.existsSync(BUILD_MANIFEST_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(BUILD_MANIFEST_PATH, "utf8"));
    const versionCode = Number(parsed.versionCode);
    const versionName = String(parsed.versionName || "").trim();
    const apkUrl = String(parsed.apkUrl || "").trim();
    const apkSha256 = normalizeApkSha256(parsed.apkSha256);
    if (!Number.isInteger(versionCode) || versionCode <= 0) return null;
    if (!versionName || !apkUrl.startsWith("https://")) return null;
    // Un manifeste sans condensat exploitable ne vaut pas mieux qu'une saisie
    // manuelle : mieux vaut ne rien proposer que proposer une empreinte fausse.
    if (!apkSha256) return null;
    const sizeBytes = Number(parsed.sizeBytes);
    return {
      versionCode,
      versionName,
      apkUrl,
      apkSha256,
      sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
      releaseTag: String(parsed.releaseTag || "").trim(),
      releaseUrl: String(parsed.releaseUrl || "").trim(),
      commit: String(parsed.commit || "").trim(),
      builtAt: String(parsed.builtAt || "").trim(),
    };
  } catch (err) {
    console.warn(`[app-updates] latest-build.json illisible: ${(err as Error).message}`);
    return null;
  }
}

/** Ré-export du chemin par défaut, pour les scripts de déploiement et les tests. */
export const DEFAULT_BUILD_MANIFEST_PATH = BUILD_MANIFEST_PATH;
