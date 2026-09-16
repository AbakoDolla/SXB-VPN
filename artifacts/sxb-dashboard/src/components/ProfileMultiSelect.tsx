/**
 * ProfileMultiSelect — choisir PLUSIEURS configurations à attribuer.
 *
 * POURQUOI : attribuer trois forfaits à un appareil demandait trois passages
 * dans le même formulaire — choisir la configuration, le volume, l'échéance,
 * envoyer, recommencer. Le volume et l'échéance sont pourtant les mêmes ; seule
 * la configuration change. On coche donc les configurations voulues, et il est
 * créé un forfait par configuration cochée.
 *
 * Ce composant ne sait rien du reste : il reçoit des configurations, rend la
 * sélection, et laisse l'écran décider de ce qu'il en fait.
 */
import { useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import type { VpnProfile } from '../api/vpn-profiles';

interface Props {
  profiles: VpnProfile[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Borne du serveur : au-delà, l'opération est refusée. */
  max: number;
  disabled?: boolean;
}

/** Comparaison sans accents ni casse : « Orange » doit répondre à « orange ». */
function normalise(valeur: string): string {
  return valeur.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export default function ProfileMultiSelect({ profiles, selected, onChange, max, disabled }: Props) {
  const { t, formatNumber } = useTranslation();
  const [recherche, setRecherche] = useState('');

  const visibles = useMemo(() => {
    const terme = normalise(recherche.trim());
    if (!terme) return profiles;
    return profiles.filter(profile => normalise(profile.name || '').includes(terme));
  }, [profiles, recherche]);

  const retenus = useMemo(() => new Set(selected), [selected]);
  const plein = selected.length >= max;

  const basculer = (id: string) => {
    if (disabled) return;
    if (retenus.has(id)) onChange(selected.filter(item => item !== id));
    else if (!plein) onChange([...selected, id]);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-gray-400">
          {t('commerce.subscriptions.bulk.configurationsSelected', { count: formatNumber(selected.length) })}
        </p>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-lg border border-[#263149] px-2 py-1 text-[11px] text-gray-400 hover:bg-white/5 disabled:opacity-50"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            {t('commerce.subscriptions.bulk.configurationsClear')}
          </button>
        )}
      </div>

      {profiles.length > 8 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <input
            type="search"
            value={recherche}
            onChange={event => setRecherche(event.target.value)}
            placeholder={t('commerce.subscriptions.bulk.configurationsSearch')}
            aria-label={t('commerce.subscriptions.bulk.configurationsSearch')}
            disabled={disabled}
            className="w-full rounded-lg border border-[#263149] bg-[#070c15] py-1.5 pl-7 pr-2 text-xs text-white outline-none focus:border-cyan-500/60 disabled:opacity-50"
          />
        </div>
      )}

      <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[#263149] bg-[#070c15] p-1.5">
        {visibles.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-gray-500">
            {t('commerce.subscriptions.bulk.configurationsEmpty')}
          </p>
        ) : (
          visibles.map(profile => {
            const coche = retenus.has(profile.id);
            return (
              <button
                key={profile.id}
                type="button"
                role="checkbox"
                aria-checked={coche}
                onClick={() => basculer(profile.id)}
                // Une configuration non cochée devient inactive quand la borne
                // est atteinte : mieux vaut l'empêcher que refuser l'envoi.
                disabled={disabled || (!coche && plein)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  coche ? 'bg-cyan-500/15 text-cyan-200' : 'text-gray-200 hover:bg-white/5'
                } disabled:opacity-40`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    coche ? 'border-cyan-400 bg-cyan-500/30' : 'border-[#334155]'
                  }`}
                  aria-hidden="true"
                >
                  {coche && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate">{profile.name}</span>
              </button>
            );
          })
        )}
      </div>

      {plein && (
        <p className="text-[11px] text-amber-400/90">
          {t('commerce.subscriptions.bulk.configurationsMax', { count: formatNumber(max) })}
        </p>
      )}
    </div>
  );
}
