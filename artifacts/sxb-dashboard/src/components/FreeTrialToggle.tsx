import { Gift } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';

/**
 * FreeTrialToggle — « Inclure les essais gratuits » sur les écrans d'exploitation.
 *
 * RÈGLE DU PROPRIÉTAIRE : les utilisateurs d'essai ne se mélangent pas aux
 * clients principaux. « Forfaits Data », « Comptes VPN » et « Appareils »
 * s'ouvrent donc TOUJOURS essais masqués — l'interrupteur n'est pas mémorisé,
 * précisément pour que l'état par défaut ne dérive jamais.
 *
 * Il existe malgré tout parce qu'un essai qui pose problème doit rester
 * traitable là où l'on traite les incidents : suspendre, révoquer, prolonger.
 * Le rendre invisible pour toujours aurait remplacé un défaut par un autre.
 *
 * L'interrupteur ne masque RIEN côté navigateur : il repart chercher la liste
 * auprès du serveur. C'est ce qui garantit que les compteurs affichés au-dessus
 * du tableau comptent exactement les lignes qu'il contient.
 *
 * C'est un `role="switch"` et non une case à cocher : les cases d'un écran
 * d'exploitation désignent des LIGNES sélectionnées pour une action groupée.
 * En être une ferait entrer ce réglage dans les sélections, à l'écran comme
 * dans les parcours qui les énumèrent.
 */
export function FreeTrialToggle({ checked, onChange, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`inline-flex w-fit items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          checked
            ? 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200'
            : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
        }`}
      >
        <Gift className="h-4 w-4 shrink-0 text-fuchsia-400" />
        <span>{t('commerce.trial.include')}</span>
      </button>
      <p className="text-xs text-gray-500">
        {checked ? t('commerce.trial.included') : t('commerce.trial.includeHint')}
      </p>
    </div>
  );
}
