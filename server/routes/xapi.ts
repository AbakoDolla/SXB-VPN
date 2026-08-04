/**
 * xapi — Endpoints publics légers pour l'application mobile.
 *
 * Contient pour l'instant l'endpoint de mise à jour in-app :
 *   GET /xapi/mobile/app-version → { versionCode, versionName, apkUrl, notes? }
 *
 * Source de vérité : fichier statique `version.json` déposé à côté des APK
 * distribuables (par défaut /var/www/apk/version.json). Le workflow
 * `build-android.yml` écrit ce fichier à chaque build stable (voir CI).
 *
 * Le fichier est relu à chaque requête (fs.readFileSync) — pas de cache : le
 * fichier est minuscule (<200 o), et un déploiement doit être visible tout de
 * suite par les clients qui interrogent l'endpoint.
 *
 * En cas d'absence du fichier, on retombe sur la version connue par le serveur
 * (env `MOBILE_APP_VERSION_CODE` / `MOBILE_APP_VERSION_NAME`) pour ne jamais
 * renvoyer d'erreur — la mise à jour est alors simplement « pas de nouveauté ».
 */
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";

const router = Router();

// Emplacement du fichier version.json (surchargeable par variable d'env).
// Le workflow CI dépose ce fichier ici sur le VPS.
const VERSION_JSON_PATH =
  process.env.MOBILE_APP_VERSION_FILE ||
  "/var/www/apk/version.json";

// URL publique par défaut de l'APK distribué (surchargeable par variable d'env).
// Le workflow CI dépose sxbvpn-latest.apk sous /var/www/apk/ (servi par Nginx).
const DEFAULT_APK_URL =
  process.env.MOBILE_APP_APK_URL ||
  "https://vpnsxb.afrihall.com/apk/sxbvpn-latest.apk";

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
router.get("/mobile/app-version", (_req: Request, res: Response) => {
  const payload = readVersionFile() || fallbackVersion();
  res.set("Cache-Control", "public, max-age=300"); // 5 min côté CDN/proxy
  res.json(payload);
});

// ── HEAD /xapi/mobile/app-version — sonde de disponibilité ───────────────────
router.head("/mobile/app-version", (_req, res) => res.status(200).end());

export default router;

// Ré-export du chemin par défaut pour les scripts CI qui écrivent version.json.
export { VERSION_JSON_PATH, DEFAULT_APK_URL };
