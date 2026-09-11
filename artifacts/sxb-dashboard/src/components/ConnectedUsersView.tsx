import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock3,
  Info,
  RefreshCw,
  Smartphone,
  Store,
  Wifi,
} from 'lucide-react';
import {
  fetchConnectedUsers,
  fetchResellerPresence,
  type ConnectedUser,
  type ConnectedUsersPage,
  type ResellerPresence,
  type ResellerPresenceGroup,
} from '../api/presence';
import { useTranslation } from '../contexts/I18nContext';
import { UserRole } from '../types';

/**
 * Suivi des connectés — qui utilise RÉELLEMENT le VPN en ce moment.
 *
 * Remplace la carte « CONNECTÉS » qui affichait le nombre de COMPTES ACTIFS.
 *
 * Cette vue n'affirme que ce que la plateforme a mesuré : le dernier signal
 * reçu d'un appareil déclarait le tunnel monté, et il est récent. Elle
 * n'annonce jamais qu'un appareil est « déconnecté » — un silence peut venir
 * d'un réseau coupé, d'une batterie vide ou d'une application fermée par le
 * système. Elle dit donc « dernière activité il y a X », et rien de plus.
 *
 * Elle n'expose aucune donnée de navigation : la plateforme n'observe ni le
 * trafic, ni les destinations, ni le contenu de ce que fait l'utilisateur.
 */

/** Cadence du rafraîchissement automatique, suspendu onglet masqué. */
const POLL_INTERVAL_MS = 30_000;

function stateDotClasses(secondsAgo: number, windowMinutes: number): string {
  // Vert tant que le signal est frais ; ambre quand il approche du bord de la
  // fenêtre, car la présence est alors sur le point de ne plus être affirmable.
  return secondsAgo <= (windowMinutes * 60) / 3
    ? 'bg-emerald-400 shadow-sm shadow-emerald-400'
    : 'bg-amber-400 shadow-sm shadow-amber-400';
}

function UserRow({ user, windowMinutes }: { user: ConnectedUser; windowMinutes: number }) {
  const { t, formatNumber, formatDate } = useTranslation();

  const sinceLabel = (): string => {
    if (!user.connectedSinceMeasured || !user.connectedSinceAt) return t('operations.presence.notMeasured');
    const seconds = Math.max(0, Math.round((Date.parse(user.lastSeenAt) - Date.parse(user.connectedSinceAt)) / 1000));
    return formatElapsed(seconds);
  };

  const formatElapsed = (seconds: number): string => {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    if (hours > 0) {
      return t('operations.presence.durationHours', {
        hours: formatNumber(hours),
        minutes: formatNumber(minutes, { minimumIntegerDigits: 2 }),
      });
    }
    if (minutes > 0) return t('operations.presence.durationMinutes', { count: formatNumber(minutes) });
    return t('operations.presence.durationSeconds', { count: formatNumber(Math.floor(safe)) });
  };

  return (
    <tr className="align-top transition-colors hover:bg-white/[0.02]">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${stateDotClasses(user.lastSeenSecondsAgo, windowMinutes)}`} />
          <span className="font-semibold text-white">{user.clientName || t('operations.presence.unnamedClient')}</span>
        </div>
        <div className="mt-1 font-mono text-[11px] text-gray-500">{user.deviceId}</div>
      </td>
      <td className="px-4 py-3">
        {user.directClient ? (
          <span className="inline-flex rounded-md border border-slate-500/25 bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
            {t('operations.presence.directClient')}</span>
        ) : (
          <span className="inline-flex rounded-md border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
            {user.resellerName || t('operations.presence.unnamedReseller')}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-300">
        <div>{user.protocol || t('operations.presence.noProtocol')}</div>
        <div className="mt-1 text-[11px] text-gray-500">{user.deviceModel || t('operations.presence.noModel')}</div>
      </td>
      <td className="px-4 py-3 text-gray-300">
        <div>{sinceLabel()}</div>
        <div className="mt-1 text-[11px] text-gray-500">{t('operations.presence.appVersion', { version: user.appVersion })}</div>
      </td>
      <td className="px-4 py-3">
        <div className="text-gray-300">{t('operations.presence.lastSeenAgo', { duration: formatElapsed(user.lastSeenSecondsAgo) })}</div>
        <div className="mt-1 whitespace-nowrap text-[11px] text-gray-500">
          {formatDate(user.lastSeenAt, { dateStyle: 'short', timeStyle: 'short' })}
        </div>
      </td>
    </tr>
  );
}

function UsersTable({ users, windowMinutes }: { users: ConnectedUser[]; windowMinutes: number }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-xs">
        <thead className="bg-[#0d1422] text-[10px] uppercase tracking-wider text-gray-500">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">{t('operations.presence.columnClient')}</th>
            <th scope="col" className="px-4 py-3 font-semibold">{t('operations.presence.columnOwner')}</th>
            <th scope="col" className="px-4 py-3 font-semibold">{t('operations.presence.columnProtocol')}</th>
            <th scope="col" className="px-4 py-3 font-semibold">{t('operations.presence.columnSince')}</th>
            <th scope="col" className="px-4 py-3 font-semibold">{t('operations.presence.columnLastSeen')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#1a1f2e]">
          {users.map((user) => (
            <UserRow key={`${user.clientId}-${user.deviceId}`} user={user} windowMinutes={windowMinutes} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResellerGroup({
  group,
  windowMinutes,
  expanded,
  onToggle,
}: {
  group: ResellerPresenceGroup;
  windowMinutes: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, formatNumber } = useTranslation();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="overflow-hidden rounded-2xl border border-[#1a1f2e] bg-[#0f1218]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Chevron className="h-4 w-4 shrink-0 text-gray-500" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">
              {group.directClients
                ? t('operations.presence.directClients')
                : group.resellerName || t('operations.presence.unnamedReseller')}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-500">
              {group.directClients
                ? t('operations.presence.directClientsHint')
                : t('operations.presence.resellerFleet', {
                  active: formatNumber(group.activeClients),
                  total: formatNumber(group.totalClients),
                })}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-xl font-bold ${group.connectedNow > 0 ? 'text-emerald-300' : 'text-gray-600'}`}>
            {formatNumber(group.connectedNow)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-gray-600">{t('operations.presence.connectedNow')}</div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-[#1a1f2e]">
          {group.users.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-500">{t('operations.presence.noneConnectedHere')}</p>
          ) : (
            <UsersTable users={group.users} windowMinutes={windowMinutes} />
          )}
        </div>
      )}
    </div>
  );
}

interface ConnectedUsersViewProps {
  currentUserRole?: UserRole | string;
}

export default function ConnectedUsersView({ currentUserRole }: ConnectedUsersViewProps) {
  const { t, formatNumber, formatDate, errorMessage } = useTranslation();
  // Un revendeur ne voit jamais les autres revendeurs ni leurs chiffres : le
  // serveur lui refuse la vue globale, l'interface ne la lui propose pas.
  const isReseller = currentUserRole === UserRole.RESELLER;

  const [tab, setTab] = useState<'users' | 'resellers'>('users');
  const [page, setPage] = useState<ConnectedUsersPage | null>(null);
  const [resellers, setResellers] = useState<ResellerPresence | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const disposedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [connected, grouped] = await Promise.all([
        fetchConnectedUsers(),
        isReseller ? Promise.resolve(null) : fetchResellerPresence(),
      ]);
      if (disposedRef.current) return;
      setPage(connected);
      setResellers(grouped);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (caughtError) {
      if (disposedRef.current) return;
      // Un échec de cycle n'efface pas le dernier relevé valide : il est
      // signalé, mais l'exploitant garde sous les yeux ce qu'il avait.
      setError({ cause: caughtError });
    }
  }, [isReseller]);

  useEffect(() => {
    disposedRef.current = false;
    setLoading(true);
    void load().finally(() => {
      if (!disposedRef.current) setLoading(false);
    });
    return () => { disposedRef.current = true; };
  }, [load]);

  // Rafraîchissement automatique : suspendu dès que l'onglet n'est plus
  // visible, sans chevauchement de requêtes, arrêté proprement au démontage.
  useEffect(() => {
    const clearPollTimer = () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    const runPoll = async () => {
      if (disposedRef.current || document.hidden || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        await load();
      } finally {
        pollInFlightRef.current = false;
      }
    };
    const schedulePoll = () => {
      clearPollTimer();
      if (disposedRef.current || document.hidden) return;
      pollTimerRef.current = setTimeout(async () => {
        await runPoll();
        schedulePoll();
      }, POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = () => {
      clearPollTimer();
      if (!document.hidden) {
        void runPoll();
        schedulePoll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    schedulePoll();
    return () => {
      clearPollTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading && !page) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-sm text-gray-500">
          <RefreshCw className="h-6 w-6 animate-spin text-cyan-400" />
          {t('operations.presence.loading')}</div>
      </div>
    );
  }

  // Erreur de chargement — distincte, explicitement, d'une absence de connectés.
  if (error && !page) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-rose-500/25 bg-rose-500/10 p-6 text-center">
        <AlertTriangle className="mx-auto h-7 w-7 text-rose-300" />
        <h1 className="mt-3 text-lg font-semibold text-white">{t('operations.presence.unavailable')}</h1>
        <p className="mt-2 text-sm text-rose-200/80">{errorMessage(error.cause, 'operations.presence.loadError')}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-5 inline-flex items-center gap-2 rounded-xl border border-rose-400/30 px-4 py-2 text-sm font-semibold text-rose-100 transition-colors hover:bg-rose-500/10"
        >
          <RefreshCw className="h-4 w-4" />
          {t('operations.common.retry')}</button>
      </div>
    );
  }

  if (!page) return null;

  const windowMinutes = page.presenceWindowMinutes;
  const showResellers = !isReseller && resellers !== null;

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">
            <Wifi className="h-4 w-4" />
            {t('operations.presence.eyebrow')}</div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">{t('operations.presence.title')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">
            {t('operations.presence.description', { minutes: formatNumber(windowMinutes) })}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
            <span>{t('operations.presence.heartbeat', { minutes: formatNumber(page.heartbeatMinutes) })}</span>
            <span>{t('operations.presence.autoRefresh', { seconds: formatNumber(POLL_INTERVAL_MS / 1000) })}</span>
            {lastUpdatedAt && (
              <span>{t('operations.presence.measuredAt', { time: formatDate(lastUpdatedAt, { timeStyle: 'medium' }) })}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1a1f2e] bg-[#0f1218] px-3 py-2 text-sm font-semibold text-gray-300 transition-colors hover:border-cyan-500/50 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {t('operations.common.refresh')}</button>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('operations.presence.staleData', { error: errorMessage(error.cause, 'operations.presence.loadError') })}
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-[#1a1f2e] bg-[#0f1218] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">{t('operations.presence.connectedNow')}</span>
            <Wifi className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-3 text-2xl font-bold text-emerald-300">{formatNumber(page.total)}</div>
          <div className="mt-1 text-xs text-gray-500">
            {isReseller ? t('operations.presence.scopeOwn') : t('operations.presence.scopePlatform')}
          </div>
        </div>
        <div className="rounded-2xl border border-[#1a1f2e] bg-[#0f1218] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">{t('operations.presence.window')}</span>
            <Clock3 className="h-4 w-4 text-cyan-400" />
          </div>
          <div className="mt-3 text-2xl font-bold text-white">
            {t('operations.presence.minutesValue', { count: formatNumber(windowMinutes) })}
          </div>
          <div className="mt-1 text-xs text-gray-500">{t('operations.presence.windowHint')}</div>
        </div>
        <div className="rounded-2xl border border-[#1a1f2e] bg-[#0f1218] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">{t('operations.presence.unmatched')}</span>
            <Smartphone className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-3 text-2xl font-bold text-amber-300">{formatNumber(page.unmatched)}</div>
          <div className="mt-1 text-xs text-gray-500">{t('operations.presence.unmatchedHint')}</div>
        </div>
      </section>

      <section className="flex items-start gap-3 rounded-2xl border border-blue-500/25 bg-blue-500/10 p-4 text-sm text-blue-100">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-300" />
        <div>
          <div className="font-semibold">{t('operations.presence.honestyTitle')}</div>
          <p className="mt-1 text-xs leading-relaxed text-blue-200/75">
            {t('operations.presence.honestyExplanation')}</p>
        </div>
      </section>

      {showResellers && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('users')}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              tab === 'users'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-[#1a1f2e] bg-[#0f1218] text-gray-400 hover:text-white'
            }`}
          >
            <Wifi className="h-4 w-4" />
            {t('operations.presence.tabUsers')}</button>
          <button
            type="button"
            onClick={() => setTab('resellers')}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              tab === 'resellers'
                ? 'border-violet-500/40 bg-violet-500/10 text-violet-200'
                : 'border-[#1a1f2e] bg-[#0f1218] text-gray-400 hover:text-white'
            }`}
          >
            <Store className="h-4 w-4" />
            {t('operations.presence.tabResellers')}</button>
        </div>
      )}

      {(!showResellers || tab === 'users') && (
        <section className="overflow-hidden rounded-2xl border border-[#1a1f2e] bg-[#0f1218]">
          <div className="flex flex-col gap-2 border-b border-[#1a1f2e] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Wifi className="h-4 w-4 text-emerald-400" />
                {t('operations.presence.tabUsers')}</h2>
              <p className="mt-1 text-[11px] text-gray-500">{t('operations.presence.usersHint')}</p>
            </div>
            <div className="text-xs text-gray-500">
              {t('operations.presence.listedCount', { count: formatNumber(page.users.length), total: formatNumber(page.total) })}
            </div>
          </div>
          {page.users.length === 0 ? (
            /* État vide explicite : personne n'est connecté. Ce n'est PAS une
               erreur de chargement, qui est rendue séparément ci-dessus. */
            <div className="p-10 text-center">
              <Wifi className="mx-auto h-7 w-7 text-gray-700" />
              <p className="mt-3 text-sm font-semibold text-gray-400">{t('operations.presence.emptyTitle')}</p>
              <p className="mt-1 text-xs text-gray-600">{t('operations.presence.emptyHint')}</p>
            </div>
          ) : (
            <UsersTable users={page.users} windowMinutes={windowMinutes} />
          )}
        </section>
      )}

      {showResellers && tab === 'resellers' && resellers && (
        <section className="space-y-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Store className="h-4 w-4 text-violet-400" />
              {t('operations.presence.tabResellers')}</h2>
            <span className="text-xs text-gray-500">
              {t('operations.presence.resellerTotal', { count: formatNumber(resellers.totalConnected) })}
            </span>
          </div>
          <ResellerGroup
            group={resellers.direct}
            windowMinutes={windowMinutes}
            expanded={expanded.__direct === true}
            onToggle={() => setExpanded((prev) => ({ ...prev, __direct: !prev.__direct }))}
          />
          {resellers.resellers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#1a1f2e] bg-[#0f1218] p-6 text-center text-sm text-gray-500">
              {t('operations.presence.noResellers')}</div>
          ) : (
            resellers.resellers.map((group) => (
              <ResellerGroup
                key={group.resellerId || '__direct'}
                group={group}
                windowMinutes={windowMinutes}
                expanded={expanded[group.resellerId || '__direct'] === true}
                onToggle={() => setExpanded((prev) => ({
                  ...prev,
                  [group.resellerId || '__direct']: !prev[group.resellerId || '__direct'],
                }))}
              />
            ))
          )}
        </section>
      )}
    </div>
  );
}
