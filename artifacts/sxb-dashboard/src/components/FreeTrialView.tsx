import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  Gift,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { usePermissions } from '../contexts/PermissionsContext';
import {
  createFreeTrialToken,
  deployFreeTrialRequests,
  fetchFreeTrialRequests,
  fetchFreeTrialTokens,
  rejectFreeTrialRequests,
  revokeFreeTrialToken,
  FREE_TRIAL_STATUS,
  type FreeTrialRequest,
  type FreeTrialToken,
} from '../api/free-trial';
import { fetchVpnProfiles, type VpnProfile } from '../api/vpn-profiles';

/// FreeTrialView — Étapes 1 et 3 de l'essai gratuit, côté administration.
///
/// Cette vue tient deux rôles bien séparés, et la séparation est le cœur de la
/// fonctionnalité :
///   1. fabriquer un JETON d'invitation, qui ne contient rien (ni serveur, ni
///      Go, ni dates, ni configuration) ;
///   2. lire les DEMANDES déposées par les appareils, en sélectionner une ou
///      plusieurs, et seulement ALORS décider de ce que chacun reçoit.
///
/// Aucun champ d'accès n'est saisissable à l'étape 1 : c'est volontaire, et le
/// backend refuse d'ailleurs tout champ inconnu à la création du jeton.

/** Correspondance statut → clé i18n. Les valeurs sont des clés, pas du texte. */
const STATUS_LABELS: Record<string, string> = {
  pending: 'operations.freeTrial.status.pending',
  deployed: 'operations.freeTrial.status.deployed',
  rejected: 'operations.freeTrial.status.rejected',
};

/** Correspondance état du jeton → clé i18n. */
const TOKEN_STATE_LABELS: Record<string, string> = {
  active: 'operations.freeTrial.tokenState.active',
  revoked: 'operations.freeTrial.tokenState.revoked',
  expired: 'operations.freeTrial.tokenState.expired',
  exhausted: 'operations.freeTrial.tokenState.exhausted',
};

/** Issue d'un déploiement unitaire → clé i18n. */
const RESULT_LABELS: Record<string, string> = {
  deployed: 'operations.freeTrial.result.deployed',
  skipped: 'operations.freeTrial.result.skipped',
  failed: 'operations.freeTrial.result.failed',
};

function statusClasses(status: string): string {
  if (status === FREE_TRIAL_STATUS.DEPLOYED) return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  if (status === FREE_TRIAL_STATUS.REJECTED) return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
  return 'border-amber-500/25 bg-amber-500/10 text-amber-300';
}

function tokenStateClasses(state: string): string {
  if (state === 'active') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  return 'border-slate-500/25 bg-slate-500/10 text-slate-400';
}

/** Date locale → chaîne `datetime-local`, pour préremplir les champs. */
function toLocalInput(date: Date): string {
  const decale = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return decale.toISOString().slice(0, 16);
}

export default function FreeTrialView() {
  const { t, formatDate, formatNumber, errorMessage } = useTranslation();
  const can = usePermissions();

  const [tokens, setTokens] = useState<FreeTrialToken[]>([]);
  const [requests, setRequests] = useState<FreeTrialRequest[]>([]);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>(FREE_TRIAL_STATUS.PENDING);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  // ── Étape 1 : formulaire de création du jeton ──────────────────────────────
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenMaxUses, setTokenMaxUses] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState('');

  // ── Étape 3 : formulaire de déploiement, ouvert APRÈS sélection ────────────
  const [showDeployForm, setShowDeployForm] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [quotaGB, setQuotaGB] = useState('2');
  const [startAt, setStartAt] = useState('');
  const [expireAt, setExpireAt] = useState('');
  const [deviceLimit, setDeviceLimit] = useState('1');
  const [deployNote, setDeployNote] = useState('');

  const canDeploy = can('subscription.manage');
  const canCreateToken = can('tokens.create');
  const canRevokeToken = can('tokens.revoke');

  const charger = useCallback(async () => {
    setError(null);
    try {
      const [listeDemandes, listeJetons] = await Promise.all([
        fetchFreeTrialRequests(statusFilter || undefined),
        can('tokens.view') ? fetchFreeTrialTokens() : Promise.resolve([] as FreeTrialToken[]),
      ]);
      setRequests(listeDemandes);
      setTokens(listeJetons);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, can, t]);

  useEffect(() => {
    void charger();
  }, [charger]);

  useEffect(() => {
    // Les serveurs proposés au déploiement sont les configurations VPN
    // existantes : on ne crée surtout pas un second référentiel de serveurs.
    if (!canDeploy) return;
    fetchVpnProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [canDeploy]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const visibles = useMemo(() => {
    const terme = search.trim().toLowerCase();
    if (!terme) return requests;
    return requests.filter(demande =>
      demande.name.toLowerCase().includes(terme) ||
      demande.deviceId.toLowerCase().includes(terme) ||
      (demande.trialToken ?? '').toLowerCase().includes(terme));
  }, [requests, search]);

  // Seules les demandes EN ATTENTE sont déployables : une demande déjà servie
  // ne doit pas pouvoir être re-servie par une case cochée par mégarde.
  const selectionnables = useMemo(
    () => visibles.filter(demande => demande.status === FREE_TRIAL_STATUS.PENDING),
    [visibles],
  );
  const selectionValide = useMemo(
    () => selection.filter(id => selectionnables.some(demande => demande.id === id)),
    [selection, selectionnables],
  );
  const toutSelectionne = selectionnables.length > 0 && selectionValide.length === selectionnables.length;

  const basculer = (id: string) =>
    setSelection(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));

  const basculerTout = () =>
    setSelection(toutSelectionne ? [] : selectionnables.map(demande => demande.id));

  const copier = async (valeur: string) => {
    try {
      await navigator.clipboard.writeText(valeur);
      setCopied(valeur);
    } catch {
      setCopied(null);
    }
  };

  const ouvrirDeploiement = () => {
    const maintenant = new Date();
    const dansTrenteJours = new Date(maintenant.getTime() + 30 * 24 * 3600 * 1000);
    if (!startAt) setStartAt(toLocalInput(maintenant));
    if (!expireAt) setExpireAt(toLocalInput(dansTrenteJours));
    setShowDeployForm(true);
  };

  const creerJeton = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cree = await createFreeTrialToken({
        label: tokenLabel.trim() || undefined,
        maxUses: tokenMaxUses.trim() ? Number(tokenMaxUses) : null,
        expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : undefined,
      });
      setTokens(prev => [cree, ...prev]);
      setNotice(t('operations.freeTrial.notice.tokenCreated', { token: cree.token }));
      setTokenLabel('');
      setTokenMaxUses('');
      setTokenExpiresAt('');
      setShowTokenForm(false);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const revoquerJeton = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const misAJour = await revokeFreeTrialToken(id);
      setTokens(prev => prev.map(jeton => (jeton.id === id ? { ...jeton, ...misAJour } : jeton)));
      setNotice(t('operations.freeTrial.notice.tokenRevoked'));
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const deployer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selectionValide.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const reponse = await deployFreeTrialRequests({
        requestIds: selectionValide,
        profileId,
        quotaGB: Number(quotaGB),
        startAt: startAt ? new Date(startAt).toISOString() : undefined,
        expireAt: new Date(expireAt).toISOString(),
        deviceLimit: deviceLimit.trim() ? Number(deviceLimit) : undefined,
        note: deployNote.trim() || undefined,
      });
      const echecs = reponse.results.filter(item => item.status !== 'deployed');
      setNotice(t('operations.freeTrial.notice.deployed', {
        deployed: formatNumber(reponse.deployed),
        total: formatNumber(reponse.total),
      }));
      if (echecs.length > 0) {
        setError(t('operations.freeTrial.notice.partial', {
          items: echecs.map(item => `${item.id} (${t(RESULT_LABELS[item.status] ?? 'operations.freeTrial.result.failed')})`).join(', '),
        }));
      }
      setSelection([]);
      setShowDeployForm(false);
      await charger();
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const refuser = async () => {
    if (selectionValide.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const reponse = await rejectFreeTrialRequests({ requestIds: selectionValide });
      setNotice(t('operations.freeTrial.notice.rejected', { count: formatNumber(reponse.rejected) }));
      setSelection([]);
      await charger();
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="ml-3 text-sm">{t('operations.freeTrial.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-100">
            <Gift className="h-6 w-6 text-cyan-400" />
            {t('operations.freeTrial.title')}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">{t('operations.freeTrial.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void charger()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-300 transition hover:bg-white/10"
          >
            <RefreshCw className="h-4 w-4" />
            {t('operations.freeTrial.refresh')}
          </button>
          {canCreateToken && (
            <button
              type="button"
              onClick={() => setShowTokenForm(value => !value)}
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-500/90 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
            >
              <Plus className="h-4 w-4" />
              {t('operations.freeTrial.createToken')}
            </button>
          )}
        </div>
      </header>

      <div className="flex items-start gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-sm text-cyan-200/90">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-400" />
        <p>{t('operations.freeTrial.securityNotice')}</p>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={t('operations.freeTrial.dismiss')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t('operations.freeTrial.dismiss')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Étape 1 : création du jeton ─────────────────────────────────────── */}
      {showTokenForm && canCreateToken && (
        <form onSubmit={creerJeton} className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.tokenForm.title')}</h2>
            <p className="mt-1 text-xs text-gray-500">{t('operations.freeTrial.tokenForm.hint')}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-xs text-gray-400">
              {t('operations.freeTrial.tokenForm.label')}
              <input
                value={tokenLabel}
                onChange={event => setTokenLabel(event.target.value)}
                maxLength={120}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
            </label>
            <label className="block text-xs text-gray-400">
              {t('operations.freeTrial.tokenForm.maxUses')}
              <input
                type="number"
                min={1}
                max={10000}
                value={tokenMaxUses}
                onChange={event => setTokenMaxUses(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
              <span className="mt-1 block text-[11px] text-gray-600">{t('operations.freeTrial.tokenForm.maxUsesHint')}</span>
            </label>
            <label className="block text-xs text-gray-400">
              {t('operations.freeTrial.tokenForm.expiresAt')}
              <input
                type="datetime-local"
                value={tokenExpiresAt}
                onChange={event => setTokenExpiresAt(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
              <span className="mt-1 block text-[11px] text-gray-600">{t('operations.freeTrial.tokenForm.expiresAtHint')}</span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowTokenForm(false)}
              className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition hover:bg-white/5"
            >
              {t('operations.freeTrial.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('operations.freeTrial.tokenForm.submit')}
            </button>
          </div>
        </form>
      )}

      {/* ── Jetons émis ──────────────────────────────────────────────────────── */}
      {tokens.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.tokensTitle')}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">{t('operations.freeTrial.columns.token')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.columns.label')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.columns.uses')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.columns.tokenState')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.columns.createdAt')}</th>
                  <th className="px-4 py-2 text-right">{t('operations.freeTrial.columns.action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {tokens.map(jeton => (
                  <tr key={jeton.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void copier(jeton.token)}
                        className="inline-flex items-center gap-2 font-mono text-xs font-semibold text-cyan-300 transition hover:text-cyan-200"
                        title={t('operations.freeTrial.copy')}
                      >
                        {jeton.token}
                        {copied === jeton.token ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{jeton.label || '—'}</td>
                    <td className="px-4 py-3 text-gray-400">
                      {jeton.maxUses === null || jeton.maxUses === undefined
                        ? t('operations.freeTrial.usesUnlimited', { used: formatNumber(jeton.usedCount) })
                        : t('operations.freeTrial.usesLimited', {
                            used: formatNumber(jeton.usedCount),
                            max: formatNumber(jeton.maxUses),
                          })}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${tokenStateClasses(jeton.state)}`}>
                        {t(TOKEN_STATE_LABELS[jeton.state] ?? 'operations.common.unknown')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{formatDate(jeton.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {canRevokeToken && jeton.state === 'active' && (
                        <button
                          type="button"
                          onClick={() => void revoquerJeton(jeton.id)}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/25 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
                        >
                          <Ban className="h-3.5 w-3.5" />
                          {t('operations.freeTrial.revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Étape 3 : demandes ───────────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.requestsTitle')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('operations.freeTrial.searchPlaceholder')}
                className="w-56 rounded-lg border border-white/10 bg-slate-900/60 py-1.5 pl-8 pr-3 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
            </div>
            <select
              value={statusFilter}
              onChange={event => { setStatusFilter(event.target.value); setSelection([]); }}
              className="rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-cyan-500/50"
            >
              <option value={FREE_TRIAL_STATUS.PENDING}>{t('operations.freeTrial.status.pending')}</option>
              <option value={FREE_TRIAL_STATUS.DEPLOYED}>{t('operations.freeTrial.status.deployed')}</option>
              <option value={FREE_TRIAL_STATUS.REJECTED}>{t('operations.freeTrial.status.rejected')}</option>
              <option value="">{t('operations.freeTrial.status.all')}</option>
            </select>
          </div>
        </div>

        {canDeploy && selectionValide.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-cyan-500/[0.06] px-4 py-3">
            <span className="text-sm text-cyan-200">
              {t('operations.freeTrial.selected', { count: formatNumber(selectionValide.length) })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={refuser}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/25 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
              >
                <Ban className="h-3.5 w-3.5" />
                {t('operations.freeTrial.reject')}
              </button>
              <button
                type="button"
                onClick={ouvrirDeploiement}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                <Rocket className="h-3.5 w-3.5" />
                {t('operations.freeTrial.configureAndDeploy')}
              </button>
            </div>
          </div>
        )}

        {/* Le formulaire n'apparaît qu'APRÈS sélection : c'est l'ordre imposé
            par la spécification — d'abord qui, ensuite quoi. */}
        {showDeployForm && canDeploy && selectionValide.length > 0 && (
          <form onSubmit={deployer} className="space-y-4 border-b border-white/10 bg-slate-900/40 px-4 py-5">
            <div>
              <h3 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.deployForm.title')}</h3>
              <p className="mt-1 text-xs text-gray-500">
                {t('operations.freeTrial.deployForm.hint', { count: formatNumber(selectionValide.length) })}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="block text-xs text-gray-400">
                {t('operations.freeTrial.deployForm.server')}
                <select
                  required
                  value={profileId}
                  onChange={event => setProfileId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                >
                  <option value="">{t('operations.freeTrial.deployForm.serverPlaceholder')}</option>
                  {profiles.map(profil => (
                    <option key={profil.id} value={profil.id}>{profil.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-gray-400">
                {t('operations.freeTrial.deployForm.quota')}
                <input
                  type="number"
                  required
                  min={0.1}
                  step={0.1}
                  value={quotaGB}
                  onChange={event => setQuotaGB(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                />
              </label>
              <label className="block text-xs text-gray-400">
                {t('operations.freeTrial.deployForm.deviceLimit')}
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={deviceLimit}
                  onChange={event => setDeviceLimit(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                />
              </label>
              <label className="block text-xs text-gray-400">
                {t('operations.freeTrial.deployForm.startAt')}
                <input
                  type="datetime-local"
                  value={startAt}
                  onChange={event => setStartAt(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                />
              </label>
              <label className="block text-xs text-gray-400">
                {t('operations.freeTrial.deployForm.expireAt')}
                <input
                  type="datetime-local"
                  required
                  value={expireAt}
                  onChange={event => setExpireAt(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                />
              </label>
              <label className="block text-xs text-gray-400">
                {t('operations.freeTrial.deployForm.note')}
                <input
                  value={deployNote}
                  onChange={event => setDeployNote(event.target.value)}
                  maxLength={280}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDeployForm(false)}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition hover:bg-white/5"
              >
                {t('operations.freeTrial.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !profileId || !expireAt}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                {t('operations.freeTrial.deploy')}
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-10 px-4 py-2">
                  {canDeploy && selectionnables.length > 0 && (
                    <input
                      type="checkbox"
                      checked={toutSelectionne}
                      onChange={basculerTout}
                      aria-label={t('operations.freeTrial.selectAll')}
                      className="h-4 w-4 rounded border-white/20 bg-slate-900"
                    />
                  )}
                </th>
                <th className="px-4 py-2">{t('operations.freeTrial.columns.name')}</th>
                <th className="px-4 py-2">{t('operations.freeTrial.columns.deviceId')}</th>
                <th className="px-4 py-2">{t('operations.freeTrial.columns.token')}</th>
                <th className="px-4 py-2">{t('operations.freeTrial.columns.status')}</th>
                <th className="px-4 py-2">{t('operations.freeTrial.columns.submittedAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {visibles.map(demande => (
                <tr key={demande.id} className="align-top hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    {canDeploy && demande.status === FREE_TRIAL_STATUS.PENDING && (
                      <input
                        type="checkbox"
                        checked={selectionValide.includes(demande.id)}
                        onChange={() => basculer(demande.id)}
                        aria-label={t('operations.freeTrial.selectOne', { name: demande.name })}
                        className="h-4 w-4 rounded border-white/20 bg-slate-900"
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-200">
                    {demande.name}
                    {demande.platform && (
                      <div className="mt-1 text-[11px] text-gray-500">
                        {demande.appVersion
                          ? t('operations.freeTrial.platformVersion', { platform: demande.platform, version: demande.appVersion })
                          : demande.platform}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-gray-400">{demande.deviceId}</td>
                  <td className="px-4 py-3 font-mono text-xs text-cyan-300/80">{demande.trialToken || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusClasses(demande.status)}`}>
                      {t(STATUS_LABELS[demande.status] ?? 'operations.common.unknown')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatDate(demande.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibles.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-gray-500">{t('operations.freeTrial.empty')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
