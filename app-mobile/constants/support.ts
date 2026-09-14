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
 * Traduit un lien `t.me` en adresse NATIVE Telegram (`tg://`).
 *
 * POURQUOI CETTE TRADUCTION EXISTE
 * ────────────────────────────────
 * Ouvrir `https://t.me/...` ne mène pas à Telegram. Android ne confie un lien
 * https à une application que si celle-ci a fait vérifier le domaine ET que
 * l'utilisateur n'a pas renvoyé « les liens pris en charge » vers son
 * navigateur. En pratique le lien s'ouvre donc au navigateur, qui affiche une
 * page intermédiaire — et le bouton « Support » ne rejoint jamais Telegram.
 *
 * Pire, cet échec est SILENCIEUX : `openURL` sur une URL https réussit
 * toujours, puisque le navigateur la prend. L'alerte « Telegram introuvable »
 * ne pouvait donc jamais s'afficher, et rien ne signalait le problème.
 *
 * L'adresse `tg://`, elle, n'est réclamée que par Telegram. Si l'application
 * est là, elle s'ouvre directement ; sinon `openURL` échoue franchement, ce qui
 * permet de retomber sur le lien https en connaissance de cause.
 *
 * FORMES PRISES EN CHARGE — ce sont celles que Telegram distribue :
 *   https://t.me/+HASH           invitation privée   → tg://join?invite=HASH
 *   https://t.me/joinchat/HASH   ancienne invitation → tg://join?invite=HASH
 *   https://t.me/nom             canal public        → tg://resolve?domain=nom
 *
 * Rend `null` pour tout le reste : mieux vaut ouvrir le lien d'origine que
 * fabriquer une adresse native approximative qui échouerait sans rien dire.
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
