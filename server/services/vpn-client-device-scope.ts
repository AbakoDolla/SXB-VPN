import { etFiltres } from "./free-trial-marks";

export const CODE_APPAREIL_CLIENT_EXISTANT = "CLIENT_DEVICE_ALREADY_REGISTERED";
export const ERREUR_APPAREIL_CLIENT_EXISTANT = "errors.clients.device_already_registered";

/**
 * Identifiant d'appareil saisi depuis le tableau de bord, ramené à sa forme
 * canonique.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI LA CASSE EST RAMENÉE EN MAJUSCULES
 * ═══════════════════════════════════════════════════════════════════════════
 * L'application engendre elle-même l'identifiant, dans un alphabet qui ne
 * contient QUE des majuscules et des chiffres (`DEVICE_ID_ALPHABET`, préfixe
 * `SXB`). Un appareil réel ne peut donc jamais porter de minuscule, et deux
 * identifiants qui ne diffèrent que par la casse ne sont jamais deux appareils
 * distincts : c'est une seule et même machine, ressaisie autrement.
 *
 * Or l'appariement, lui, est EXACT partout où l'appareil se présente
 * (`app-register`, `mobile`, présence). Une fiche enregistrée « sxb66… » était
 * donc créée sans erreur — 201, tout semblait normal — puis n'était JAMAIS
 * rejointe par l'appareil qui annonce « SXB66… ». C'est très exactement la
 * panne rapportée : « I created a user and it didn't even work ». La casse
 * ouvrait au passage une seconde brèche, en laissant contourner l'unicité par
 * une simple variante de casse, ce qui faussait les compteurs et le plafond du
 * revendeur.
 *
 * INNOCUITÉ VÉRIFIÉE EN PRODUCTION : sur les 289 fiches existantes, aucune ne
 * porte de minuscule — seules des saisies manuelles pouvaient en produire.
 * Mettre en majuscules est donc sans effet sur le parc en place, y compris sur
 * les identifiants de longueur inhabituelle ou d'un autre format, qui sont
 * déjà en majuscules. Aucune valeur déjà stockée n'est réécrite.
 */
export function normaliserDeviceIdClient(deviceId: unknown): string | null {
  if (typeof deviceId !== "string") return null;
  const normalise = deviceId.trim().toUpperCase();
  return normalise ? normalise : null;
}

export function reponseConflitDeviceClient() {
  return {
    error: ERREUR_APPAREIL_CLIENT_EXISTANT,
    code: CODE_APPAREIL_CLIENT_EXISTANT,
    message: "Cet appareil est déjà enregistré dans ce tableau de bord.",
  };
}

export async function chercherConflitDeviceClient(
  db: any,
  portee: Record<string, unknown> | null | undefined,
  deviceId: unknown,
  extra: Record<string, unknown> = {},
) {
  const normalise = normaliserDeviceIdClient(deviceId);
  if (!normalise) return null;
  return db.vpnClient.findFirst({
    where: etFiltres(portee, { deviceId: normalise }, extra),
    select: { id: true },
  });
}

export function estContrainteUniqueDeviceClient(error: unknown): boolean {
  if (!error || typeof error !== "object" || (error as any).code !== "P2002") return false;
  const target = (error as any).meta?.target;
  const cibles = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return cibles.some((cible) => cible.includes("deviceId"));
}
