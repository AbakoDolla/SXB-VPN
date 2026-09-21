/**
 * xapi — Endpoint public léger pour l'application mobile.
 *
 * Surface réelle de ce routeur, vérifiée ligne à ligne :
 *   GET  /xapi/mobile/app-version → publication de mise à jour in-app
 *   HEAD /xapi/mobile/app-version → sonde de disponibilité
 *
 * L'en-tête précédent annonçait aussi `GET /xapi/mobile/ip`, qui n'existe dans
 * aucune des deux copies du dépôt, et `POST /mobile/connections/:id/status`,
 * retiré : c'était un doublon dégradé et non authentifié de `mobile.ts`.
 *
 * ── Pourquoi cet endpoint est monté sous /xapi et non sous /api ─────────────
 * Il doit répondre SANS jeton et rester joignable en mode maintenance (voir
 * server.ts l.174-179 et l'exclusion `!pathname.startsWith("/xapi/")` l.234) :
 * une application dont la session a expiré doit pouvoir apprendre qu'une mise
 * à jour existe.
 *
 * ── Limite connue, mesurée, et NON corrigeable depuis ce dépôt ──────────────
 * nginx réécrit `^/xapi(/.*)$ → /api$1` avant d'atteindre le processus. Depuis
 * Internet, `/xapi/mobile/app-version` aboutit donc à `/api/mobile/app-version`
 * et rend 401 ; sur le port applicatif (127.0.0.1:4000, nginx contourné), le
 * même chemin rend bien 200. Ce routeur n'est donc pas du code mort : il est
 * vivant et momentanément inatteignable de l'extérieur.
 *
 * Cette réécriture est PORTANTE, pas accidentelle : `deploy-vps.yml` l.591
 * sonde `/xapi/auth/login` (chemin absent d'ici, qui ne résout que grâce à
 * elle) et `artifacts/sxb-dashboard/vite.config.ts` reproduit la convention en
 * développement. La retirer sans précaution casserait le déploiement.
 * Correction hors dépôt, décision du propriétaire : ne pas traiter ici.
 */
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getMobileAppUpdate, readPublishedAppUpdate, toMobileAppVersion } from "../services/app-update";

const router = Router();

// Emplacement du fichier version.json (surchargeable par variable d'env).
// Le workflow CI dépose ce fichier ici sur le VPS.
const VERSION_JSON_PATH =
  process.env.MOBILE_APP_VERSION_FILE ||
  "/var/www/apk/version.json";

// URL publique par défaut de l'APK distribué (surchargeable par variable d'env).
//
// Le workflow CI dépose l'APK à DEUX endroits (build-android.yml) :
//   • /var/www/sxb-vpn/dist/download/  → servi publiquement sous /download/
//   • /var/www/apk/                    → archive de diagnostic, NON publique
//
// Cette constante pointait vers le second : l'URL renvoyait la page HTML de
// repli du dashboard (SPA) au lieu du binaire, et l'application téléchargeait
// donc un fichier de 1,5 Ko impossible à installer.
const DEFAULT_APK_URL =
  process.env.MOBILE_APP_APK_URL ||
  "https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk";

interface AppVersionPayload {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  notes?: string;
  publishedAt?: string;
}

function readVersionFile(): AppVersionPayload | null {
  try {
    if (!fs.existsSync(VERSION_JSON_PATH)) return null;
    const raw = fs.readFileSync(VERSION_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const versionCode = Number(parsed.versionCode);
    const versionName = String(parsed.versionName || "");
    if (!Number.isFinite(versionCode) || !versionName) return null;
    return {
      versionCode,
      versionName,
      apkUrl: String(parsed.apkUrl || DEFAULT_APK_URL),
      notes: parsed.notes ? String(parsed.notes) : undefined,
      publishedAt: parsed.publishedAt ? String(parsed.publishedAt) : undefined,
    };
  } catch (err) {
    console.warn(`[xapi/app-version] version.json invalide: ${(err as Error).message}`);
    return null;
  }
}

function fallbackVersion(): AppVersionPayload {
  // Valeurs de repli — n'entraînent PAS de proposition de mise à jour
  // pour un client sur la même versionCode installée.
  return {
    versionCode: Number(process.env.MOBILE_APP_VERSION_CODE || 7),
    versionName: process.env.MOBILE_APP_VERSION_NAME || "1.2.0",
    apkUrl: DEFAULT_APK_URL,
  };
}

// ── GET /xapi/mobile/app-version ─────────────────────────────────────────────
// Endpoint public, sans authentification, léger : appelé au lancement de l'app
// et toutes les 24 h. Renvoie versionCode/versionName/apkUrl (JSON).
router.get("/mobile/app-version", async (req: Request, res: Response) => {
  const deviceId = String(req.headers["x-sxb-device-id"] || req.query.deviceId || "").trim();
  const storedPublication = await readPublishedAppUpdate().catch(() => null);
  const published = storedPublication ? await getMobileAppUpdate(deviceId).catch(() => null) : null;
  const payload = published
    ? toMobileAppVersion(published)
    : { versionCode: 0, versionName: "", apkUrl: "", apkSha256: "", notes: "", minSupportedCode: 0, forceUpdate: false };
  res.set("Cache-Control", "private, max-age=300");
  res.json(payload);
});

// ── HEAD /xapi/mobile/app-version — sonde de disponibilité ───────────────────
router.head("/mobile/app-version", (_req, res) => res.status(200).end());

export default router;

// Ré-export du chemin par défaut pour les scripts CI qui écrivent version.json.
export { VERSION_JSON_PATH, DEFAULT_APK_URL };
