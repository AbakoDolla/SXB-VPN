import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Gift,
  Globe2,
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
  fetchFreeTrialCountryStats,
  fetchFreeTrialOverview,
  fetchFreeTrialRequestPage,
  fetchFreeTrialTokens,
  rejectFreeTrialRequests,
  revokeFreeTrialToken,
  FREE_TRIAL_STATUS,
  MAX_FREE_TRIAL_BATCH,
  type FreeTrialCountryStats,
  type FreeTrialDeployResponse,
  type FreeTrialOverview,
  type FreeTrialRequest,
  type FreeTrialToken,
} from '../api/free-trial';
import { countryFlag, countryName } from '../lib/countries';
import { fetchVpnProfiles, type VpnProfile } from '../api/vpn-profiles';
import Pagination from './ui/Pagination';

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
///
/// ORGANISATION IMPOSÉE PAR LE PROPRIÉTAIRE : les demandes vivent SOUS le jeton
/// qui les a produites, dans un volet dépliable, et jamais dans une liste
/// commune. Avec 200 inscriptions réparties sur plusieurs campagnes, une liste
/// unique mélangeait tout ; ici chaque jeton porte les siennes, la sélection ne
/// traverse jamais deux jetons, et le volet ne charge ses demandes qu'à son
/// ouverture — page par page.
///
/// La recherche transversale reste disponible pour retrouver quelqu'un sans
/// savoir sous quel jeton il se trouve ; elle est volontairement en LECTURE
/// SEULE, l'action se faisant toujours dans le contexte d'un jeton.

/** Correspondance statut de demande → clé i18n. */
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

/** Demandes affichées par page dans un volet. 200 inscrits restent lisibles. */
const TAILLE_PAGE = 25;

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

/** Contenu chargé pour UN jeton : ses demandes, leur total, son état de page. */
interface VoletJeton {
  requests: FreeTrialRequest[];
  total: number;
  page: number;
  loading: boolean;
}

const VOLET_VIDE: VoletJeton = { requests: [], total: 0, page: 1, loading: true };

export default function FreeTrialView() {
  const { t, language, formatDate, formatNumber, errorMessage } = useTranslation();
  const can = usePermissions();

  const [tokens, setTokens] = useState<FreeTrialToken[]>([]);
  const [countryStats, setCountryStats] = useState<FreeTrialCountryStats | null>(null);
  // Indicateurs PROPRES aux essais. Ils ne partagent aucune source avec les
  // compteurs des comptes principaux : tout dérive des demandes d'essai.
  const [overview, setOverview] = useState<FreeTrialOverview | null>(null);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>(FREE_TRIAL_STATUS.PENDING);
  const [copied, setCopied] = useState<string | null>(null);

  // ── Volets par jeton : ouverture, contenu, sélection ───────────────────────
  const [jetonOuvert, setJetonOuvert] = useState<string | null>(null);
  const [volets, setVolets] = useState<Record<string, VoletJeton>>({});
  // La sélection est indexée PAR JETON : il n'existe structurellement aucune
  // sélection qui traverse deux campagnes.
  const [selectionParJeton, setSelectionParJeton] = useState<Record<string, string[]>>({});
  const [resultatLot, setResultatLot] = useState<FreeTrialDeployResponse | null>(null);

  // ── Recherche transversale, en lecture seule ───────────────────────────────
  const [search, setSearch] = useState('');
  const [resultats, setResultats] = useState<FreeTrialRequest[] | null>(null);
  const [rechercheEnCours, setRechercheEnCours] = useState(false);

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
      const [listeJetons, stats, indicateurs] = await Promise.all([
        can('tokens.view') ? fetchFreeTrialTokens() : Promise.resolve([] as FreeTrialToken[]),
        // Le récapitulatif par pays porte sur TOUTES les demandes, pas
        // seulement sur celles du filtre affiché : « combien de clients et
        // d'où » est une question globale.
        fetchFreeTrialCountryStats(),
        fetchFreeTrialOverview(),
      ]);
      setTokens(listeJetons);
      setCountryStats(stats);
      setOverview(indicateurs);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setLoading(false);
    }
  }, [can, errorMessage]);

  useEffect(() => {
    void charger();
  }, [charger]);

  /**
   * Charge UNE page de demandes pour UN jeton.
   *
   * C'est le seul chemin de lecture des demandes en mode groupé : la page
   * d'accueil n'en charge aucune, et ouvrir un jeton ne charge jamais celles
   * des autres.
   */
  const chargerVolet = useCallback(async (tokenId: string, page: number) => {
    setVolets(prev => ({ ...prev, [tokenId]: { ...(prev[tokenId] ?? VOLET_VIDE), page, loading: true } }));
    try {
      const resultat = await fetchFreeTrialRequestPage({
        tokenId,
        status: statusFilter || undefined,
        limit: TAILLE_PAGE,
        offset: (page - 1) * TAILLE_PAGE,
      });
      setVolets(prev => ({
        ...prev,
        [tokenId]: { requests: resultat.requests, total: resultat.total, page, loading: false },
      }));
    } catch (err) {
      setVolets(prev => ({ ...prev, [tokenId]: { ...(prev[tokenId] ?? VOLET_VIDE), page, loading: false } }));
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    }
  }, [statusFilter, errorMessage]);

  const basculerJeton = (tokenId: string) => {
    setResultatLot(null);
    setShowDeployForm(false);
    if (jetonOuvert === tokenId) {
      setJetonOuvert(null);
      return;
    }
    setJetonOuvert(tokenId);
    void chargerVolet(tokenId, 1);
  };

  // Changer de filtre invalide les volets déjà chargés : leur contenu ne
  // correspondrait plus à ce que l'utilisateur croit voir.
  useEffect(() => {
    setVolets({});
    setSelectionParJeton({});
    setResultats(null);
    if (jetonOuvert) void chargerVolet(jetonOuvert, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

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

  const lancerRecherche = useCallback(async (terme: string) => {
    if (!terme.trim()) {
      setResultats(null);
      return;
    }
    setRechercheEnCours(true);
    try {
      // Une seule page bornée : la recherche sert à RETROUVER quelqu'un, pas à
      // rapatrier le vivier complet.
      const page = await fetchFreeTrialRequestPage({ status: statusFilter || undefined, limit: 200 });
      const requete = terme.trim().toLowerCase();
      setResultats(page.requests.filter(demande =>
        demande.name.toLowerCase().includes(requete) ||
        demande.deviceId.toLowerCase().includes(requete) ||
        // La recherche accepte aussi le pays, par son code ou son nom traduit :
        // « CM » comme « Cameroun » retrouvent les mêmes inscrits.
        (demande.country ?? '').toLowerCase().includes(requete) ||
        (countryName(demande.country, language) ?? '').toLowerCase().includes(requete) ||
        (demande.trialToken ?? '').toLowerCase().includes(requete)));
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setRechercheEnCours(false);
    }
  }, [statusFilter, language, errorMessage]);

  useEffect(() => {
    const minuterie = window.setTimeout(() => { void lancerRecherche(search); }, 350);
    return () => window.clearTimeout(minuterie);
  }, [search, lancerRecherche]);

  // ── Sélection, strictement bornée au jeton courant ─────────────────────────
  const volet = jetonOuvert ? volets[jetonOuvert] ?? VOLET_VIDE : null;
  // Seules les demandes EN ATTENTE sont déployables : une demande déjà servie
  // ne doit pas pouvoir être re-servie par une case cochée par mégarde.
  const selectionnables = useMemo(
    () => (volet?.requests ?? []).filter(demande => demande.status === FREE_TRIAL_STATUS.PENDING),
    [volet],
  );
  const selectionCourante = jetonOuvert ? selectionParJeton[jetonOuvert] ?? [] : [];
  const selectionValide = useMemo(
    () => selectionCourante.filter(id => selectionnables.some(demande => demande.id === id)),
    [selectionCourante, selectionnables],
  );
  const toutSelectionne = selectionnables.length > 0 && selectionValide.length === selectionnables.length;
  const lotTropGrand = selectionValide.length > MAX_FREE_TRIAL_BATCH;

  const basculer = (id: string) => {
    if (!jetonOuvert) return;
    setSelectionParJeton(prev => {
      const courante = prev[jetonOuvert] ?? [];
      return {
        ...prev,
        [jetonOuvert]: courante.includes(id) ? courante.filter(item => item !== id) : [...courante, id],
      };
    });
  };

  const basculerTout = () => {
    if (!jetonOuvert) return;
    setSelectionParJeton(prev => ({
      ...prev,
      [jetonOuvert]: toutSelectionne ? [] : selectionnables.map(demande => demande.id),
    }));
  };

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
    if (!jetonOuvert || selectionValide.length === 0) return;
    if (lotTropGrand) {
      setError(t('operations.freeTrial.batch.tooMany', { max: formatNumber(MAX_FREE_TRIAL_BATCH) }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setResultatLot(null);
    try {
      const reponse = await deployFreeTrialRequests({
        requestIds: selectionValide,
        // Le jeton du contexte accompagne le lot : le serveur revérifie que
        // chaque demande en relève, plutôt que de croire la liste reçue.
        tokenId: jetonOuvert,
        profileId,
        quotaGB: Number(quotaGB),
        startAt: startAt ? new Date(startAt).toISOString() : undefined,
        expireAt: new Date(expireAt).toISOString(),
        deviceLimit: deviceLimit.trim() ? Number(deviceLimit) : undefined,
        note: deployNote.trim() || undefined,
      });
      setResultatLot(reponse);
      setNotice(t('operations.freeTrial.notice.deployed', {
        deployed: formatNumber(reponse.deployed),
        total: formatNumber(reponse.total),
      }));
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      setShowDeployForm(false);
      await Promise.all([charger(), chargerVolet(jetonOuvert, volet?.page ?? 1)]);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const refuser = async () => {
    if (!jetonOuvert || selectionValide.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const reponse = await rejectFreeTrialRequests({ requestIds: selectionValide, tokenId: jetonOuvert });
      setNotice(t('operations.freeTrial.notice.rejected', { count: formatNumber(reponse.rejected) }));
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      await Promise.all([charger(), chargerVolet(jetonOuvert, volet?.page ?? 1)]);
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

  /** Ligne de demande, réutilisée par le volet et par la recherche. */
  const ligneDemande = (demande: FreeTrialRequest, selectionnable: boolean) => (
    <tr key={demande.id} className="align-top hover:bg-white/[0.02]">
      <td className="px-4 py-3">
        {selectionnable && canDeploy && demande.status === FREE_TRIAL_STATUS.PENDING && (
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
      {/* Pays DÉCLARÉ par l'inscrit : drapeau, nom traduit et code ISO. Aucune
          géolocalisation n'entre dans ce champ. */}
      <td className="px-4 py-3 text-xs text-gray-300">
        {countryName(demande.country, language) ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true">{countryFlag(demande.country)}</span>
            <span>{countryName(demande.country, language)}</span>
            <span className="font-mono text-[10px] text-gray-500">{demande.country}</span>
          </span>
        ) : (
          <span className="text-gray-600">{t('operations.freeTrial.countryUnknown')}</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-gray-400">{demande.deviceId}</td>
      <td className="px-4 py-3">
        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusClasses(demande.status)}`}>
          {t(STATUS_LABELS[demande.status] ?? 'operations.common.unknown')}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-gray-500">{formatDate(demande.submittedAt)}</td>
    </tr>
  );

  const enteteDemandes = (avecSelection: boolean) => (
    <thead className="text-[11px] uppercase tracking-wide text-gray-500">
      <tr>
        <th className="w-10 px-4 py-2">
          {avecSelection && canDeploy && selectionnables.length > 0 && (
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
        <th className="px-4 py-2">{t('operations.freeTrial.columns.country')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.deviceId')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.status')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.submittedAt')}</th>
      </tr>
    </thead>
  );

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

      {/* ── Indicateurs PROPRES aux essais ───────────────────────────────────
          Ils ne se mélangent jamais à ceux des comptes principaux : chacun
          dérive des demandes d'essai, jamais du parc commercial. « Connectés
          maintenant » réutilise la mesure de présence déjà en place, et dit
          explicitement quand elle n'a pas pu être faite. */}
      {overview && (
        <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-gray-200">
              <Gift className="h-4 w-4 text-fuchsia-400" />
              {t('operations.freeTrial.metrics.title')}
            </h2>
            <p className="text-xs text-gray-500">{t('operations.freeTrial.metrics.hint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-px bg-white/5 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { cle: 'total', libelle: t('operations.freeTrial.metrics.total'), valeur: overview.total, couleur: 'text-gray-100' },
              { cle: 'pending', libelle: t('operations.freeTrial.metrics.pending'), valeur: overview.pending, couleur: 'text-amber-300' },
              { cle: 'deployed', libelle: t('operations.freeTrial.metrics.deployed'), valeur: overview.deployed, couleur: 'text-emerald-300' },
              { cle: 'rejected', libelle: t('operations.freeTrial.metrics.rejected'), valeur: overview.rejected, couleur: 'text-rose-300' },
              { cle: 'active', libelle: t('operations.freeTrial.metrics.active'), valeur: overview.active, couleur: 'text-cyan-300' },
            ].map(({ cle, libelle, valeur, couleur }) => (
              <div key={cle} className="bg-slate-950/40 px-4 py-3">
                <p className={`text-2xl font-bold ${couleur}`}>{formatNumber(valeur)}</p>
                <p className="text-xs text-gray-500">{libelle}</p>
              </div>
            ))}
            <div className="bg-slate-950/40 px-4 py-3">
              <p className="text-2xl font-bold text-fuchsia-300">
                {overview.connectedNow === null
                  ? t('operations.freeTrial.metrics.connectedUnmeasured')
                  : formatNumber(overview.connectedNow)}
              </p>
              <p className="text-xs text-gray-500">{t('operations.freeTrial.metrics.connected')}</p>
            </div>
          </div>
          {/* Honnêteté du chiffre : un essai déployé sur un appareil dont
              l'application ne rapporte pas encore sa présence n'est pas compté.
              Le dire vaut mieux que laisser lire un zéro comme « personne ». */}
          <p className="px-4 py-3 text-[11px] leading-relaxed text-gray-500">
            {overview.connectedNow === null
              ? t('operations.freeTrial.metrics.connectedUnmeasuredHint')
              : t('operations.freeTrial.metrics.connectedHint', {
                  window: formatNumber(overview.presence.windowMinutes),
                  heartbeat: formatNumber(overview.presence.heartbeatMinutes),
                })}
            {' '}
            {t('operations.freeTrial.metrics.activeHint')}
          </p>
        </section>
      )}

      {/* ── D'où viennent nos clients ────────────────────────────────────────
          Récapitulatif par pays, du plus gros volume au plus petit. Le pays est
          celui que l'inscrit a DÉCLARÉ : aucune adresse IP, aucune position. */}
      {countryStats && countryStats.countries.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-gray-200">
              <Globe2 className="h-4 w-4 text-cyan-400" />
              {t('operations.freeTrial.countries.title')}
            </h2>
            <p className="text-xs text-gray-500">
              {t('operations.freeTrial.countries.totals', {
                clients: formatNumber(countryStats.totals.clients),
                requests: formatNumber(countryStats.totals.requests),
                countries: formatNumber(countryStats.totals.countries),
              })}
            </p>
          </div>
          <p className="px-4 pt-3 text-[11px] text-gray-500">{t('operations.freeTrial.countries.declaredHint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">{t('operations.freeTrial.columns.country')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.countries.clients')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.countries.requests')}</th>
                  <th className="px-4 py-2">{t('operations.freeTrial.countries.pending')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {countryStats.countries.map(ligne => (
                  <tr key={ligne.country ?? 'unknown'} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 text-gray-200">
                      {countryName(ligne.country, language) ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden="true">{countryFlag(ligne.country)}</span>
                          <span>{countryName(ligne.country, language)}</span>
                          <span className="font-mono text-[10px] text-gray-500">{ligne.country}</span>
                        </span>
                      ) : (
                        <span className="text-gray-600">{t('operations.freeTrial.countryUnknown')}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-cyan-300">{formatNumber(ligne.clients)}</td>
                    <td className="px-4 py-2.5 text-gray-300">{formatNumber(ligne.requests)}</td>
                    <td className="px-4 py-2.5 text-gray-400">{formatNumber(ligne.pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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

      {/* ── Étapes 2-3 : chaque jeton porte SES demandes ─────────────────────── */}
      <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.tokensTitle')}</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">{t('operations.freeTrial.groupedHint')}</p>
          </div>
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
              onChange={event => setStatusFilter(event.target.value)}
              className="rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-cyan-500/50"
            >
              <option value={FREE_TRIAL_STATUS.PENDING}>{t('operations.freeTrial.status.pending')}</option>
              <option value={FREE_TRIAL_STATUS.DEPLOYED}>{t('operations.freeTrial.status.deployed')}</option>
              <option value={FREE_TRIAL_STATUS.REJECTED}>{t('operations.freeTrial.status.rejected')}</option>
              <option value="">{t('operations.freeTrial.status.all')}</option>
            </select>
          </div>
        </div>

        {tokens.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-gray-500">{t('operations.freeTrial.noToken')}</p>
        )}

        <div className="divide-y divide-white/5">
          {tokens.map(jeton => {
            const ouvert = jetonOuvert === jeton.id;
            const contenu = volets[jeton.id];
            return (
              <div key={jeton.id}>
                {/* Ligne du jeton : compteurs lisibles sans ouvrir le volet. */}
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                  <button
                    type="button"
                    onClick={() => basculerJeton(jeton.id)}
                    aria-expanded={ouvert}
                    className="inline-flex items-center gap-2 text-gray-300 transition hover:text-gray-100"
                  >
                    {ouvert ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="font-mono text-xs font-semibold text-cyan-300">{jeton.token}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void copier(jeton.token)}
                    aria-label={t('operations.freeTrial.copy')}
                    className="text-gray-500 transition hover:text-gray-200"
                  >
                    {copied === jeton.token ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-sm text-gray-300">{jeton.label || '—'}</span>
                  <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${tokenStateClasses(jeton.state)}`}>
                    {t(TOKEN_STATE_LABELS[jeton.state] ?? 'operations.common.unknown')}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {jeton.maxUses === null || jeton.maxUses === undefined
                      ? t('operations.freeTrial.usesUnlimited', { used: formatNumber(jeton.usedCount) })
                      : t('operations.freeTrial.usesLimited', {
                          used: formatNumber(jeton.usedCount),
                          max: formatNumber(jeton.maxUses),
                        })}
                  </span>
                  <span className="text-[11px] text-amber-300/90">
                    {t('operations.freeTrial.counters', {
                      pending: formatNumber(jeton.pendingCount ?? 0),
                      deployed: formatNumber(jeton.deployedCount ?? 0),
                    })}
                  </span>
                  <span className="ml-auto text-[11px] text-gray-500">{formatDate(jeton.createdAt)}</span>
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
                </div>

                {/* Volet : LES DEMANDES DE CE JETON, et d'aucun autre. */}
                {ouvert && (
                  <div className="border-t border-white/5 bg-slate-950/40">
                    {contenu?.loading && (
                      <p className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('operations.freeTrial.loading')}
                      </p>
                    )}

                    {!contenu?.loading && (contenu?.requests.length ?? 0) === 0 && (
                      <p className="px-4 py-8 text-center text-sm text-gray-500">{t('operations.freeTrial.empty')}</p>
                    )}

                    {!contenu?.loading && (contenu?.requests.length ?? 0) > 0 && (
                      <>
                        {canDeploy && selectionValide.length > 0 && (
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-cyan-500/[0.06] px-4 py-3">
                            <div>
                              <span className="text-sm text-cyan-200">
                                {t('operations.freeTrial.selected', { count: formatNumber(selectionValide.length) })}
                              </span>
                              {/* Même avertissement que la suppression groupée :
                                  « tout sélectionner » ne couvre que ce qui est
                                  affiché, jamais les pages non chargées. */}
                              <p className="mt-0.5 text-[11px] text-gray-400">
                                {t('operations.freeTrial.batch.loadedOnly', { max: formatNumber(MAX_FREE_TRIAL_BATCH) })}
                              </p>
                            </div>
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
                                disabled={busy || lotTropGrand}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                              >
                                <Rocket className="h-3.5 w-3.5" />
                                {t('operations.freeTrial.configureAndDeploy')}
                              </button>
                            </div>
                          </div>
                        )}

                        {lotTropGrand && (
                          <p className="border-b border-white/10 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
                            {t('operations.freeTrial.batch.tooMany', { max: formatNumber(MAX_FREE_TRIAL_BATCH) })}
                          </p>
                        )}

                        {/* Le formulaire n'apparaît qu'APRÈS sélection : c'est
                            l'ordre imposé par la spécification — d'abord qui,
                            ensuite quoi. Tous les champs sont visibles en même
                            temps, comme pour les forfaits groupés. */}
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
                            {/* Récapitulatif avant confirmation : qui reçoit
                                quoi, sous quel jeton, et rien d'implicite. */}
                            <p className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-[11px] text-gray-400">
                              {t('operations.freeTrial.batch.recap', {
                                count: formatNumber(selectionValide.length),
                                token: jeton.token,
                              })}
                            </p>
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
                                disabled={busy || !profileId || !expireAt || lotTropGrand}
                                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                                {t('operations.freeTrial.batch.deployTo', { count: formatNumber(selectionValide.length) })}
                              </button>
                            </div>
                          </form>
                        )}

                        {/* Résultat élément par élément : un échec isolé
                            n'annule pas les réussites, et on le dit. */}
                        {resultatLot && (
                          <div className="border-b border-white/10 bg-slate-900/40 px-4 py-3 text-xs text-gray-300">
                            <p className="font-semibold text-gray-200">{t('operations.freeTrial.batch.done')}</p>
                            <p className="mt-1">
                              {t('operations.freeTrial.batch.summary', {
                                selected: formatNumber(resultatLot.total),
                                succeeded: formatNumber(resultatLot.deployed),
                                failed: formatNumber(resultatLot.results.filter(item => item.status !== 'deployed').length),
                              })}
                            </p>
                            {resultatLot.results.filter(item => item.status !== 'deployed').map(item => (
                              <p key={item.id} className="mt-0.5 text-rose-300/90">
                                {t('operations.freeTrial.batch.failedItem', {
                                  id: item.id,
                                  reason: t(RESULT_LABELS[item.status] ?? 'operations.freeTrial.result.failed'),
                                })}
                              </p>
                            ))}
                          </div>
                        )}

                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            {enteteDemandes(true)}
                            <tbody className="divide-y divide-white/5">
                              {(contenu?.requests ?? []).map(demande => ligneDemande(demande, true))}
                            </tbody>
                          </table>
                        </div>

                        <div className="px-4 py-3">
                          <Pagination
                            page={contenu?.page ?? 1}
                            pageSize={TAILLE_PAGE}
                            total={contenu?.total ?? 0}
                            onPageChange={page => void chargerVolet(jeton.id, page)}
                            disabled={busy}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Recherche transversale ───────────────────────────────────────────
          Pour retrouver quelqu'un sans savoir sous quel jeton il se trouve. En
          LECTURE SEULE : l'action passe toujours par le volet du jeton, ce qui
          garantit qu'une sélection ne mélange jamais deux campagnes. */}
      {search.trim() !== '' && (
        <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.searchTitle')}</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">{t('operations.freeTrial.searchHint')}</p>
          </div>
          {rechercheEnCours && (
            <p className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('operations.freeTrial.loading')}
            </p>
          )}
          {!rechercheEnCours && (resultats?.length ?? 0) === 0 && (
            <p className="px-4 py-8 text-center text-sm text-gray-500">{t('operations.freeTrial.empty')}</p>
          )}
          {!rechercheEnCours && (resultats?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                {enteteDemandes(false)}
                <tbody className="divide-y divide-white/5">
                  {(resultats ?? []).map(demande => ligneDemande(demande, false))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
