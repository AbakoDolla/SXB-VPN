import { Gift } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { countryFlag, countryName } from '../lib/countries';
import { isTrialMark, type TrialMark } from '../lib/trial';

/**
 * TrialBadge — « Période d'essai » sur un client ou un appareil.
 *
 * Le propriétaire veut reconnaître d'un coup d'œil un accès issu d'un essai
 * gratuit, avec sa date de fin et le pays d'où vient la personne. Le même
 * composant sert la vue des appareils et celle des clients, pour que la mention
 * soit identique partout — y compris chez un revendeur, qui la voit sur ses
 * propres clients.
 *
 * Rend `null` pour un accès ordinaire : aucun badge parasite sur le parc
 * commercial habituel.
 */
export function TrialBadge({ trial }: { trial: unknown }) {
  const { t, language, formatDate } = useTranslation();
  if (!isTrialMark(trial)) return null;
  const mark = trial as TrialMark;
  const country = countryName(mark.country, language);

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <span className="inline-flex w-fit items-center gap-1 rounded-md border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-0.5 text-[11px] font-semibold text-fuchsia-300">
        <Gift className="h-3 w-3 shrink-0" />
        {t('commerce.trial.badge')}
      </span>
      {mark.trialEndsAt && (
        <span className="text-[11px] text-gray-500">
          {t('commerce.trial.endsOn', { date: formatDate(mark.trialEndsAt) })}
        </span>
      )}
      {country && (
        <span className="text-[11px] text-gray-500">
          {t('commerce.trial.fromCountry', { country: `${countryFlag(mark.country)} ${country}` })}
        </span>
      )}
    </div>
  );
}
