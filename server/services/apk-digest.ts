/**
 * apk-digest — normalisation d'un condensat SHA-256 d'APK.
 *
 * Cette règle est partagée par la publication d'une mise à jour et par la
 * lecture du manifeste de build. Elle vit dans son propre fichier, sans aucune
 * dépendance, parce que le lecteur de manifeste n'est qu'une lecture de
 * fichier : lui faire importer le module de publication entraînait avec lui la
 * couche base de données et tout ce qu'elle-même importe. Une lecture de
 * fichier échouait alors si la base n'était pas joignable, et le module
 * devenait impossible à éprouver isolément.
 */

/**
 * Rend un condensat en minuscules, ou la chaîne vide s'il n'en est pas un.
 *
 * Tolère les formes que l'on copie couramment depuis un journal ou un
 * terminal : préfixe `sha256:`, séparateurs `:` et espaces. Une valeur qui
 * n'est pas exactement 64 caractères hexadécimaux est rejetée plutôt que
 * transmise : un condensat approximatif ferait refuser l'installation par tous
 * les appareils, après qu'ils ont téléchargé l'archive entière.
 */
export function normalizeApkSha256(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/^sha256:/i, "").replace(/[:\s]/g, "");
  return /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : "";
}
