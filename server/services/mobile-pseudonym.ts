import { createHmac } from "crypto";

/**
 * Pseudonyme d'un appareil pour la table de santé mobile.
 *
 * Ce calcul vit à part parce qu'il est PUR : il ne lit ni base, ni requête, ni
 * configuration. Le laisser dans le service de santé obligeait tout appelant —
 * y compris le suivi de présence, qui n'a besoin que de cette ligne — à
 * embarquer la validation d'entrée, le client de base de données et le service
 * de mise à jour qui l'accompagnent.
 *
 * Le résultat est DÉTERMINISTE : le serveur peut recalculer le pseudonyme d'un
 * appareil qu'il connaît déjà, ce qui permet de rapprocher une mesure de santé
 * d'un client sans jamais écrire d'identité dans la table de santé.
 */
export function pseudonymizeMobileDevice(userId: string, deviceId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${userId}\0${deviceId}`)
    .digest("base64url")
    .slice(0, 22);
}
