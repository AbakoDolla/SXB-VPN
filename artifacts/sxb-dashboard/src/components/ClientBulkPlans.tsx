/**
 * ClientBulkPlans — attribuer et modifier des forfaits DEPUIS la liste des clients.
 *
 * POURQUOI CE PANNEAU EXISTE
 * ──────────────────────────
 * « Forfaits Data » liste les forfaits à plat : ceux d'un même client y sont
 * dispersés entre ceux de tous les autres, et répondre à « qu'est-ce que cette
 * personne a reçu ? » demande de filtrer, de lire, de recouper. L'exploitant
 * raisonne pourtant par PERSONNE — il attribue à quelqu'un, il prolonge
 * quelqu'un — et c'est la liste des clients qui porte cette lecture.
 *
 * Ce panneau ferme la boucle : on coche des personnes, et on agit sur leurs
 * forfaits sans quitter l'écran.
 *
 * CE QU'IL N'EST PAS
 * ──────────────────
 * Un second système. Il envoie exactement la même requête que « Forfaits
 * Data » (`/subscriptions/bulk`), avec les mêmes bornes et les mêmes refus.
 * Deux chemins d'écriture divergents finiraient par appliquer deux règles
 * différentes au même geste.
 *
 * LES DEUX ACTIONS, ET POURQUOI ELLES NE SE MÉLANGENT PAS
 * ──────────────────────────────────────────────────────
 *  • ATTRIBUER crée un forfait de plus par personne cochée. Elle exige
 *    serveur, volume et échéance : sans eux il n'y a rien à créer.
 *  • MODIFIER touche les forfaits qui EXISTENT déjà. Elle n'exige rien
 *    d'autre qu'un champ renseigné, et laisse intact tout ce qui est laissé
 *    vide.
 *
 * Une personne sans aucun forfait ne peut pas être « modifiée » : le panneau
 * le dit AVANT d'envoyer, plutôt que de renvoyer un lot à moitié ignoré.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, PlusCircle, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import {
  bulkSubscriptions, MAX_BULK_APPLY,
  type BulkPayload, type BulkResult, type BulkValueMode, type Subscription,
} from '../api/subscriptions';
import type { VpnProfile } from '../api/vpn-profiles';

/** Ce que l'exploitant veut faire des personnes cochées. */
type Mode = 'deploy' | 'apply';
/** Comment l'échéance est exprimée. */
type ModeEcheance = 'duration' | 'date';

const QUOTA_MIN = 0.01;
const QUOTA_MAX = 1_000_000;
const JOURS_MIN = 1;
const JOURS_MAX = 3650;

interface Props {
  /** Identifiants des clients cochés dans la liste. */
  clientIds: string[];
  /** Forfaits déjà chargés pour la page, tous clients confondus. */
  subscriptions: Subscription[];
  /** Configurations VPN attribuables. */
  profiles: VpnProfile[];
  busy: boolean;
  onDone: () => void | Promise<void>;
}

function nombreOuUndefined(valeur: string): number | undefined {
  const net = valeur.trim();
  if (net === '') return undefined;
  const n = Number(net);
  return Number.isFinite(n) ? n : NaN;
}

/** Une date de formulaire → ISO. `null` signale une saisie illisible. */
function instantOuNull(valeur: string): string | undefined | null {
  if (!valeur.trim()) return undefined;
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function ClientBulkPlans({ clientIds, subscriptions, profiles, busy, onDone }: Props) {
  const { t, formatNumber } = useTranslation();
  const [mode, setMode] = useState<Mode>('deploy');
  const [profileId, setProfileId] = useState('');
  const [quota, setQuota] = useState('');
  const [quotaMode, setQuotaMode] = useState<BulkValueMode>('set');
  const [modeEcheance, setModeEcheance] = useState<ModeEcheance>('duration');
  const [jours, setJours] = useState('');
  const [dureeMode, setDureeMode] = useState<BulkValueMode>('set');
  const [expireAt, setExpireAt] = useState('');
  const [startAt, setStartAt] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [resultat, setResultat] = useState<BulkResult | null>(null);

  /**
   * Forfaits des personnes cochées.
   *
   * `apply` ne sait viser que des forfaits : viser une personne qui n'en a
   * aucun ne produirait rien. On les compte ici pour pouvoir le DIRE avant
   * l'envoi, au lieu de laisser le serveur ignorer la moitié du lot.
   */
  const cibles = useMemo(() => {
    const retenus = new Set(clientIds);
    const forfaits = subscriptions.filter(s => retenus.has(s.clientId));
    const avecForfait = new Set(forfaits.map(s => s.clientId));
    return {
      subscriptionIds: forfaits.map(s => s.id),
      sansForfait: clientIds.filter(id => !avecForfait.has(id)).length,
    };
  }, [clientIds, subscriptions]);

  const plan = useMemo<{ payload: BulkPayload | null; refus: string | null }>(() => {
    const refuse = (cle: string) => ({ payload: null, refus: cle });
    if (clientIds.length === 0) return refuse('commerce.clientPlans.noSelection');

    const quotaGB = nombreOuUndefined(quota);
    if (quotaGB !== undefined && (Number.isNaN(quotaGB) || quotaGB < QUOTA_MIN || quotaGB > QUOTA_MAX)) {
      return refuse('commerce.subscriptions.bulk.invalidQuota');
    }
    const durationDays = modeEcheance === 'duration' ? nombreOuUndefined(jours) : undefined;
    if (durationDays !== undefined && (!Number.isInteger(durationDays) || durationDays < JOURS_MIN || durationDays > JOURS_MAX)) {
      return refuse('commerce.subscriptions.bulk.invalidDuration');
    }
    const debut = instantOuNull(startAt);
    const echeance = modeEcheance === 'date' ? instantOuNull(expireAt) : undefined;
    if (debut === null || echeance === null) return refuse('commerce.subscriptions.bulk.invalidDate');
    if (debut && echeance && new Date(echeance).getTime() <= new Date(debut).getTime()) {
      return refuse('commerce.subscriptions.bulk.expiryBeforeStart');
    }

    if (mode === 'deploy') {
      // Créer exige les trois : sans eux, il n'y a rien à créer.
      if (!profileId) return refuse('commerce.subscriptions.bulk.profileRequired');
      if (quotaGB === undefined) return refuse('commerce.subscriptions.bulk.quotaRequired');
      if (durationDays === undefined && !echeance) return refuse('commerce.subscriptions.bulk.durationRequired');
      if (clientIds.length > MAX_BULK_APPLY) return refuse('commerce.subscriptions.bulk.tooMany');
      return {
        payload: {
          action: 'deploy',
          clientIds,
          profileId,
          quotaGB,
          ...(durationDays !== undefined ? { durationDays } : {}),
          ...(debut ? { startAt: debut } : {}),
          ...(echeance ? { expireAt: echeance } : {}),
        },
        refus: null,
      };
    }

    // MODIFIER : au moins un champ, et au moins un forfait à toucher.
    if (!profileId && quotaGB === undefined && !debut && !echeance && durationDays === undefined) {
      return refuse('commerce.subscriptions.bulk.nothingToApply');
    }
    if (cibles.subscriptionIds.length === 0) return refuse('commerce.clientPlans.noPlans');
    if (cibles.subscriptionIds.length > MAX_BULK_APPLY) return refuse('commerce.subscriptions.bulk.tooMany');
    return {
      payload: {
        action: 'apply',
        subscriptionIds: cibles.subscriptionIds,
        ...(profileId ? { profileId } : {}),
        ...(quotaGB !== undefined ? { quotaGB, quotaMode } : {}),
        ...(debut ? { startAt: debut } : {}),
        ...(echeance ? { expireAt: echeance } : {}),
        ...(durationDays !== undefined ? { durationDays, durationMode: dureeMode } : {}),
      },
      refus: null,
    };
  }, [mode, clientIds, profileId, quota, quotaMode, modeEcheance, jours, dureeMode, expireAt, startAt, cibles]);

  const appliquer = async () => {
    if (!plan.payload || envoi) return;
    setEnvoi(true);
    setResultat(null);
    try {
      setResultat(await bulkSubscriptions(plan.payload));
      await onDone();
    } catch (err: any) {
      setResultat({
        action: plan.payload.action, selected: 0, succeeded: 0, skipped: 0, failed: 0,
        details: [{ id: '-', status: 'failed', reason: err?.message || 'errors.server' }],
      });
    } finally {
      setEnvoi(false);
    }
  };

  const champ = 'mt-1 w-full rounded-lg border border-[#263149] bg-[#070c15] px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60';

  return (
    <section className="rounded-2xl border border-cyan-500/25 bg-cyan-500/[0.04] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{t('commerce.clientPlans.title')}</h3>
          <p className="mt-0.5 text-[11px] text-gray-400">
            {t('commerce.clientPlans.selected', {
              clients: formatNumber(clientIds.length),
              plans: formatNumber(cibles.subscriptionIds.length),
            })}
          </p>
        </div>
        <div className="flex gap-1.5">
          {(['deploy', 'apply'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setResultat(null); }}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                mode === m
                  ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                  : 'border-[#263149] text-gray-400 hover:bg-white/5'
              }`}
            >
              {m === 'deploy' ? <PlusCircle className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
              {t(m === 'deploy' ? 'commerce.clientPlans.modeDeploy' : 'commerce.clientPlans.modeApply')}
            </button>
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-gray-500">
        {t(mode === 'deploy' ? 'commerce.clientPlans.deployHint' : 'commerce.clientPlans.applyHint')}
      </p>

      {/* Une personne sans forfait ne peut pas être MODIFIÉE. Le dire avant
          l'envoi vaut mieux qu'un lot à moitié ignoré sans explication. */}
      {mode === 'apply' && cibles.sansForfait > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('commerce.clientPlans.withoutPlans', { count: formatNumber(cibles.sansForfait) })}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-xs text-gray-300">
          {t('commerce.subscriptions.bulk.configurationLabel')}
          <select value={profileId} onChange={e => setProfileId(e.target.value)} className={champ}>
            <option value="">{t(mode === 'deploy' ? 'commerce.clientPlans.choose' : 'commerce.clientPlans.unchanged')}</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <label className="block text-xs text-gray-300">
          {t('commerce.subscriptions.bulk.dataGb')}
          <input type="number" min={QUOTA_MIN} step="0.01" value={quota} onChange={e => setQuota(e.target.value)}
            placeholder={t(mode === 'deploy' ? 'commerce.clientPlans.required' : 'commerce.clientPlans.unchanged')}
            className={champ} />
          {mode === 'apply' && (
            <select value={quotaMode} onChange={e => setQuotaMode(e.target.value as BulkValueMode)} className={`${champ} mt-1.5`}>
              <option value="set">{t('commerce.subscriptions.bulk.modeSet')}</option>
              <option value="add">{t('commerce.subscriptions.bulk.modeAdd')}</option>
            </select>
          )}
        </label>

        <label className="block text-xs text-gray-300">
          {t('commerce.clientPlans.startAt')}
          <input type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)} className={champ} />
        </label>

        <label className="block text-xs text-gray-300">
          {t('commerce.clientPlans.expiryMode')}
          <select value={modeEcheance} onChange={e => setModeEcheance(e.target.value as ModeEcheance)} className={champ}>
            <option value="duration">{t('commerce.clientPlans.expiryDuration')}</option>
            <option value="date">{t('commerce.clientPlans.expiryDate')}</option>
          </select>
        </label>

        {modeEcheance === 'duration' ? (
          <label className="block text-xs text-gray-300">
            {t('commerce.subscriptions.bulk.durationLabel')}
            <input type="number" min={JOURS_MIN} max={JOURS_MAX} value={jours} onChange={e => setJours(e.target.value)}
              placeholder={t(mode === 'deploy' ? 'commerce.clientPlans.required' : 'commerce.clientPlans.unchanged')}
              className={champ} />
            {mode === 'apply' && (
              <select value={dureeMode} onChange={e => setDureeMode(e.target.value as BulkValueMode)} className={`${champ} mt-1.5`}>
                <option value="set">{t('commerce.subscriptions.bulk.modeSet')}</option>
                <option value="add">{t('commerce.subscriptions.bulk.modeAdd')}</option>
              </select>
            )}
          </label>
        ) : (
          <label className="block text-xs text-gray-300">
            {t('commerce.clientPlans.expireAt')}
            <input type="datetime-local" value={expireAt} onChange={e => setExpireAt(e.target.value)} className={champ} />
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-gray-500">
          {plan.refus ? t(plan.refus) : t('commerce.clientPlans.ready')}
        </p>
        <button
          type="button"
          onClick={() => void appliquer()}
          disabled={!plan.payload || envoi || busy}
          className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-[#06101a] transition hover:bg-cyan-300 disabled:opacity-50"
        >
          {envoi && <Loader2 className="h-4 w-4 animate-spin" />}
          {t(mode === 'deploy' ? 'commerce.clientPlans.applyDeploy' : 'commerce.clientPlans.applyEdit')}
        </button>
      </div>

      {resultat && (
        <p className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-gray-300">
          {t('commerce.clientPlans.result', {
            succeeded: formatNumber(resultat.succeeded),
            selected: formatNumber(resultat.selected),
            skipped: formatNumber(resultat.skipped),
            failed: formatNumber(resultat.failed),
          })}
        </p>
      )}
    </section>
  );
}
