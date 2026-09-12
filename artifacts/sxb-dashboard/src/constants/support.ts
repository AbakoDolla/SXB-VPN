/**
 * support.ts — Point de contact immédiat de l'assistance.
 *
 * Constante UNIQUE de l'adresse Telegram côté tableau de bord : aucun écran ne
 * doit recopier l'URL en dur. Avec son équivalent mobile
 * (app-mobile/constants/support.ts), un changement d'adresse se fait en deux
 * endroits au total.
 *
 * Ce canal complète le système de tickets internes (SupportView) sans le
 * remplacer : les tickets conservent la trace écrite et suivie des demandes.
 */
export const SUPPORT_TELEGRAM_URL = "https://t.me/+LkoFkoSDuxpiM2Q8";
