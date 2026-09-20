/**
 * GuideNouveautes — ce qui a changé, expliqué une fois, avec des exemples.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QU'IL RÉSOUT
 * ═══════════════════════════════════════════════════════════════════════════
 * Une livraison change des gestes du quotidien — convertir un essai, ne plus
 * faire réinstaller une application, reconnaître un client payant. Rien de
 * tout cela ne se devine devant un écran : l'exploitant découvre le changement
 * en se trompant, ou ne le découvre jamais et continue l'ancienne méthode.
 *
 * Ce guide s'ouvre UNE FOIS après chaque livraison, raconte ce qui a changé,
 * et donne pour chaque point un EXEMPLE concret — la situation réelle dans
 * laquelle le geste sert.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QU'IL NE FAIT PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * Il ne bloque pas le travail : la croix, la touche Échap et « Passer » le
 * ferment, et il ne revient pas. Un guide dont on ne peut pas sortir se fait
 * fermer sans être lu.
 *
 * Il ne se montre pas non plus à quelqu'un qui vient de l'écarter : c'est la
 * version retenue par le navigateur qui décide, pas la session.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Sparkles, X } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import {
  CLE_NOUVEAUTES_VUES,
  ETAPES_NOUVEAUTES,
  VERSION_NOUVEAUTES,
  doitAfficherNouveautes,
} from '../lib/nouveautes';

export default function GuideNouveautes() {
  const { t } = useTranslation();
  const [ouvert, setOuvert] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Un navigateur qui refuse le stockage (navigation privée stricte,
    // politique d'entreprise) ne doit pas empêcher le tableau de bord de
    // s'afficher : on renonce au guide, pas à l'application.
    try {
      if (doitAfficherNouveautes(window.localStorage.getItem(CLE_NOUVEAUTES_VUES))) setOuvert(true);
    } catch { /* stockage indisponible : pas de guide, et rien de cassé */ }
  }, []);

  const fermer = useCallback(() => {
    setOuvert(false);
    try {
      window.localStorage.setItem(CLE_NOUVEAUTES_VUES, VERSION_NOUVEAUTES);
    } catch { /* la fermeture reste effective pour cette session */ }
  }, []);

  useEffect(() => {
    if (!ouvert) return;
    const auClavier = (evenement: KeyboardEvent) => {
      if (evenement.key === 'Escape') fermer();
      if (evenement.key === 'ArrowRight') setIndex(n => Math.min(n + 1, ETAPES_NOUVEAUTES.length - 1));
      if (evenement.key === 'ArrowLeft') setIndex(n => Math.max(n - 1, 0));
    };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [ouvert, fermer]);

  if (!ouvert) return null;

  const etape = ETAPES_NOUVEAUTES[index];
  const derniere = index === ETAPES_NOUVEAUTES.length - 1;
  const cle = (champ: string) => `nouveautes.etapes.${etape.id}.${champ}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guide-nouveautes-titre"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-xl space-y-5 rounded-2xl border border-[#252b3b] bg-[#0f1218] p-6 shadow-2xl shadow-black/60">

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
              <Sparkles className="h-4 w-4" />
            </div>
            <h2 id="guide-nouveautes-titre" className="text-lg font-semibold text-white">
              {t('nouveautes.titre')}
            </h2>
          </div>
          <button
            type="button"
            onClick={fermer}
            aria-label={t('commerce.common.close')}
            className="text-gray-400 transition hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Progression : des segments plutôt que « 2 / 5 ». On voit d'un coup
            ce qui reste, sans avoir à faire la soustraction. */}
        <div className="flex gap-1.5" aria-hidden="true">
          {ETAPES_NOUVEAUTES.map((pas, rang) => (
            <span
              key={pas.id}
              className={`h-1 flex-1 rounded-full transition-colors ${
                rang <= index ? 'bg-cyan-400' : 'bg-[#252b3b]'
              }`}
            />
          ))}
        </div>

        {/* `key` sur l'étape : le contenu est remonté à chaque pas, donc
            l'animation d'entrée rejoue. Sans cela, le texte changerait sans
            que rien ne signale qu'on a avancé. */}
        <div key={etape.id} className="space-y-3 duration-300 animate-in fade-in slide-in-from-right-2">
          <h3 className="text-base font-semibold text-white">{t(cle('titre'))}</h3>
          <p className="text-sm leading-relaxed text-gray-300">{t(cle('texte'))}</p>

          {/* L'EXEMPLE, dans son propre cadre. C'est ce que le propriétaire a
              demandé, et c'est la partie qu'on relit : la situation réelle où
              le geste sert. Le liseré cyan la sépare de l'explication sans
              ajouter une seconde carte. */}
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">
              {t('nouveautes.exemple')}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-gray-200">{t(cle('exemple'))}</p>
          </div>

          {etape.lien && (
            <a
              href={etape.lien}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2.5 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20"
            >
              <ExternalLink className="h-4 w-4" />
              {t(cle('lien'))}
            </a>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#1a1f2e] pt-4">
          <button
            type="button"
            onClick={fermer}
            className="text-sm text-gray-400 transition hover:text-white"
          >
            {t('nouveautes.passer')}
          </button>

          <div className="flex items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex(n => Math.max(n - 1, 0))}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#252b3b] px-3.5 py-2 text-sm text-gray-200 transition hover:bg-white/5"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('nouveautes.precedent')}
              </button>
            )}
            <button
              type="button"
              onClick={() => (derniere ? fermer() : setIndex(n => n + 1))}
              className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
            >
              {derniere ? <Check className="h-4 w-4" /> : null}
              {t(derniere ? 'nouveautes.terminer' : 'nouveautes.suivant')}
              {derniere ? null : <ArrowRight className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
