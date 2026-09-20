import { etFiltres } from "./free-trial-marks";

export const CODE_APPAREIL_CLIENT_EXISTANT = "CLIENT_DEVICE_ALREADY_REGISTERED";
export const ERREUR_APPAREIL_CLIENT_EXISTANT = "errors.clients.device_already_registered";

export function normaliserDeviceIdClient(deviceId: unknown): string | null {
  if (typeof deviceId !== "string") return null;
  const normalise = deviceId.trim();
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
