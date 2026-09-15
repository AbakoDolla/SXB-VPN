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

/**
 * Conversion d'un lien pour les intégrations qui demandent un schéma natif.
 * Le bouton d'assistance utilise le navigateur et ne dépend pas de ce schéma.
 *   https://t.me/+HASH           invitation privée   → tg://join?invite=HASH
 *   https://t.me/joinchat/HASH   ancienne invitation → tg://join?invite=HASH
 *   https://t.me/nom             canal public        → tg://resolve?domain=nom
 */
export function telegramAppUrl(lien: string = SUPPORT_TELEGRAM_URL): string | null {
  const m = /^https?:\/\/(?:www\.)?t\.me\/(.+)$/i.exec(lien.trim());
  if (!m) return null;
  // Le fragment et la chaîne de requête ne se transposent pas : on les écarte.
  const chemin = m[1].split(/[?#]/)[0];
  if (!chemin) return null;

  if (chemin.startsWith('+')) {
    const invite = chemin.slice(1);
    return invite ? `tg://join?invite=${encodeURIComponent(invite)}` : null;
  }
  if (/^joinchat\//i.test(chemin)) {
    const invite = chemin.replace(/^joinchat\//i, '');
    return invite ? `tg://join?invite=${encodeURIComponent(invite)}` : null;
  }
  // Un nom d'utilisateur Telegram : lettres, chiffres et tirets bas.
  if (/^[A-Za-z0-9_]{3,}$/.test(chemin)) {
    return `tg://resolve?domain=${encodeURIComponent(chemin)}`;
  }
  return null;
}
