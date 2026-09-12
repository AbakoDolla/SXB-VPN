/**
 * support.ts — Point de contact immédiat de l'assistance.
 *
 * Cette constante est l'UNIQUE source de vérité de l'adresse Telegram côté
 * mobile : aucun écran ne doit recopier l'URL en dur. Changer d'adresse se fait
 * donc ici seulement (et dans la constante équivalente du tableau de bord).
 *
 * Le canal Telegram complète, sans jamais le remplacer, le système de tickets
 * internes : les tickets gardent la trace écrite des demandes, Telegram sert au
 * contact immédiat.
 */
export const SUPPORT_TELEGRAM_URL = 'https://t.me/+LkoFkoSDuxpiM2Q8';
