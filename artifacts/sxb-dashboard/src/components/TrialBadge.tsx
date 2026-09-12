import { Gift } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { countryFlag, countryName } from '../lib/countries';
import { isTrialMark, type TrialMark } from '../lib/trial';

/**
 * TrialBadge.tsx — LA définition du marqueur « essai gratuit », et la seule.
 *
 * Le propriétaire veut un logo qui différencie les essais PARTOUT dans la
 * plateforme : entrée de menu, en-tête de la section, lignes de demandes,
 * mention « Période d'essai », indicateurs. Une icône recopiée au cas par cas
 * dérive : `FreeTrialView` employait déjà `Gift` en cyan à son en-tête et en
 * fuchsia sur ses indicateurs, pour désigner la même chose. Tout passe
 * désormais par les trois exports ci-dessous.
 *
 * IDENTITÉ VISUELLE — `Gift` est conservé comme base, pour ne pas dérouter
 * l'exploitant qui le connaît déjà, mais il reçoit une forme qui n'appartient
 * qu'à l'essai :
 *   • une PASTILLE RONDE — tous les autres états de la plateforme (actif,
 *     suspendu, expiré, révoqué, en attente…) sont des pilules rectangulaires,
 *     donc rien d'autre n'est rond ;
 *   • le FUCHSIA, réservé : les cycles de vie occupent l'émeraude, l'ambre, le
 *     rose et l'ardoise ; l'interface d'essai occupait le cyan, désormais rendu
 *     aux actions.
 *
 * ACCESSIBILITÉ — le glyphe est décoratif (`aria-hidden`) et n'est JAMAIS seul
 * porteur de l'information : `TrialTag` affiche un libellé lisible à côté de
 * lui, et dans le menu c'est l'intitulé de l'entrée qui le porte.
 */

/** Teinte partagée du marqueur. Une seule déclaration, aucune recopie. */
export const TRIAL_MARKER_TONE = 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300';

/**
 * Le glyphe seul, en pastille ronde.
 *
 * À n'employer QUE là où un libellé voisin porte déjà le sens : l'entrée de
 * menu « Essai gratuit », l'en-tête de la section, le titre d'un panneau.
 */
export function TrialGlyph({
  className = 'h-5 w-5',
  iconClassName = 'h-[58%] w-[58%]',
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-fuchsia-400/45 bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/20 ${className}`}
    >
      <Gift className={iconClassName} />
    </span>
  );
}

/**
 * Le marqueur COMPLET : pastille + libellé lisible.
 *
 * C'est la forme à privilégier partout où un essai apparaît dans une liste, un
 * tableau ou un récapitulatif, parce qu'elle reste compréhensible sans couleur
 * comme sans image.
 */
export function TrialTag({
  label,
  className = '',
}: {
  /** Texte affiché ; toujours fourni par l'appelant via `t(...)`. */
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TRIAL_MARKER_TONE} ${className}`}
    >
      <TrialGlyph className="h-3.5 w-3.5" iconClassName="h-[62%] w-[62%]" />
      {label}
    </span>
  );
}

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
      <TrialTag label={t('commerce.trial.badge')} />
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
