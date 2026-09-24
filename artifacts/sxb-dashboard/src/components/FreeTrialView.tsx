import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Globe2,
  HardDrive,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Trash2,
  ArrowUpRight,
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
  manageFreeTrialRequests,
  rejectFreeTrialRequests,
  deleteFreeTrialRequests,
  convertFreeTrialRequests,
  revokeFreeTrialToken,
  updateFreeTrialToken,
  deleteFreeTrialToken,
  fetchFreeTrialActivity,
  FREE_TRIAL_STATE,
  FREE_TRIAL_STATUS,
  MAX_FREE_TRIAL_PROFILES,
  type FreeTrialCountryStats,
  type FreeTrialDeployResponse,
  type FreeTrialManageResponse,
  type FreeTrialOverview,
  type FreeTrialRequest,
  type FreeTrialState,
  type FreeTrialActivity,
  type FreeTrialToken,
} from '../api/free-trial';
import { countryFlag, countryName } from '../lib/countries';
import { fetchVpnProfiles, type VpnProfile } from '../api/vpn-profiles';
import Pagination from './ui/Pagination';
import { TrialGlyph, TrialTag } from './TrialBadge';

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
///
/// SÉPARATION TOTALE — « Forfaits Data », « Comptes VPN » et « Appareils » ne
/// portent plus AUCUNE option d'essai : ni bascule, ni filtre, ni case. Tout ce
/// qui concerne un essai se décide ici, y compris sur un essai DÉJÀ déployé.
/// C'est pourquoi cette vue offre, en plus du déploiement :
///   • la LECTURE de l'accès courant (serveurs attribués, quota accordé et
///     consommé, échéance, état) directement sur la ligne de l'inscrit ;
///   • un panneau de GESTION GROUPÉE qui attribue ou remplace un serveur,
///     modifie le quota, prolonge ou raccourcit l'échéance, suspend, réactive
///     ou révoque — sur une sélection multiple, comme le déploiement.
/// Ces capacités ne dupliquent pas celles des forfaits : la route serveur
/// s'appuie sur la mécanique groupée déjà écrite (`subscription-bulk`).

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

/**
 * Issue d'une gestion unitaire → clé i18n.
 *
 * Les clés suivent les états que le SERVEUR émet — `ok`, `partial`, `skipped`,
 * `failed`. Elles ont un jour porté d'autres noms, et le tableau affichait
 * alors chaque réussite comme un échec : le filtre ne reconnaissait pas `ok`,
 * et le libellé de repli était « Failed ». Une opération dont vingt-deux
 * dossiers sur vingt-cinq avaient abouti se lisait comme un désastre complet.
 */
const MANAGE_RESULT_LABELS: Record<string, string> = {
  ok: 'operations.freeTrial.manageResult.updated',
  partial: 'operations.freeTrial.manageResult.partial',
  updated: 'operations.freeTrial.manageResult.updated',
  skipped: 'operations.freeTrial.manageResult.skipped',
  failed: 'operations.freeTrial.manageResult.failed',
};

/** Ce que le panneau de gestion fait des configurations VPN. */
type ModeServeur = 'keep' | 'replace' | 'add' | 'remove';

/** Ce que le panneau de gestion fait de l'échéance. */
type ModeEcheance = 'keep' | 'expire' | 'duration';

/** Demandes affichées par page dans un volet. 200 inscrits restent lisibles. */
const TAILLE_PAGE = 25;

/**
 * Cadence de relecture de l'état de connexion.
 *
 * Une minute : la fenêtre de présence est de 15 minutes et le battement de 5,
 * donc rien de plus fin n'apporterait d'information — cela ne ferait que
 * transformer cet écran en sonde.
 */
const RAFRAICHISSEMENT_PRESENCE_MS = 60_000;

function statusClasses(status: string): string {
  if (status === FREE_TRIAL_STATUS.DEPLOYED) return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  if (status === FREE_TRIAL_STATUS.REJECTED) return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
  // Converti : ni vert d'essai en cours, ni rouge de refus. Le violet dit une
  // TROISIÈME nature — l'essai a réussi et la ligne n'est plus un essai. Le
  // confondre avec « déployé » masquerait la seule information qui compte ici.
  if (status === FREE_TRIAL_STATUS.CONVERTED) return 'border-violet-500/25 bg-violet-500/10 text-violet-300';
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
  /**
   * Vrai quand la lecture a ÉCHOUÉ.
   *
   * Sans ce drapeau, un volet dont la requête tombe se rend exactement comme un
   * volet légitimement vide, et affiche « Aucune demande d'essai gratuit pour
   * ce filtre » alors que la ligne du jeton annonce juste au-dessus
   * « 1 déployée(s) ». L'écran se contredit, et l'exploitant conclut que sa
   * campagne a disparu.
   */
  failed?: boolean;
}

const VOLET_VIDE: VoletJeton = { requests: [], total: 0, page: 1, loading: true };

export default function FreeTrialView() {
  const { t, language, formatDate, formatNumber, formatBytes, errorMessage } = useTranslation();
  const can = usePermissions();

  const [tokens, setTokens] = useState<FreeTrialToken[]>([]);
  // Liste des comptes en essai : repliée par défaut. Sur un téléphone, la
  // dérouler d'office obligeait à faire défiler des dizaines de lignes avant
  // d'atteindre le reste de l'écran.
  const [comptesDeplies, setComptesDeplies] = useState(false);
  const [countryStats, setCountryStats] = useState<FreeTrialCountryStats | null>(null);
  // Indicateurs PROPRES aux essais. Ils ne partagent aucune source avec les
  // compteurs des comptes principaux : tout dérive des demandes d'essai.
  const [overview, setOverview] = useState<FreeTrialOverview | null>(null);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Filtre de statut — TOUS par défaut.
   *
   * Il s'ouvrait sur « En attente de vérification », ce qui masquait chaque
   * essai déjà déployé : dépliez un jeton dont toutes les demandes sont
   * traitées et vous lisiez « Aucune demande d'essai gratuit pour ce filtre »,
   * alors que la ligne existait avec son forfait attribué, son quota et son
   * échéance. Or c'est précisément ici, et nulle part ailleurs, que se
   * consultent et se gèrent les accès d'essai : partir d'une vue qui en cache
   * une partie fait croire qu'ils ne sont pas affichés du tout.
   */
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [copied, setCopied] = useState<string | null>(null);
  /** Une sélection sur tout le jeton est en cours : elle parcourt les pages. */
  const [chargementTotal, setChargementTotal] = useState(false);

  // ── Volets par jeton : ouverture, contenu, sélection ───────────────────────
  const [jetonOuvert, setJetonOuvert] = useState<string | null>(null);
  const [volets, setVolets] = useState<Record<string, VoletJeton>>({});
  // La sélection est indexée PAR JETON : il n'existe structurellement aucune
  // sélection qui traverse deux campagnes.
  const [selectionParJeton, setSelectionParJeton] = useState<Record<string, string[]>>({});
  const [selectionGlobaleParJeton, setSelectionGlobaleParJeton] = useState<Record<string, number>>({});
  const [demandesGlobalesParJeton, setDemandesGlobalesParJeton] = useState<Record<string, FreeTrialRequest[]>>({});
  const [resultatLot, setResultatLot] = useState<FreeTrialDeployResponse | null>(null);
  const [resultatGestion, setResultatGestion] = useState<FreeTrialManageResponse | null>(null);

  // ── Conversion d'un essai en client ordinaire ──────────────────────────────
  //
  // Le formulaire n'a que trois champs, TOUS facultatifs. C'est délibéré :
  // convertir sans rien remplir garde l'accès tel quel et ne change que sa
  // nature, ce qui est le geste le plus courant. Remplir quota et durée fait
  // du converti un client mieux servi — c'est là toute la différence entre un
  // forfait « normal » et un « VIP », et elle ne mérite pas un second écran.
  const [showConvertForm, setShowConvertForm] = useState(false);
  const [convertQuota, setConvertQuota] = useState('');
  const [convertDuree, setConvertDuree] = useState('');
  const [convertNom, setConvertNom] = useState('');

  // ── Recherche transversale, en lecture seule ───────────────────────────────
  const [search, setSearch] = useState('');
  const [resultats, setResultats] = useState<FreeTrialRequest[] | null>(null);
  const [rechercheEnCours, setRechercheEnCours] = useState(false);

  // ── Comptes en période d'essai ─────────────────────────────────────────────
  //
  // Les accès déployés se lisaient uniquement en dépliant LE jeton qui les a
  // servis, campagne par campagne. Pour savoir qui est en essai en ce moment,
  // il fallait donc ouvrir chaque jeton l'un après l'autre — et comme « Forfaits
  // Data » ne montre plus rien d'un essai, ces comptes n'apparaissaient nulle
  // part d'un seul tenant.
  //
  // Cette liste les rassemble, tous jetons confondus, avec le forfait attribué,
  // le quota accordé et consommé, l'échéance et l'état. Elle reste en LECTURE :
  // la sélection est volontairement cloisonnée par jeton — aucune sélection ne
  // traverse deux campagnes — et chaque ligne renvoie donc vers son jeton pour
  // la gestion.
  const [comptesEssai, setComptesEssai] = useState<FreeTrialRequest[] | null>(null);
  const [comptesEssaiEnCours, setComptesEssaiEnCours] = useState(true);

  // ── Activité d'un essayeur ─────────────────────────────────────────────────
  // Ouvrir quelqu'un pour lire ses sessions et sa consommation. Chargé à la
  // demande : l'historique d'un seul inscrit n'a aucune raison d'être lu pour
  // dessiner la page.
  const [activiteDe, setActiviteDe] = useState<FreeTrialRequest | null>(null);
  const [activite, setActivite] = useState<FreeTrialActivity | null>(null);
  const [activiteEnCours, setActiviteEnCours] = useState(false);

  // ── Étape 1 : formulaire de création du jeton ──────────────────────────────
  const [showTokenForm, setShowTokenForm] = useState(false);
  /** Jeton en cours de modification — `null` quand aucun formulaire n'est ouvert. */
  const [jetonEdite, setJetonEdite] = useState<FreeTrialToken | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editMaxUses, setEditMaxUses] = useState('');
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenMaxUses, setTokenMaxUses] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState('');

  // ── Étape 3 : formulaire de déploiement, ouvert APRÈS sélection ────────────
  const [showDeployForm, setShowDeployForm] = useState(false);
  // PLUSIEURS configurations, pas une : le propriétaire veut attribuer
  // plusieurs serveurs à plusieurs profils d'essai d'un même geste. Chaque
  // inscrit retenu reçoit alors un forfait par configuration cochée.
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [quotaGB, setQuotaGB] = useState('2');
  const [startAt, setStartAt] = useState('');
  const [expireAt, setExpireAt] = useState('');
  const [deviceLimit, setDeviceLimit] = useState('1');
  const [deployNote, setDeployNote] = useState('');

  // ── Étape 4 : gestion des essais DÉJÀ déployés, en sélection multiple ──────
  // Chaque champ est indépendamment facultatif : ce qui reste sur « ne pas
  // toucher » n'est pas envoyé, donc pas réécrit. C'est la règle de l'action
  // groupée « apply » des forfaits, dont la mécanique serveur est réutilisée.
  const [showManageForm, setShowManageForm] = useState(false);
  const [modeServeur, setModeServeur] = useState<ModeServeur>('keep');
  const [serveurRemplacant, setServeurRemplacant] = useState('');
  const [serveursAjoutes, setServeursAjoutes] = useState<string[]>([]);
  /** Serveurs à RETIRER de l'essai — le forfait disparaît de l'appareil. */
  const [serveursRetires, setServeursRetires] = useState<string[]>([]);
  const [gestionQuotaGB, setGestionQuotaGB] = useState('');
  const [gestionQuotaMode, setGestionQuotaMode] = useState<'set' | 'add'>('set');
  const [modeEcheance, setModeEcheance] = useState<ModeEcheance>('keep');
  const [gestionExpireAt, setGestionExpireAt] = useState('');
  const [gestionDuree, setGestionDuree] = useState('');
  const [gestionDureeMode, setGestionDureeMode] = useState<'set' | 'add'>('add');
  const [gestionEtat, setGestionEtat] = useState<'' | FreeTrialState>('');
  const [gestionNote, setGestionNote] = useState('');

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
   *
   * `fond` distingue une relecture AUTOMATIQUE d'une lecture demandée. Une
   * relecture de fond ne montre pas d'indicateur de chargement — la liste
   * clignoterait toutes les minutes — et surtout ne signale pas ses échecs :
   * une coupure réseau d'une seconde afficherait « Connexion au service
   * impossible » en rouge sur un écran parfaitement lisible, et le
   * rafraîchissement suivant recommencerait. On garde alors ce qui est déjà
   * affiché, qui reste vrai, plutôt que d'alarmer sur un incident que
   * l'exploitant n'a pas provoqué et dont il n'a rien à faire.
   */
  const chargerVolet = useCallback(async (tokenId: string, page: number, fond = false) => {
    if (!fond) {
      setVolets(prev => ({ ...prev, [tokenId]: { ...(prev[tokenId] ?? VOLET_VIDE), page, loading: true } }));
    }
    try {
      const resultat = await fetchFreeTrialRequestPage({
        tokenId,
        status: statusFilter || undefined,
        limit: TAILLE_PAGE,
        offset: (page - 1) * TAILLE_PAGE,
      });
      setVolets(prev => ({
        ...prev,
        [tokenId]: { requests: resultat.requests, total: resultat.total, page, loading: false, failed: false },
      }));
    } catch (err) {
      if (fond) return; // Ce qui est affiché reste affiché.
      setVolets(prev => ({ ...prev, [tokenId]: { ...(prev[tokenId] ?? VOLET_VIDE), page, loading: false, failed: true } }));
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    }
  }, [statusFilter, errorMessage]);

  const basculerJeton = (tokenId: string) => {
    setResultatLot(null);
    setResultatGestion(null);
    setShowDeployForm(false);
    setShowManageForm(false);
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
    setSelectionGlobaleParJeton({});
    setDemandesGlobalesParJeton({});
    setResultats(null);
    if (jetonOuvert) void chargerVolet(jetonOuvert, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const chargerComptesEssai = useCallback(async (fond = false) => {
    if (!fond) setComptesEssaiEnCours(true);
    try {
      // Une seule lecture bornée, indépendante du filtre de statut : cette
      // liste répond à « qui est en essai en ce moment », question qui ne doit
      // pas changer de réponse selon le filtre choisi plus bas.
      const page = await fetchFreeTrialRequestPage({ status: FREE_TRIAL_STATUS.DEPLOYED, limit: 200 });
      setComptesEssai(page.requests);
    } catch (err) {
      // Une relecture AUTOMATIQUE qui échoue ne doit RIEN changer à l'écran.
      //
      // Vider la liste la ferait lire « aucun essai activé » — un mensonge,
      // puisque ces accès existent toujours —, et lever une bannière rouge
      // alarmerait sur une coupure d'une seconde que l'exploitant n'a pas
      // provoquée, une fois par minute.
      if (fond) return;
      setComptesEssai([]);
      setError(errorMessage(err));
    } finally {
      if (!fond) setComptesEssaiEnCours(false);
    }
  }, [errorMessage]);

  useEffect(() => { void chargerComptesEssai(); }, [chargerComptesEssai]);

  // Mise à jour AUTOMATIQUE de l'état de connexion.
  //
  // Le propriétaire veut voir le statut changer quand quelqu'un se connecte,
  // sans avoir à recharger. La fenêtre de présence est de 15 minutes et le
  // battement de 5 : une relecture par minute suffit largement à refléter un
  // changement, sans transformer cet écran en sonde.
  //
  // Le minuteur est démonté avec l'écran, et ne tourne pas pendant qu'une
  // action groupée est en cours — recharger sous les pieds de l'exploitant
  // ferait bouger la liste qu'il est en train de sélectionner.
  useEffect(() => {
    const timer = setInterval(() => {
      if (busy || showDeployForm || showManageForm) return;
      // `true` : relecture de FOND. Elle ne montre aucun indicateur de
      // chargement et ne signale aucun échec — voir `chargerComptesEssai`.
      void chargerComptesEssai(true);
      if (jetonOuvert) void chargerVolet(jetonOuvert, volet?.page ?? 1, true);
    }, RAFRAICHISSEMENT_PRESENCE_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chargerComptesEssai, jetonOuvert, busy, showDeployForm, showManageForm]);

  const ouvrirActivite = async (demande: FreeTrialRequest) => {
    setActiviteDe(demande);
    setActivite(null);
    setActiviteEnCours(true);
    try {
      setActivite(await fetchFreeTrialActivity(demande.id));
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
      setActiviteDe(null);
    } finally {
      setActiviteEnCours(false);
    }
  };

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
  // Deux gestes coexistent désormais sur la même sélection :
  //   • DÉPLOYER, qui n'a de sens que sur une demande EN ATTENTE ;
  //   • GÉRER, qui n'a de sens que sur une demande DÉJÀ DÉPLOYÉE.
  // Une demande refusée n'est ni l'un ni l'autre, donc elle n'est pas cochable.
  // Chaque geste filtre ensuite la sélection sur ce qui le concerne, plutôt que
  // d'imposer à l'exploitant de vider ses cases entre deux actions.
  const demandesDuJeton = useMemo(
    () => jetonOuvert
      ? [...(volet?.requests ?? []), ...(demandesGlobalesParJeton[jetonOuvert] ?? [])]
        .filter((demande, index, toutes) => toutes.findIndex(item => item.id === demande.id) === index)
      : [],
    [demandesGlobalesParJeton, jetonOuvert, volet],
  );
  const selectionnables = useMemo(
    () => demandesDuJeton.filter(demande =>
      demande.status === FREE_TRIAL_STATUS.PENDING || demande.status === FREE_TRIAL_STATUS.DEPLOYED),
    [demandesDuJeton],
  );
  const selectionCourante = jetonOuvert ? selectionParJeton[jetonOuvert] ?? [] : [];
  const selectionValide = useMemo(
    () => selectionCourante.filter(id => selectionnables.some(demande => demande.id === id)),
    [selectionCourante, selectionnables],
  );
  /** Sous-ensemble déployable : les demandes encore en attente. */
  const selectionEnAttente = useMemo(
    () => selectionValide.filter(id =>
      selectionnables.some(demande => demande.id === id && demande.status === FREE_TRIAL_STATUS.PENDING)),
    [selectionValide, selectionnables],
  );
  /** Sous-ensemble gérable : les essais déjà servis. */
  const selectionDeployee = useMemo(
    () => selectionValide.filter(id =>
      selectionnables.some(demande => demande.id === id && demande.status === FREE_TRIAL_STATUS.DEPLOYED)),
    [selectionValide, selectionnables],
  );
  const toutSelectionne = selectionnables.length > 0 && selectionValide.length === selectionnables.length;
  const cibleSelectionGlobale = jetonOuvert ? selectionGlobaleParJeton[jetonOuvert] ?? 0 : 0;
  const selectionGlobaleActive = cibleSelectionGlobale > 0 && selectionCourante.length === cibleSelectionGlobale;

  // ── Récapitulatif du produit « inscrits × configurations » ────────────────
  // L'interface affiche le total AVANT de confirmer : l'opérateur sait combien
  // de forfaits seront créés pour les apps sélectionnées.
  const forfaitsAcreer = (selectionEnAttente.length + selectionDeployee.length) * profileIds.length;
  const tropDeConfigs = profileIds.length > MAX_FREE_TRIAL_PROFILES;
  const deploiementBorne = tropDeConfigs;

  /** Au moins un champ renseigné : sinon la gestion ne ferait rien du tout. */
  const gestionRenseignee =
    (modeServeur === 'replace' && serveurRemplacant !== '') ||
    (modeServeur === 'add' && serveursAjoutes.length > 0) ||
    (modeServeur === 'remove' && serveursRetires.length > 0) ||
    gestionQuotaGB.trim() !== '' ||
    (modeEcheance === 'expire' && gestionExpireAt !== '') ||
    (modeEcheance === 'duration' && gestionDuree.trim() !== '') ||
    gestionEtat !== '';
  const forfaitsAjoutes = modeServeur === 'add' ? selectionDeployee.length * serveursAjoutes.length : 0;

  /**
   * Serveurs réellement attribués à la sélection, seuls candidats au retrait.
   *
   * Proposer tout le catalogue laisserait cocher un serveur que personne ne
   * détient : le geste ne ferait rien, et rien n'expliquerait pourquoi.
   */
  const serveursRetirables = useMemo(() => {
    const detenus = new Map<string, { id: string; name: string }>();
    for (const demande of volet?.requests ?? []) {
      if (!selectionDeployee.includes(demande.id)) continue;
      for (const forfait of demande.access?.subscriptions ?? []) {
        if (forfait.profileId) {
          detenus.set(forfait.profileId, {
            id: forfait.profileId,
            name: forfait.profileName ?? forfait.name,
          });
        }
      }
    }
    return [...detenus.values()];
  }, [volet, selectionDeployee]);
  const gestionBornee = serveursAjoutes.length > MAX_FREE_TRIAL_PROFILES;

  const basculerProfil = (id: string) => {
    setProfileIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
  };

  const basculerServeurAjoute = (id: string) => {
    setServeursAjoutes(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
  };

  const basculer = (id: string) => {
    if (!jetonOuvert) return;
    setSelectionGlobaleParJeton(prev => ({ ...prev, [jetonOuvert]: 0 }));
    setSelectionParJeton(prev => {
      const courante = prev[jetonOuvert] ?? [];
      return {
        ...prev,
        [jetonOuvert]: courante.includes(id) ? courante.filter(item => item !== id) : [...courante, id],
      };
    });
  };

  /**
   * Sélectionne TOUT le jeton, pas seulement la page affichée.
   *
   * La case d'en-tête ne coche que les vingt-cinq lignes visibles : c'est la
   * page. Pour changer de serveur sur deux cents inscrits, il fallait donc
   * répéter le geste page après page, et rien ne le disait.
   *
   * On parcourt ici toutes les pages du jeton courant. Les identifiants sont
   * dédupliqués avant l'envoi afin que chaque demande ne soit traitée qu'une fois.
   */
  const selectionnerTravers = async () => {
    if (!jetonOuvert || chargementTotal) return;
    if (selectionGlobaleActive) {
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      setSelectionGlobaleParJeton(prev => ({ ...prev, [jetonOuvert]: 0 }));
      setDemandesGlobalesParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      return;
    }
    setChargementTotal(true);
    try {
      const trouves: string[] = [];
      const demandes: FreeTrialRequest[] = [];
      const pages = Math.ceil((volet?.total ?? 0) / TAILLE_PAGE);
      for (let page = 1; page <= Math.max(1, pages); page++) {
        // A stalled page must not leave the bulk selector spinning forever.
        // The next refresh can retry it, while the current action fails
        // explicitly instead of looking like it is still selecting 25 rows.
        const lot = await Promise.race([
          fetchFreeTrialRequestPage({
            tokenId: jetonOuvert,
            status: statusFilter || undefined,
            limit: TAILLE_PAGE,
            offset: (page - 1) * TAILLE_PAGE,
          }),
          new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error('FREE_TRIAL_SELECTION_TIMEOUT')), 15_000);
          }),
        ]);
        for (const demande of lot.requests) {
          if ((demande.status === FREE_TRIAL_STATUS.PENDING || demande.status === FREE_TRIAL_STATUS.DEPLOYED)
            && !trouves.includes(demande.id)) {
            trouves.push(demande.id);
            demandes.push(demande);
          }
        }
        if (lot.requests.length === 0) break;
      }
      const retenus = trouves;
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: retenus }));
      setSelectionGlobaleParJeton(prev => ({ ...prev, [jetonOuvert]: retenus.length }));
      setDemandesGlobalesParJeton(prev => ({ ...prev, [jetonOuvert]: demandes }));
      // Dire ce qui a été retenu ET ce qui a été laissé : une sélection
      // silencieusement tronquée ferait croire à un déploiement complet.
      setNotice(t('operations.freeTrial.selectedAcross', {
        count: formatNumber(retenus.length),
      }));
    } catch {
      setError(errorMessage('operations.freeTrial.selectAllFailed'));
    } finally {
      setChargementTotal(false);
    }
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
    setShowManageForm(false);
    setShowDeployForm(true);
  };

  const ouvrirGestion = () => {
    setShowDeployForm(false);
    setResultatGestion(null);
    setShowManageForm(true);
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

  /** Ouvre l'édition d'un jeton, pré-remplie avec ses valeurs courantes. */
  const ouvrirEditionJeton = (jeton: FreeTrialToken) => {
    setJetonEdite(jeton);
    setEditLabel(jeton.label ?? '');
    setEditMaxUses(jeton.maxUses === null || jeton.maxUses === undefined ? '' : String(jeton.maxUses));
    setEditExpiresAt(jeton.expiresAt ? toLocalInput(new Date(jeton.expiresAt)) : '');
    setError(null);
  };

  const enregistrerJeton = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!jetonEdite) return;
    setBusy(true);
    setError(null);
    try {
      // Un champ vidé signifie « retirer », pas « ne pas changer » : c'est la
      // seule façon de lever un plafond ou de supprimer une échéance depuis un
      // formulaire. On envoie donc `null`, jamais `undefined`.
      const misAJour = await updateFreeTrialToken(jetonEdite.id, {
        label: editLabel.trim() || null,
        maxUses: editMaxUses.trim() === '' ? null : Number(editMaxUses),
        expiresAt: editExpiresAt ? new Date(editExpiresAt).toISOString() : null,
      });
      setTokens(prev => prev.map(jeton => (jeton.id === misAJour.id ? { ...jeton, ...misAJour } : jeton)));
      setJetonEdite(null);
      setNotice(t('operations.freeTrial.notice.tokenUpdated'));
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const supprimerJeton = async (jeton: FreeTrialToken) => {
    // Confirmation explicite : la suppression n'est proposée que sur un jeton
    // jamais utilisé, mais elle reste définitive.
    if (!window.confirm(t('operations.freeTrial.deleteTokenConfirm', { token: jeton.token }))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteFreeTrialToken(jeton.id);
      setTokens(prev => prev.filter(item => item.id !== jeton.id));
      if (jetonOuvert === jeton.id) setJetonOuvert(null);
      setNotice(t('operations.freeTrial.notice.tokenDeleted'));
    } catch (err) {
      // Le serveur refuse (409) si une inscription vient d'arriver : le message
      // explique alors quoi faire à la place, plutôt que d'échouer en silence.
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
      await charger();
    } finally {
      setBusy(false);
    }
  };

  const deployer = async (event: React.FormEvent) => {
    event.preventDefault();
    // ── UN SEUL GESTE POUR TOUT LE JETON ──────────────────────────────────
    //
    // Le déploiement ne concernait que les demandes EN ATTENTE. Un essai déjà
    // servi revenait « déjà déployé » — et sur un jeton mûr, où presque tout
    // est déployé, la quasi-totalité du lot ressortait en échec. L'exploitant
    // qui voulait simplement pousser un nouveau serveur à tout le monde
    // n'avait aucun chemin : il fallait déployer les uns, puis gérer les
    // autres, en deux sélections distinctes.
    //
    // Les deux gestes partent donc ensemble : déployer ce qui attend, ajouter
    // la même configuration à ce qui tourne déjà. C'est la même intention —
    // « que tout le monde ait ce serveur » — et elle s'exprime en un clic.
    if (!jetonOuvert || (selectionEnAttente.length === 0 && selectionDeployee.length === 0)) return;
    if (profileIds.length === 0) {
      setError(t('operations.freeTrial.batch.noProfile'));
      return;
    }
    if (tropDeConfigs) {
      setError(t('operations.freeTrial.batch.tooManyProfiles', { max: formatNumber(MAX_FREE_TRIAL_PROFILES) }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setResultatLot(null);
    setResultatGestion(null);
    try {
      // Les inscrits qui ATTENDENT reçoivent leur premier accès.
      const reponse = selectionEnAttente.length > 0
        ? await deployFreeTrialRequests({
          requestIds: selectionEnAttente,
          // Le jeton du contexte accompagne le lot : le serveur revérifie que
          // chaque demande en relève, plutôt que de croire la liste reçue.
          tokenId: jetonOuvert,
          profileIds,
          quotaGB: Number(quotaGB),
          startAt: startAt ? new Date(startAt).toISOString() : undefined,
          expireAt: new Date(expireAt).toISOString(),
          deviceLimit: deviceLimit.trim() ? Number(deviceLimit) : undefined,
          note: deployNote.trim() || undefined,
        })
        : null;

      // Ceux qui TOURNENT DÉJÀ reçoivent la même configuration en plus. Le
      // volume et l'échéance suivent ceux du formulaire : un serveur ajouté
      // doit courir jusqu'à la même date que les autres.
      const ajout = selectionDeployee.length > 0
        ? await manageFreeTrialRequests({
          requestIds: selectionDeployee,
          tokenId: jetonOuvert,
          profileIds,
          quotaGB: Number(quotaGB),
          startAt: startAt ? new Date(startAt).toISOString() : undefined,
          expireAt: new Date(expireAt).toISOString(),
        })
        : null;

      if (reponse) setResultatLot(reponse);
      if (ajout) setResultatGestion(ajout);
      setNotice(t('operations.freeTrial.notice.deployed', {
        deployed: formatNumber((reponse?.deployed ?? 0) + (ajout?.succeeded ?? 0)),
        total: formatNumber(selectionEnAttente.length + selectionDeployee.length),
        subscriptions: formatNumber(
          (reponse?.subscriptionsCreated ?? reponse?.deployed ?? 0) + (ajout?.created ?? 0),
        ),
      }));
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      setShowDeployForm(false);
      await Promise.all([charger(), chargerVolet(jetonOuvert, volet?.page ?? 1), chargerComptesEssai()]);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Gestion groupée des essais DÉJÀ déployés.
   *
   * Ce que l'exploitant faisait auparavant depuis « Forfaits Data » sur une
   * ligne d'essai se fait ici, sur une sélection, sans jamais quitter la
   * section Essais. Un champ laissé sur « ne pas toucher » n'est PAS envoyé :
   * le serveur ne réécrit donc que ce qui a été explicitement demandé.
   */
  const gerer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!jetonOuvert || selectionDeployee.length === 0) return;
    if (!gestionRenseignee) {
      setError(t('operations.freeTrial.manageForm.nothingToDo'));
      return;
    }
    if (gestionBornee) {
      setError(t('operations.freeTrial.batch.tooManyProfiles', { max: formatNumber(MAX_FREE_TRIAL_PROFILES) }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setResultatLot(null);
    setResultatGestion(null);
    try {
      const reponse = await manageFreeTrialRequests({
        requestIds: selectionDeployee,
        tokenId: jetonOuvert,
        profileId: modeServeur === 'replace' && serveurRemplacant ? serveurRemplacant : undefined,
        profileIds: modeServeur === 'add' && serveursAjoutes.length > 0 ? serveursAjoutes : undefined,
        removeProfileIds: modeServeur === 'remove' && serveursRetires.length > 0 ? serveursRetires : undefined,
        quotaGB: gestionQuotaGB.trim() ? Number(gestionQuotaGB) : undefined,
        quotaMode: gestionQuotaGB.trim() ? gestionQuotaMode : undefined,
        expireAt: modeEcheance === 'expire' && gestionExpireAt
          ? new Date(gestionExpireAt).toISOString()
          : undefined,
        durationDays: modeEcheance === 'duration' && gestionDuree.trim() ? Number(gestionDuree) : undefined,
        durationMode: modeEcheance === 'duration' && gestionDuree.trim() ? gestionDureeMode : undefined,
        state: gestionEtat || undefined,
        note: gestionNote.trim() || undefined,
      });
      setResultatGestion(reponse);
      setNotice(t('operations.freeTrial.notice.managed', {
        succeeded: formatNumber(reponse.succeeded),
        total: formatNumber(reponse.total),
      }));
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      setShowManageForm(false);
      await Promise.all([charger(), chargerVolet(jetonOuvert, volet?.page ?? 1), chargerComptesEssai()]);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const refuser = async () => {
    if (!jetonOuvert || selectionEnAttente.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const reponse = await rejectFreeTrialRequests({ requestIds: selectionEnAttente, tokenId: jetonOuvert });
      setNotice(t('operations.freeTrial.notice.rejected', { count: formatNumber(reponse.rejected) }));
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      await Promise.all([charger(), chargerVolet(jetonOuvert, volet?.page ?? 1)]);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Convertit les essais déployés cochés en accès ordinaires.
   *
   * Distinct de « Gérer » : gérer ajuste un essai qui RESTE un essai ;
   * convertir le fait SORTIR des essais pour entrer dans Forfaits Data. La
   * confirmation le dit dans ces termes, parce que l'exploitant verra la ligne
   * quitter cet écran et doit savoir où elle va.
   *
   * Réversible : redonner une invitation d'essai à ce compte le ramène ici,
   * sans rien avoir à défaire.
   */
  const convertir = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!jetonOuvert || selectionDeployee.length === 0) return;
    if (!window.confirm(t('operations.freeTrial.convertConfirm', {
      count: formatNumber(selectionDeployee.length),
    }))) return;
    setBusy(true);
    setError(null);
    try {
      const quota = convertQuota.trim();
      const duree = convertDuree.trim();
      const nom = convertNom.trim();
      const reponse = await convertFreeTrialRequests({
        requestIds: selectionDeployee,
        tokenId: jetonOuvert,
        // Un champ vide n'est PAS un zéro : il signifie « ne touche pas à
        // cette valeur ». L'envoyer quand même remettrait le quota à néant et
        // couperait l'accès de celui qu'on vient de promouvoir.
        ...(quota ? { quotaGB: Number(quota) } : {}),
        ...(duree ? { durationDays: Number(duree) } : {}),
        ...(nom ? { planName: nom } : {}),
      });
      setNotice(t('operations.freeTrial.notice.converted', {
        count: formatNumber(reponse.converted),
        plans: formatNumber(reponse.subscriptionsPromoted),
      }));
      setSelectionParJeton(prev => ({ ...prev, [jetonOuvert]: [] }));
      setShowConvertForm(false);
      setConvertQuota('');
      setConvertDuree('');
      setConvertNom('');
      await Promise.all([charger(), chargerVolet(jetonOuvert, volet?.page ?? 1), chargerComptesEssai()]);
    } catch (err) {
      setError(errorMessage(err, 'operations.freeTrial.genericError'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Supprime les inscrits cochés, et les forfaits nés de leur essai.
   *
   * Distinct du refus : refuser laisse la ligne en place, marquée « refusée » ;
   * supprimer l'efface. La confirmation nomme donc ce qui part, y compris le
   * nombre d'accès retirés, parce que rien ne permettra de revenir en arrière.
   *
   * S'applique à TOUTE la sélection valide — en attente comme déployée — là où
   * le refus ne vise que les demandes en attente.
   */
  const supprimerInscrits = async () => {
    if (!jetonOuvert || selectionValide.length === 0) return;
    if (!window.confirm(t('operations.freeTrial.deleteRequestsConfirm', {
      count: formatNumber(selectionValide.length),
    }))) return;
    setBusy(true);
    setError(null);
    try {
      const reponse = await deleteFreeTrialRequests({ requestIds: selectionValide, tokenId: jetonOuvert });
      setNotice(t('operations.freeTrial.notice.deletedRequests', {
        count: formatNumber(reponse.deleted),
        plans: formatNumber(reponse.subscriptionsRemoved),
      }));
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
  const ligneDemande = (demande: FreeTrialRequest, selectionnable: boolean, avecJeton = false) => {
    const cochable = demande.status === FREE_TRIAL_STATUS.PENDING || demande.status === FREE_TRIAL_STATUS.DEPLOYED;
    const acces = demande.access ?? null;
    return (
    <tr key={demande.id} className="align-top hover:bg-white/[0.02]">
      <td className="px-4 py-3">
        {selectionnable && canDeploy && cochable && (
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
        {/* Marqueur d'essai : même pastille que dans le menu, l'en-tête et la
            mention « Période d'essai » des autres écrans. Il porte son propre
            libellé, il n'est donc jamais seul porteur du sens. */}
        <TrialTag label={t('operations.freeTrial.marker')} className="mt-1" />
        {/* Jeton d'origine — affiché UNIQUEMENT dans les listes transversales.
            Sous un jeton déplié il serait redondant : l'en-tête le porte déjà.
            Dans la liste des comptes en essai, en revanche, rien ne disait de
            quelle campagne venait la personne, alors que c'est une information
            que le propriétaire attend sur la fiche d'un essayeur. */}
        {avecJeton && demande.trialToken && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-cyan-300">{demande.trialToken}</span>
            {demande.trialLabel && <span className="text-[10px] text-gray-500">{demande.trialLabel}</span>}
          </div>
        )}
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
      <td className="px-4 py-3 font-mono text-[11px] text-gray-400">
        {demande.deviceId}
        {/* Combien de fois CET appareil a déjà été servi. L'essai est
            répétable : sans ce compteur, l'exploitant ne saurait pas s'il
            regarde un premier essai ou un cinquième. Affiché seulement au-delà
            du premier, pour ne pas alourdir le cas ordinaire. */}
        {(demande.deviceTrialCount ?? 0) > 1 && (
          <span className="mt-1 inline-flex items-center rounded-md border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-amber-200">
            {t('operations.freeTrial.deviceTrialCount', { count: formatNumber(demande.deviceTrialCount ?? 0) })}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusClasses(demande.status)}`}>
          {t(STATUS_LABELS[demande.status] ?? 'operations.common.unknown')}
        </span>
        {/* ── Connexion RÉELLE ────────────────────────────────────────────
            Le tunnel est déclaré monté et le dernier battement date de moins
            que la fenêtre de présence. Un compte « actif » ne vaut jamais
            présence. Quand rien ne peut être mesuré, on l'écrit plutôt que
            d'afficher « hors ligne » pour tout le monde — ce qui affirmerait
            quelque chose de faux. */}
        {demande.status === FREE_TRIAL_STATUS.DEPLOYED && (
          <div className="mt-1.5 text-[11px]">
            {demande.presence?.measured === false ? (
              <span className="text-gray-600">{t('operations.freeTrial.presence.unmeasured')}</span>
            ) : demande.presence?.connected ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                {t('operations.freeTrial.presence.online')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-600" aria-hidden="true" />
                {t('operations.freeTrial.presence.offline')}
              </span>
            )}
            {/* Dernière activité observée — utile précisément quand la ligne
                est hors ligne : « hors ligne depuis dix minutes » et « hors
                ligne depuis trois semaines » ne se traitent pas pareil. */}
            {demande.presence?.lastSeenAt && (
              <div className="mt-0.5 text-gray-600">
                {t('operations.freeTrial.presence.lastSeen', {
                  date: formatDate(demande.presence.lastSeenAt),
                })}
              </div>
            )}
          </div>
        )}
      </td>
      {/* ── Accès courant ────────────────────────────────────────────────────
          Serveur(s) attribué(s), quota accordé ET consommé, échéance, état.
          C'est ce que l'exploitant lisait auparavant dans « Forfaits Data » :
          il le lit désormais ici, sur la ligne même de l'inscrit. */}
      <td className="px-4 py-3 text-[11px] text-gray-400">
        {!acces || acces.subscriptions.length === 0 ? (
          <span className="text-gray-600">{t('operations.freeTrial.access.none')}</span>
        ) : (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Server className="h-3 w-3 shrink-0 text-fuchsia-300" aria-hidden="true" />
              <span className="sr-only">{t('operations.freeTrial.access.servers')}</span>
              {acces.subscriptions.map(forfait => (
                <span
                  key={forfait.id}
                  className="inline-flex rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-gray-300"
                >
                  {forfait.profileName ?? t('operations.freeTrial.access.serverUnknown')}
                </span>
              ))}
            </div>
            <p className="flex items-center gap-1.5">
              <HardDrive className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
              {/* Une SEULE ligne pour le volume.
                  Consommé, accordé et restant tenaient sur deux lignes
                  séparées : c'était une ligne de plus à lire, par essayeur,
                  pour une information qui se dit d'un trait. */}
              {acces.quotaBytes === '0'
                ? t('operations.freeTrial.access.quota', {
                    used: formatBytes(acces.quotaUsed),
                    granted: t('operations.freeTrial.access.unlimited'),
                  })
                : t('operations.freeTrial.access.quotaLine', {
                    used: formatBytes(acces.quotaUsed),
                    granted: formatBytes(acces.quotaBytes),
                    remaining: formatBytes(
                      String(
                        (() => {
                          const reste = BigInt(acces.quotaBytes || '0') - BigInt(acces.quotaUsed || '0');
                          return reste > 0n ? reste : 0n;
                        })(),
                      ),
                    ),
                  })}
            </p>
            <p className="flex items-center gap-1.5">
              <CalendarClock className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
              {acces.expireAt
                ? t('operations.freeTrial.access.expiresOn', { date: formatDate(acces.expireAt) })
                : t('operations.freeTrial.access.noExpiry')}
            </p>
            <p className={acces.active ? 'text-emerald-300' : 'text-amber-300'}>
              {acces.active
                ? t('operations.freeTrial.access.active')
                : t('operations.freeTrial.access.inactive')}
            </p>
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-gray-500">
        {formatDate(demande.submittedAt)}
        {/* Ouvrir cette personne pour lire ses sessions et sa consommation.
            Chargé à la demande : l'historique d'un seul inscrit n'a aucune
            raison d'être lu pour dessiner la page. */}
        {demande.status === FREE_TRIAL_STATUS.DEPLOYED && (
          <button
            type="button"
            onClick={() => void ouvrirActivite(demande)}
            className="mt-1 block text-[11px] text-cyan-300 transition hover:text-cyan-200"
          >
            {t('operations.freeTrial.activity.open')}
          </button>
        )}
      </td>
    </tr>
    );
  };

  const enteteDemandes = (avecSelection: boolean) => (
    <thead className="text-[11px] uppercase tracking-wide text-gray-500">
      <tr>
        <th className="w-10 px-4 py-2">
          {avecSelection && canDeploy && selectionnables.length > 0 && (
            <input
              type="checkbox"
              checked={selectionGlobaleActive || toutSelectionne}
              onChange={() => void selectionnerTravers()}
              aria-label={t('operations.freeTrial.selectAll')}
              className="h-4 w-4 rounded border-white/20 bg-slate-900"
            />
          )}
        </th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.name')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.country')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.deviceId')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.status')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.access')}</th>
        <th className="px-4 py-2">{t('operations.freeTrial.columns.submittedAt')}</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-100">
            <TrialGlyph className="h-8 w-8" />
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
              <TrialGlyph className="h-5 w-5" />
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
          {/* Volume PROPRE aux essais, sur UNE ligne.
              Trois cartes pleine largeur pour trois nombres qui se lisent
              ensemble, c'était un écran de plus à parcourir pour une seule
              information : « tant consommé sur tant, tant restant ». */}
          <div className="border-t border-white/10 bg-slate-950/40 px-4 py-3">
            <p className="text-sm text-gray-200">
              {t('operations.freeTrial.metrics.trafficLine', {
                used: formatBytes(overview.trafficUsedBytes ?? '0'),
                granted: formatBytes(overview.trafficGrantedBytes ?? '0'),
                remaining: formatBytes(overview.trafficRemainingBytes ?? '0'),
              })}
              {(overview.unlimitedPlans ?? 0) > 0 && (
                <span className="ml-1.5 text-[11px] text-gray-500">
                  {t('operations.freeTrial.metrics.trafficUnlimited', {
                    count: formatNumber(overview.unlimitedPlans ?? 0),
                  })}
                </span>
              )}
            </p>
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

      {/* ── Activité d'un essayeur ─────────────────────────────────────────
          Ses sessions VPN et sa consommation, sur une fenêtre bornée. Les deux
          sources existaient déjà — rapports de santé et table de consommation —
          et ne sont pas dupliquées : rien de neuf n'est écrit pour cet écran. */}
      {activiteDe && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-white/10 bg-slate-950">
            <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-200">
                  {t('operations.freeTrial.activity.title', { name: activiteDe.name })}
                </h2>
                <p className="mt-0.5 font-mono text-[11px] text-gray-500">{activiteDe.deviceId}</p>
                {activite && (
                  <p className="mt-1 text-[11px] text-gray-500">
                    {t('operations.freeTrial.activity.window', { days: formatNumber(activite.windowDays) })}
                    {activite.truncated ? ` · ${t('operations.freeTrial.activity.truncated')}` : ''}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setActiviteDe(null); setActivite(null); }}
                aria-label={t('operations.freeTrial.cancel')}
                className="rounded-lg p-1.5 text-gray-400 transition hover:bg-white/5 hover:text-gray-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {activiteEnCours && (
              <p className="flex items-center gap-2 px-5 py-8 text-sm text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('operations.freeTrial.loading')}
              </p>
            )}

            {!activiteEnCours && activite && (
              <div className="space-y-5 px-5 py-4">
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t('operations.freeTrial.activity.sessions')}
                  </h3>
                  {/* « Non mesuré » n'est pas « aucune session » : sans secret
                      de pseudonymisation ou appareil inconnu de la table de
                      santé, rien n'a pu être lu. Le dire évite de laisser
                      croire que cette personne ne s'est jamais connectée. */}
                  {!activite.sessionsMeasured ? (
                    <p className="mt-2 text-xs text-gray-600">{t('operations.freeTrial.activity.sessionsUnmeasured')}</p>
                  ) : activite.sessions.length === 0 ? (
                    <p className="mt-2 text-xs text-gray-600">{t('operations.freeTrial.activity.sessionsEmpty')}</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {activite.sessions.map((session, index) => (
                        <li key={`${session.at}-${index}`} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px]">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-gray-300">{session.at ? formatDate(session.at) : '—'}</span>
                            <span className={session.tunnelState === 'connected' ? 'text-emerald-300' : 'text-gray-500'}>
                              {session.tunnelState ?? '—'}
                            </span>
                            {session.protocol && <span className="text-gray-500">{session.protocol}</span>}
                            {session.errorCode && <span className="text-rose-300">{session.errorCode}</span>}
                          </div>
                          <div className="mt-0.5 text-gray-500">
                            {t('operations.freeTrial.activity.sessionDetail', {
                              duration: formatNumber(Math.round(session.durationSeconds / 60)),
                              reconnects: formatNumber(session.reconnects),
                            })}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t('operations.freeTrial.activity.usage')}
                  </h3>
                  {activite.usage.length === 0 ? (
                    <p className="mt-2 text-xs text-gray-600">{t('operations.freeTrial.activity.usageEmpty')}</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {activite.usage.map((ligne, index) => (
                        <li key={`${ligne.at}-${index}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px]">
                          <span className="text-gray-300">{ligne.at ? formatDate(ligne.at) : '—'}</span>
                          <span className="text-gray-400">↓ {formatBytes(ligne.downloadBytes)}</span>
                          <span className="text-gray-400">↑ {formatBytes(ligne.uploadBytes)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modification d'un jeton ────────────────────────────────────────
          Libellé, plafond et échéance. Le CODE n'y figure pas : il est
          distribué, et le changer invaliderait en silence tous les exemplaires
          déjà remis. Un champ vidé RETIRE la contrainte — c'est la seule façon
          de lever un plafond ou une échéance depuis un formulaire. */}
      {jetonEdite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <form
            onSubmit={enregistrerJeton}
            className="w-full max-w-md space-y-4 rounded-xl border border-white/10 bg-slate-950 p-5"
          >
            <div>
              <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.editTokenTitle')}</h2>
              <p className="mt-1 font-mono text-xs text-cyan-300">{jetonEdite.token}</p>
              <p className="mt-1 text-[11px] text-gray-500">{t('operations.freeTrial.editTokenHint')}</p>
            </div>
            <label className="block text-xs text-gray-400">
              {t('operations.freeTrial.tokenForm.label')}
              <input
                value={editLabel}
                onChange={event => setEditLabel(event.target.value)}
                maxLength={160}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
            </label>
            <label className="block text-xs text-gray-400">
              {t('operations.freeTrial.tokenForm.maxUses')}
              <input
                type="number"
                min={jetonEdite.usedCount || 1}
                value={editMaxUses}
                onChange={event => setEditMaxUses(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
              <span className="mt-1 block text-[11px] text-gray-600">{t('operations.freeTrial.editMaxUsesHint')}</span>
            </label>
            <label className="block text-xs text-gray-400">
              {t('operations.freeTrial.tokenForm.expiresAt')}
              <input
                type="datetime-local"
                value={editExpiresAt}
                onChange={event => setEditExpiresAt(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
              />
              <span className="mt-1 block text-[11px] text-gray-600">{t('operations.freeTrial.editExpiresAtHint')}</span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setJetonEdite(null)}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition hover:bg-white/5"
              >
                {t('operations.freeTrial.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {t('operations.freeTrial.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Comptes en période d'essai ────────────────────────────────────────
          Les accès activés, tous jetons confondus. Ils ne se lisaient
          qu'en dépliant le jeton qui les avait servis, campagne par campagne :
          savoir qui est en essai en ce moment demandait d'ouvrir chaque jeton
          l'un après l'autre. Et comme « Forfaits Data » ne montre plus rien
          d'un essai, ces comptes n'apparaissaient nulle part d'un seul tenant. */}
      <section className="overflow-hidden rounded-xl border border-fuchsia-400/20 bg-fuchsia-500/[0.03]">
        {/* Repliée par défaut. Sur un téléphone, une liste de plusieurs dizaines
            de comptes obligeait à faire défiler tout l'écran avant d'atteindre
            quoi que ce soit d'autre. L'en-tête reste un résumé ; on déplie quand
            on veut les noms. */}
        <button
          type="button"
          onClick={() => setComptesDeplies(ouvert => !ouvert)}
          aria-expanded={comptesDeplies}
          className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
        >
          <div className="flex items-start gap-2.5">
            <TrialGlyph className="mt-0.5 h-6 w-6 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.activeAccounts.title')}</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">{t('operations.freeTrial.activeAccounts.hint')}</p>
            </div>
          </div>
          <span className="flex items-center gap-2 text-[11px] text-gray-500">
            {t('operations.freeTrial.activeAccounts.count', { count: formatNumber(comptesEssai?.length ?? 0) })}
            <ChevronDown className={`h-4 w-4 transition-transform ${comptesDeplies ? 'rotate-180' : ''}`} />
          </span>
        </button>

        {comptesDeplies && comptesEssaiEnCours && (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('operations.freeTrial.loading')}
          </p>
        )}
        {comptesDeplies && !comptesEssaiEnCours && (comptesEssai?.length ?? 0) === 0 && (
          <p className="px-4 py-8 text-center text-sm text-gray-500">
            {t('operations.freeTrial.activeAccounts.empty')}
          </p>
        )}
        {comptesDeplies && !comptesEssaiEnCours && (comptesEssai?.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              {enteteDemandes(false)}
              <tbody className="divide-y divide-white/5">
                {(comptesEssai ?? []).map(demande => ligneDemande(demande, false, true))}
              </tbody>
            </table>
            <p className="px-4 py-3 text-[11px] text-gray-500">
              {t('operations.freeTrial.activeAccounts.manageHint')}
            </p>
          </div>
        )}
      </section>

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
              {/* « Tous » en tête : c'est le choix par défaut, et l'ordre du
                  menu doit le refléter plutôt que de le reléguer en bas. */}
              <option value="">{t('operations.freeTrial.status.all')}</option>
              <option value={FREE_TRIAL_STATUS.PENDING}>{t('operations.freeTrial.status.pending')}</option>
              <option value={FREE_TRIAL_STATUS.DEPLOYED}>{t('operations.freeTrial.status.deployed')}</option>
              <option value={FREE_TRIAL_STATUS.REJECTED}>{t('operations.freeTrial.status.rejected')}</option>
              <option value={FREE_TRIAL_STATUS.CONVERTED}>{t('operations.freeTrial.status.converted')}</option>
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
                  {/* Utilisé ou non : la réponse tient sur la ligne, sans avoir
                      à déplier le volet pour la deviner. */}
                  <span className={`text-[11px] ${(jeton.requestCount ?? 0) > 0 ? 'text-gray-400' : 'text-gray-600'}`}>
                    {(jeton.requestCount ?? 0) > 0
                      ? t('operations.freeTrial.tokenUsed')
                      : t('operations.freeTrial.tokenUnused')}
                  </span>
                  {canRevokeToken && (
                    <button
                      type="button"
                      onClick={() => ouvrirEditionJeton(jeton)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1 text-xs text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t('operations.freeTrial.editToken')}
                    </button>
                  )}
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
                  {/* Suppression proposée UNIQUEMENT sur un jeton jamais
                      utilisé. Le serveur refuse les autres (409) parce que la
                      relation cascade : supprimer un jeton qui a servi
                      effacerait l'historique des personnes inscrites. */}
                  {canRevokeToken && (jeton.requestCount ?? 0) === 0 && (
                    <button
                      type="button"
                      onClick={() => void supprimerJeton(jeton)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/25 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('operations.freeTrial.deleteToken')}
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

                    {/* Échec de lecture ≠ absence de demandes. Le second cas
                        se rendait comme le premier : le volet annonçait
                        « Aucune demande pour ce filtre » alors que la ligne du
                        jeton, juste au-dessus, affichait « 1 déployée(s) ».
                        L'écran se contredisait, et on pouvait en conclure que
                        la campagne avait disparu. */}
                    {!contenu?.loading && contenu?.failed && (
                      <div className="px-4 py-8 text-center">
                        <p className="text-sm text-amber-300">{t('operations.freeTrial.loadFailed')}</p>
                        <button
                          type="button"
                          onClick={() => void chargerVolet(jeton.id, contenu?.page ?? 1)}
                          className="mt-2 text-xs text-cyan-300 transition hover:text-cyan-200"
                        >
                          {t('operations.freeTrial.retry')}
                        </button>
                      </div>
                    )}

                    {!contenu?.loading && !contenu?.failed && (contenu?.requests.length ?? 0) === 0 && (
                      <p className="px-4 py-8 text-center text-sm text-gray-500">{t('operations.freeTrial.empty')}</p>
                    )}

                    {!contenu?.loading && !contenu?.failed && (contenu?.requests.length ?? 0) > 0 && (
                      <>
                        {canDeploy && selectionValide.length > 0 && (
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-cyan-500/[0.06] px-4 py-3">
                            <div>
                              <span className="text-sm text-cyan-200">
                                {t('operations.freeTrial.selectedSplit', {
                                  count: formatNumber(selectionValide.length),
                                  pending: formatNumber(selectionEnAttente.length),
                                  deployed: formatNumber(selectionDeployee.length),
                                })}
                              </span>
                              {/* Même avertissement que la suppression groupée :
                                  « tout sélectionner » ne couvre que ce qui est
                                  affiché, jamais les pages non chargées. */}
                              <p className="mt-0.5 text-[11px] text-gray-400">
                                {t('operations.freeTrial.batch.loadedOnly')}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {/* La case d'en-tête ne coche que la page. Ce
                                  bouton couvre le jeton entier : sans lui, il
                                  fallait répéter le geste page après page pour
                                  changer de serveur sur tout un parc. */}
                              <button
                                type="button"
                                onClick={() => void selectionnerTravers()}
                                disabled={busy || chargementTotal || (volet?.total ?? 0) <= selectionnables.length}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-200 transition hover:bg-white/5 disabled:opacity-50"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                {chargementTotal
                                  ? t('operations.freeTrial.selectingAcross')
                                  : t('operations.freeTrial.selectAcross', {
                                      count: formatNumber(volet?.total ?? 0),
                                    })}
                              </button>
                              <button
                                type="button"
                                onClick={refuser}
                                disabled={busy || selectionEnAttente.length === 0}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/25 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
                              >
                                <Ban className="h-3.5 w-3.5" />
                                {t('operations.freeTrial.reject')}
                              </button>
                              <button
                                type="button"
                                onClick={ouvrirDeploiement}
                                disabled={busy || (selectionEnAttente.length === 0 && selectionDeployee.length === 0)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                              >
                                <Rocket className="h-3.5 w-3.5" />
                                {t('operations.freeTrial.configureAndDeploy')}
                              </button>
                              {/* Gestion des essais DÉJÀ déployés. Ce bouton
                                  remplace tout ce que l'exploitant faisait
                                  auparavant depuis « Forfaits Data » avec
                                  l'interrupteur d'inclusion : serveur, quota,
                                  échéance, suspension, révocation. */}
                              <button
                                type="button"
                                onClick={ouvrirGestion}
                                disabled={busy || selectionDeployee.length === 0}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-fuchsia-400 disabled:opacity-50"
                              >
                                <SlidersHorizontal className="h-3.5 w-3.5" />
                                {t('operations.freeTrial.manage')}
                              </button>
                              {/* CONVERTIR — le geste qui fait SORTIR l'essai.
                                  Distinct de « Gérer », qui ajuste un essai
                                  restant un essai : ici la ligne quitte cet
                                  écran et son forfait entre dans Forfaits Data.
                                  Placé après « Gérer » parce qu'il vient plus
                                  tard dans la vie d'un essai, et avant le
                                  filet parce qu'il est réversible. */}
                              <button
                                type="button"
                                onClick={() => setShowConvertForm(v => !v)}
                                disabled={busy || selectionDeployee.length === 0}
                                title={t('operations.freeTrial.convertHint')}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-violet-400 disabled:opacity-50"
                              >
                                <ArrowUpRight className="h-3.5 w-3.5" />
                                {t('operations.freeTrial.convert')}
                              </button>
                              {/* SUPPRIMER — distinct de « Refuser ».
                                  Refuser laisse la ligne, marquée refusée ;
                                  supprimer efface l'inscrit ET les forfaits nés
                                  de son essai, donc l'accès part de l'appareil
                                  dans la seconde. Séparé des autres par un
                                  filet : c'est le seul geste irréversible de
                                  cette barre. */}
                              <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
                              <button
                                type="button"
                                onClick={supprimerInscrits}
                                disabled={busy || selectionValide.length === 0}
                                title={t('operations.freeTrial.deleteRequestsHint')}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                {t('operations.freeTrial.deleteRequests')}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Formulaire de conversion : trois champs FACULTATIFS.
                            Les laisser vides convertit sans rien changer à
                            l'accès — le cas le plus courant. Les remplir
                            distingue un « VIP » d'un « normal ». */}
                        {showConvertForm && canDeploy && selectionDeployee.length > 0 && (
                          <form onSubmit={convertir} className="space-y-4 border-b border-white/10 bg-violet-500/[0.04] px-4 py-5">
                            <div>
                              <h3 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.convertForm.title')}</h3>
                              <p className="mt-1 text-xs text-gray-500">
                                {t('operations.freeTrial.convertForm.hint', { count: formatNumber(selectionDeployee.length) })}
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                              <label className="block">
                                <span className="text-xs text-gray-400">{t('operations.freeTrial.convertForm.plan')}</span>
                                <input
                                  type="text"
                                  value={convertNom}
                                  onChange={e => setConvertNom(e.target.value)}
                                  placeholder={t('operations.freeTrial.convertForm.planPlaceholder')}
                                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-violet-500/50"
                                />
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-400">{t('operations.freeTrial.convertForm.quota')}</span>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={convertQuota}
                                  onChange={e => setConvertQuota(e.target.value)}
                                  placeholder={t('operations.freeTrial.convertForm.unchanged')}
                                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-violet-500/50"
                                />
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-400">{t('operations.freeTrial.convertForm.duration')}</span>
                                <input
                                  type="number"
                                  min={1}
                                  value={convertDuree}
                                  onChange={e => setConvertDuree(e.target.value)}
                                  placeholder={t('operations.freeTrial.convertForm.unchanged')}
                                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-violet-500/50"
                                />
                              </label>
                            </div>
                            <p className="text-xs text-gray-500">{t('operations.freeTrial.convertForm.reversible')}</p>
                            <div className="flex items-center gap-2">
                              <button
                                type="submit"
                                disabled={busy}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500/90 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-violet-400 disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                                {t('operations.freeTrial.convertForm.submit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowConvertForm(false)}
                                className="rounded-lg border border-white/15 px-4 py-2 text-xs text-gray-300 transition hover:bg-white/5"
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          </form>
                        )}

                        {/* Le formulaire n'apparaît qu'APRÈS sélection : c'est
                            l'ordre imposé par la spécification — d'abord qui,
                            ensuite quoi. Tous les champs sont visibles en même
                            temps, comme pour les forfaits groupés. */}
                        {showDeployForm && canDeploy && selectionEnAttente.length > 0 && (
                          <form onSubmit={deployer} className="space-y-4 border-b border-white/10 bg-slate-900/40 px-4 py-5">
                            <div>
                              <h3 className="text-sm font-semibold text-gray-200">{t('operations.freeTrial.deployForm.title')}</h3>
                              <p className="mt-1 text-xs text-gray-500">
                                {t('operations.freeTrial.deployForm.hint', { count: formatNumber(selectionEnAttente.length) })}
                              </p>
                            </div>
                            {/* ── Configurations VPN : sélection MULTIPLE ────────
                                Chaque inscrit retenu reçoit un forfait PAR
                                configuration cochée, exactement comme un client
                                principal peut détenir plusieurs forfaits. */}
                            <fieldset className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-3">
                              <legend className="px-1 text-xs text-gray-300">
                                {t('operations.freeTrial.deployForm.servers')}
                              </legend>
                              <p className="mb-2 text-[11px] text-gray-500">
                                {t('operations.freeTrial.deployForm.serversHint', {
                                  maxProfiles: formatNumber(MAX_FREE_TRIAL_PROFILES),
                                })}
                              </p>
                              <div className="grid max-h-44 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                                {profiles.map(profil => (
                                  <label
                                    key={profil.id}
                                    className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1.5 text-xs text-gray-200"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={profileIds.includes(profil.id)}
                                      onChange={() => basculerProfil(profil.id)}
                                      className="h-3.5 w-3.5 rounded border-white/20 bg-slate-900"
                                    />
                                    <span className="truncate">{profil.name}</span>
                                  </label>
                                ))}
                              </div>
                              {profiles.length === 0 && (
                                <p className="text-[11px] text-gray-500">{t('operations.freeTrial.deployForm.noServer')}</p>
                              )}
                            </fieldset>
                            <div className="grid gap-4 md:grid-cols-3">
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
                              <label className="block text-xs text-gray-400 md:col-span-2">
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
                                quoi, sous quel jeton, COMBIEN de forfaits, et
                                rien d'implicite. */}
                            <p className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-[11px] text-gray-400">
                              {t('operations.freeTrial.batch.recap', {
                                count: formatNumber(selectionEnAttente.length),
                                token: jeton.token,
                              })}
                              {' '}
                              {t('operations.freeTrial.batch.preview', {
                                requests: formatNumber(selectionEnAttente.length),
                                profiles: formatNumber(profileIds.length),
                                subscriptions: formatNumber(forfaitsAcreer),
                              })}
                            </p>
                            {tropDeConfigs && (
                              <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                                {t('operations.freeTrial.batch.tooManyProfiles', { max: formatNumber(MAX_FREE_TRIAL_PROFILES) })}
                              </p>
                            )}
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
                                disabled={busy || profileIds.length === 0 || !expireAt || deploiementBorne}
                                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                                {t('operations.freeTrial.batch.deployTo', { count: formatNumber(selectionEnAttente.length) })}
                              </button>
                            </div>
                          </form>
                        )}

                        {/* ── Gestion des essais DÉJÀ déployés ─────────────────
                            Attribuer un serveur, corriger un quota, prolonger,
                            suspendre ou révoquer un essai se fait ICI et nulle
                            part ailleurs : « Forfaits Data » ne porte plus
                            aucune option d'essai. Sur une sélection multiple,
                            chaque champ est INDÉPENDAMMENT facultatif et seul
                            ce qui est renseigné est appliqué. */}
                        {showManageForm && canDeploy && selectionDeployee.length > 0 && (
                          <form onSubmit={gerer} className="space-y-4 border-b border-white/10 bg-fuchsia-500/[0.04] px-4 py-5">
                            <div>
                              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-200">
                                <TrialGlyph className="h-5 w-5" />
                                {t('operations.freeTrial.manageForm.title')}
                              </h3>
                              <p className="mt-1 text-xs text-gray-500">
                                {t('operations.freeTrial.manageForm.hint', { count: formatNumber(selectionDeployee.length) })}
                              </p>
                            </div>

                            {/* Serveur : conserver, remplacer, ou ajouter. */}
                            <fieldset className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-3">
                              <legend className="flex items-center gap-1.5 px-1 text-xs text-gray-300">
                                <Server className="h-3.5 w-3.5 text-fuchsia-300" aria-hidden="true" />
                                {t('operations.freeTrial.manageForm.serverSection')}
                              </legend>
                              <label className="block text-xs text-gray-400">
                                {t('operations.freeTrial.manageForm.serverMode')}
                                <select
                                  value={modeServeur}
                                  onChange={event => setModeServeur(event.target.value as ModeServeur)}
                                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                >
                                  <option value="keep">{t('operations.freeTrial.manageForm.serverKeep')}</option>
                                  <option value="replace">{t('operations.freeTrial.manageForm.serverReplace')}</option>
                                  <option value="add">{t('operations.freeTrial.manageForm.serverAdd')}</option>
                                  <option value="remove">{t('operations.freeTrial.manageForm.serverRemove')}</option>
                                </select>
                              </label>
                              {modeServeur === 'replace' && (
                                <label className="mt-2 block text-xs text-gray-400">
                                  {t('operations.freeTrial.manageForm.replacement')}
                                  <select
                                    value={serveurRemplacant}
                                    onChange={event => setServeurRemplacant(event.target.value)}
                                    className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                  >
                                    <option value="">{t('operations.freeTrial.deployForm.serverPlaceholder')}</option>
                                    {profiles.map(profil => (
                                      <option key={profil.id} value={profil.id}>{profil.name}</option>
                                    ))}
                                  </select>
                                </label>
                              )}
                              {modeServeur === 'add' && (
                                <div className="mt-2 grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                                  {profiles.map(profil => (
                                    <label
                                      key={profil.id}
                                      className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1.5 text-xs text-gray-200"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={serveursAjoutes.includes(profil.id)}
                                        onChange={() => basculerServeurAjoute(profil.id)}
                                        className="h-3.5 w-3.5 rounded border-white/20 bg-slate-900"
                                      />
                                      <span className="truncate">{profil.name}</span>
                                    </label>
                                  ))}
                                </div>
                              )}
                              {/* Retrait : on ne propose QUE les serveurs
                                  réellement attribués à la sélection. Offrir
                                  tout le catalogue laisserait cocher un serveur
                                  que personne n'a, et le geste ne ferait rien
                                  sans qu'on comprenne pourquoi. */}
                              {modeServeur === 'remove' && (
                                serveursRetirables.length === 0 ? (
                                  <p className="mt-2 text-[11px] text-gray-500">
                                    {t('operations.freeTrial.manageForm.removeNone')}
                                  </p>
                                ) : (
                                  <>
                                    <div className="mt-2 grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                                      {serveursRetirables.map(profil => (
                                        <label
                                          key={profil.id}
                                          className="flex items-center gap-2 rounded-md border border-rose-500/20 bg-rose-500/[0.04] px-2 py-1.5 text-xs text-gray-200"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={serveursRetires.includes(profil.id)}
                                            onChange={() => setServeursRetires(prev => prev.includes(profil.id)
                                              ? prev.filter(x => x !== profil.id)
                                              : [...prev, profil.id])}
                                            className="h-3.5 w-3.5 rounded border-white/20 bg-slate-900"
                                          />
                                          <span className="truncate">{profil.name}</span>
                                        </label>
                                      ))}
                                    </div>
                                    <p className="mt-1.5 text-[11px] text-amber-300/90">
                                      {t('operations.freeTrial.manageForm.removeHint')}
                                    </p>
                                  </>
                                )
                              )}
                            </fieldset>

                            <div className="grid gap-4 md:grid-cols-2">
                              {/* Quota : remplacer la valeur ou l'augmenter. */}
                              <fieldset className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-3">
                                <legend className="flex items-center gap-1.5 px-1 text-xs text-gray-300">
                                  <HardDrive className="h-3.5 w-3.5 text-fuchsia-300" aria-hidden="true" />
                                  {t('operations.freeTrial.manageForm.quotaSection')}
                                </legend>
                                <label className="block text-xs text-gray-400">
                                  {t('operations.freeTrial.manageForm.quotaMode')}
                                  <select
                                    value={gestionQuotaMode}
                                    onChange={event => setGestionQuotaMode(event.target.value as 'set' | 'add')}
                                    className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                  >
                                    <option value="set">{t('operations.freeTrial.manageForm.quotaSet')}</option>
                                    <option value="add">{t('operations.freeTrial.manageForm.quotaAdd')}</option>
                                  </select>
                                </label>
                                <label className="mt-2 block text-xs text-gray-400">
                                  {t('operations.freeTrial.manageForm.quotaValue')}
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.1}
                                    value={gestionQuotaGB}
                                    onChange={event => setGestionQuotaGB(event.target.value)}
                                    placeholder={t('operations.freeTrial.manageForm.leaveEmpty')}
                                    className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                  />
                                </label>
                              </fieldset>

                              {/* Échéance : prolonger, raccourcir, ou fixer. */}
                              <fieldset className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-3">
                                <legend className="flex items-center gap-1.5 px-1 text-xs text-gray-300">
                                  <CalendarClock className="h-3.5 w-3.5 text-fuchsia-300" aria-hidden="true" />
                                  {t('operations.freeTrial.manageForm.expirySection')}
                                </legend>
                                <label className="block text-xs text-gray-400">
                                  {t('operations.freeTrial.manageForm.expiryMode')}
                                  <select
                                    value={modeEcheance}
                                    onChange={event => setModeEcheance(event.target.value as ModeEcheance)}
                                    className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                  >
                                    <option value="keep">{t('operations.freeTrial.manageForm.expiryKeep')}</option>
                                    <option value="expire">{t('operations.freeTrial.manageForm.expiryDate')}</option>
                                    <option value="duration">{t('operations.freeTrial.manageForm.expiryDuration')}</option>
                                  </select>
                                </label>
                                {modeEcheance === 'expire' && (
                                  <label className="mt-2 block text-xs text-gray-400">
                                    {t('operations.freeTrial.deployForm.expireAt')}
                                    <input
                                      type="datetime-local"
                                      value={gestionExpireAt}
                                      onChange={event => setGestionExpireAt(event.target.value)}
                                      className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                    />
                                  </label>
                                )}
                                {modeEcheance === 'duration' && (
                                  <>
                                    <label className="mt-2 block text-xs text-gray-400">
                                      {t('operations.freeTrial.manageForm.durationMode')}
                                      <select
                                        value={gestionDureeMode}
                                        onChange={event => setGestionDureeMode(event.target.value as 'set' | 'add')}
                                        className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                      >
                                        <option value="add">{t('operations.freeTrial.manageForm.durationAdd')}</option>
                                        <option value="set">{t('operations.freeTrial.manageForm.durationSet')}</option>
                                      </select>
                                    </label>
                                    <label className="mt-2 block text-xs text-gray-400">
                                      {t('operations.freeTrial.manageForm.durationDays')}
                                      <input
                                        type="number"
                                        step={1}
                                        value={gestionDuree}
                                        onChange={event => setGestionDuree(event.target.value)}
                                        placeholder={t('operations.freeTrial.manageForm.leaveEmpty')}
                                        className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                      />
                                    </label>
                                  </>
                                )}
                              </fieldset>
                            </div>

                            {/* État : suspendre, réactiver, révoquer. */}
                            <div className="grid gap-4 md:grid-cols-2">
                              <label className="block text-xs text-gray-400">
                                {t('operations.freeTrial.manageForm.state')}
                                <select
                                  value={gestionEtat}
                                  onChange={event => setGestionEtat(event.target.value as FreeTrialState | '')}
                                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                >
                                  <option value="">{t('operations.freeTrial.manageForm.stateKeep')}</option>
                                  <option value={FREE_TRIAL_STATE.SUSPEND}>{t('operations.freeTrial.manageForm.stateSuspend')}</option>
                                  <option value={FREE_TRIAL_STATE.RESUME}>{t('operations.freeTrial.manageForm.stateResume')}</option>
                                  <option value={FREE_TRIAL_STATE.REVOKE}>{t('operations.freeTrial.manageForm.stateRevoke')}</option>
                                </select>
                              </label>
                              <label className="block text-xs text-gray-400">
                                {t('operations.freeTrial.deployForm.note')}
                                <input
                                  value={gestionNote}
                                  onChange={event => setGestionNote(event.target.value)}
                                  maxLength={280}
                                  className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-gray-100 outline-none focus:border-cyan-500/50"
                                />
                              </label>
                            </div>

                            <p className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-[11px] text-gray-400">
                              {gestionRenseignee
                                ? t('operations.freeTrial.manageForm.recap', {
                                    count: formatNumber(selectionDeployee.length),
                                    token: jeton.token,
                                  })
                                : t('operations.freeTrial.manageForm.nothingToDo')}
                              {modeServeur === 'add' && serveursAjoutes.length > 0 && (
                                <>
                                  {' '}
                                  {t('operations.freeTrial.manageForm.addPreview', {
                                    requests: formatNumber(selectionDeployee.length),
                                    profiles: formatNumber(serveursAjoutes.length),
                                    subscriptions: formatNumber(forfaitsAjoutes),
                                  })}
                                </>
                              )}
                            </p>
                            {gestionBornee && (
                              <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                                {t('operations.freeTrial.batch.tooManyProfiles', { max: formatNumber(MAX_FREE_TRIAL_PROFILES) })}
                              </p>
                            )}
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setShowManageForm(false)}
                                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition hover:bg-white/5"
                              >
                                {t('operations.freeTrial.cancel')}
                              </button>
                              <button
                                type="submit"
                                disabled={busy || !gestionRenseignee || gestionBornee}
                                className="inline-flex items-center gap-2 rounded-lg bg-fuchsia-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-fuchsia-400 disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
                                {t('operations.freeTrial.manageForm.submit', { count: formatNumber(selectionDeployee.length) })}
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

                        {/* Même rapport, même exigence, pour la gestion. */}
                        {resultatGestion && (
                          <div className="border-b border-white/10 bg-slate-900/40 px-4 py-3 text-xs text-gray-300">
                            <p className="font-semibold text-gray-200">{t('operations.freeTrial.manageResult.done')}</p>
                            <p className="mt-1">
                              {t('operations.freeTrial.manageResult.summary', {
                                selected: formatNumber(resultatGestion.total),
                                succeeded: formatNumber(resultatGestion.succeeded),
                                updated: formatNumber(resultatGestion.updated),
                                created: formatNumber(resultatGestion.created),
                                failed: formatNumber(resultatGestion.results.filter(item => item.status === 'failed').length),
                              })}
                            </p>
                            {/* `ok` = tout ce qui était demandé a abouti : rien à
                                signaler. Tout le reste — partiel, ignoré, échoué —
                                mérite sa ligne et son motif. */}
                            {resultatGestion.results.filter(item => item.status !== 'ok').map(item => (
                              <p key={item.id} className="mt-0.5 text-rose-300/90">
                                {t('operations.freeTrial.batch.failedItem', {
                                  id: item.id,
                                  // Le MOTIF prime sur le statut. Afficher « Failed »
                                  // seul laissait l'exploitant sans rien à corriger :
                                  // le serveur dit pourquoi, il faut le montrer.
                                  // Un motif est tantôt une clé i18n, tantôt le
                                  // message brut du moteur ; `t()` rend la clé si
                                  // elle existe et la chaîne telle quelle sinon.
                                  reason: item.reason
                                    ? t(item.reason, { defaultValue: item.reason })
                                    : t(MANAGE_RESULT_LABELS[item.status] ?? 'operations.freeTrial.manageResult.failed'),
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
                  {(resultats ?? []).map(demande => ligneDemande(demande, false, true))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
