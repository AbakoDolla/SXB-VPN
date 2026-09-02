/**
 * xapi — Endpoints publics légers pour l'application mobile.
 *
 * Contient l'endpoint de mise à jour in-app et le statut de connexion :
 *   GET /xapi/mobile/app-version → { versionCode, versionName, apkUrl, notes? }
 *   GET /xapi/mobile/ip → { ip }
 *   POST /xapi/mobile/connections/:id/status → { disabledReason: 'exhausted' | 'expired' }
 */
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { prisma, inMemoryDb } from "../database";
import { getMobileAppUpdate, readPublishedAppUpdate, toMobileAppVersion } from "../services/app-update";

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

// A4 — POST /xapi/mobile/connections/:id/status — marque un abonnement/connexion comme 'exhausted' ou 'expired'
router.post("/mobile/connections/:id/status", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const disabledReason = req.body?.disabledReason;
    if (disabledReason !== 'exhausted' && disabledReason !== 'expired') {
      return res.status(400).json({ error: "invalid_reason", message: "disabledReason doit être 'exhausted' ou 'expired'" });
    }

    if (prisma) {
      await (prisma as any).subscription.update({
        where: { id },
        data: { status: disabledReason },
      }).catch(() => null);
    } else {
      const sub = inMemoryDb.subscriptions?.find((s: any) => s.id === id);
      if (sub) sub.status = disabledReason;
    }

    return res.json({ success: true, id, status: disabledReason });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;

// Ré-export du chemin par défaut pour les scripts CI qui écrivent version.json.
export { VERSION_JSON_PATH, DEFAULT_APK_URL };
