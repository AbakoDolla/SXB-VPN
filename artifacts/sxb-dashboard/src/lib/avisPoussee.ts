import { toast } from 'sonner';
import type { ResultatPoussee } from '../api/announcements';
import { motifPoussee } from '../api/announcements';

/**
 * avisPoussee — dire, après une publication, si elle a vraiment atteint les téléphones.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EST PARTAGÉ
 * ═══════════════════════════════════════════════════════════════════════════
 * Deux écrans publient vers les appareils — les annonces et les mises à jour
 * de l'application — et le serveur rend compte de l'envoi pour les DEUX. Le
 * tableau de bord jetait ce compte rendu dans les deux cas : on publiait, rien
 * ne s'affichait, et on en concluait que le message était parti sur tous les
 * téléphones.
 *
 * Mesuré en production : zéro destinataire sur trente-huit appareils, faute
 * d'identifiants Firebase.
 *
 * Écrire deux fois le même avis les ferait diverger — l'un finirait corrigé
 * et l'autre pas, comme cela s'est déjà produit côté Android avec le canal de
 * notification. Les deux écrans passent donc par ici.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN MESSAGE FUGACE, ET NON UN BANDEAU
 * ═══════════════════════════════════════════════════════════════════════════
 * C'est le compte rendu d'une action qui vient de se terminer, pas un état
 * durable de la plateforme. Un bandeau serait resté à l'écran jusqu'à la
 * publication suivante, sans moyen de l'écarter : une information juste finit
 * par devenir un reproche si elle ne s'en va jamais.
 */
export function signalerPoussee(
  push: ResultatPoussee | null | undefined,
  t: (cle: string, params?: Record<string, string>) => string,
): void {
  // Un serveur antérieur à ce compte rendu n'en envoie pas : ne rien affirmer
  // plutôt que de supposer une réussite ou un échec.
  if (!push) return;

  if (push.status === 'sent') {
    toast.success(t('operations.announcements.pushDelivered', { count: String(push.sent ?? 0) }));
    return;
  }

  const motif = motifPoussee(push);
  toast.warning(t('operations.announcements.pushNotDelivered'), {
    description: motif === 'FCM_NOT_CONFIGURED'
      ? t('operations.announcements.pushNotConfigured')
      : t('operations.announcements.pushFailed', { reason: motif ?? push.status }),
    // Le cas « non configuré » demande une action de l'exploitant : lui
    // laisser le temps de lire avant que le message s'efface.
    duration: 12_000,
  });
}
