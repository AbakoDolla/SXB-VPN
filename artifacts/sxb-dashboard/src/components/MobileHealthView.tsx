import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Battery,
  CheckCircle2,
  Clock3,
  HeartPulse,
  Info,
  RefreshCw,
  Smartphone,
  Users,
} from 'lucide-react';
import {
  fetchMobileHealthSummary,
  type MobileHealthDevice,
  type MobileHealthSummary,
} from '../api/mobile-health';

const numberFormatter = new Intl.NumberFormat('fr-FR');

function formatNumber(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Indisponible'
    : date.toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes.toString().padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${Math.floor(safeSeconds)} s`;
}

function outcomeClasses(outcome: string): string {
  const normalized = outcome.toLowerCase();
  if (normalized.includes('success') || normalized.includes('succès') || normalized === 'ok') {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  }
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('échec')) {
    return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
  }
  return 'border-slate-500/25 bg-slate-500/10 text-slate-300';
}

function DeviceRow({ device }: { device: MobileHealthDevice }) {
  return (
    <tr className="align-top transition-colors hover:bg-white/[0.02]">
      <td className="px-4 py-3">
        <div className="font-mono text-xs font-semibold text-cyan-300">{device.pseudonym}</div>
        <div className="mt-1 text-[11px] text-gray-600">Identifiant pseudonymisé</div>
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-gray-200">{device.appVersion}</div>
        <div className="mt-1 font-mono text-[11px] text-gray-500">code {device.versionCode}</div>
        {device.needsUpdate && (
          <span className="mt-1.5 inline-flex rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
            Mise à jour requise
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-300">
        <div>{device.deviceModel || 'Modèle non communiqué'}</div>
        <div className="mt-1 text-[11px] text-gray-500">
          {device.androidApi === null ? 'API Android inconnue' : `API Android ${device.androidApi}`}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="text-gray-300">{device.tunnelState || 'Inconnu'}</div>
        <div className="mt-1 text-[11px] text-gray-500">{device.protocol || 'Protocole non communiqué'}</div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${outcomeClasses(device.lastOutcome)}`}>
          {device.lastOutcome || 'Inconnu'}
        </span>
        <div className="mt-1.5 font-mono text-[11px] text-rose-300/80">
          {device.lastErrorCode || 'Aucun code erreur'}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-300">
        <div>Session : {formatDuration(device.sessionDurationSeconds)}</div>
        <div className="mt-1 text-[11px] text-gray-500">Reconnexions : {formatNumber(device.reconnectCount)}</div>
      </td>
      <td className="px-4 py-3 text-gray-300">
        <div>Active : {formatDuration(device.activeDurationSeconds)}</div>
        <div className="mt-1 text-[11px] text-gray-500">
          Arrière-plan : {formatDuration(device.backgroundDurationSeconds)}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-300">
        <div>Réveils : {formatNumber(device.wakeCount)}</div>
        <div className="mt-1 text-[11px] text-gray-500">Rapports : {formatNumber(device.reportCount)}</div>
      </td>
      <td className="px-4 py-3">
        <div className="text-gray-300">{device.batteryOptimization || 'Inconnue'}</div>
        <div className="mt-1 whitespace-nowrap text-[11px] text-gray-500">{formatDate(device.lastSeenAt)}</div>
      </td>
    </tr>
  );
}

export default function MobileHealthView() {
  const [summary, setSummary] = useState<MobileHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSummary(await fetchMobileHealthSummary());
    } catch (caughtError: any) {
      setError(caughtError?.message || 'Impossible de charger la santé du parc mobile.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !summary) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-sm text-gray-500">
          <RefreshCw className="h-6 w-6 animate-spin text-cyan-400" />
          Chargement de la santé mobile…
        </div>
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-rose-500/25 bg-rose-500/10 p-6 text-center">
        <AlertTriangle className="mx-auto h-7 w-7 text-rose-300" />
        <h1 className="mt-3 text-lg font-semibold text-white">Santé mobile indisponible</h1>
        <p className="mt-2 text-sm text-rose-200/80">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-5 inline-flex items-center gap-2 rounded-xl border border-rose-400/30 px-4 py-2 text-sm font-semibold text-rose-100 transition-colors hover:bg-rose-500/10"
        >
          <RefreshCw className="h-4 w-4" />
          Réessayer
        </button>
      </div>
    );
  }

  if (!summary) return null;

  const successRate = Math.min(100, Math.max(0, summary.totals.successRate));
  const distinctVersions = summary.versions.length;

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">
            <HeartPulse className="h-4 w-4" />
            Observabilité applicative
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">Santé mobile</h1>
          <p className="mt-1 text-sm text-gray-400">
            Vue agrégée et pseudonymisée du parc Android SXB VPN.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
            <span>Générée le {formatDate(summary.generatedAt)}</span>
            <span>Fenêtre active : {formatNumber(summary.activeWindowHours)} h</span>
            <span>Signaux : {formatNumber(summary.retentionDays)} jours</span>
            <span>Appareils inactifs : {formatNumber(summary.deviceRetentionDays)} jours</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#263149] bg-[#0d1422] px-3 py-2 text-sm font-semibold text-gray-300 transition-colors hover:border-cyan-500/50 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Les dernières données restent affichées. Actualisation impossible : {error}
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">Versions installées</span>
            <Smartphone className="h-4 w-4 text-cyan-400" />
          </div>
          <div className="mt-3 text-2xl font-bold text-white">{formatNumber(distinctVersions)}</div>
          <div className="mt-1 text-xs text-gray-500">
            {formatNumber(summary.totals.devices)} appareils
            {summary.latestVersionCode === null ? '' : ` · dernière version ${summary.latestVersionCode}`}
          </div>
        </div>

        <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">Actifs / inactifs</span>
            <Users className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2 text-2xl font-bold">
            <span className="text-emerald-300">{formatNumber(summary.totals.active)}</span>
            <span className="text-sm font-normal text-gray-600">/</span>
            <span className="text-gray-300">{formatNumber(summary.totals.inactive)}</span>
          </div>
          <div className="mt-1 text-xs text-gray-500">Selon la fenêtre active configurée</div>
        </div>

        <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">Succès / échec</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-3 text-2xl font-bold text-white">{successRate.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</div>
          <div className="mt-1 text-xs text-gray-500">
            {formatNumber(summary.totals.successes)} succès · {formatNumber(summary.totals.failures)} échecs
          </div>
        </div>

        <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-gray-500">Mises à jour nécessaires</span>
            <AlertTriangle className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-3 text-2xl font-bold text-amber-300">{formatNumber(summary.totals.updatesNeeded)}</div>
          <div className="mt-1 text-xs text-gray-500">Appareils sous la version attendue</div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Répartition des versions</h2>
        </div>
        {summary.versions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#263149] bg-[#0a0d14] p-6 text-center text-sm text-gray-500">
            Aucune version remontée sur la période.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {summary.versions.map((version) => (
              <div
                key={`${version.appVersion}-${version.versionCode}`}
                className="rounded-2xl border border-[#263149] bg-[#0a0d14] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-white">{version.appVersion}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-gray-500">code {version.versionCode}</div>
                  </div>
                  {summary.latestVersionCode === version.versionCode && (
                    <span className="rounded-md border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
                      Dernière
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="text-xl font-bold text-white">{formatNumber(version.devices)}</div>
                    <div className="text-[11px] text-gray-500">appareils</div>
                  </div>
                  <div className={`text-right text-xs ${version.updatesNeeded > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                    {formatNumber(version.updatesNeeded)} à mettre à jour
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex items-start gap-3 rounded-2xl border border-blue-500/25 bg-blue-500/10 p-4 text-sm text-blue-100">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-300" />
        <div>
          <div className="font-semibold">Indicateurs techniques, pas mesure de consommation</div>
          <p className="mt-1 text-xs leading-relaxed text-blue-200/75">
            Les durées d’activité et d’arrière-plan, ainsi que les nombres de réveils et de rapports, sont des proxys
            d’activité applicative. Ils ne représentent pas une consommation énergétique et ne doivent jamais être
            interprétés comme des mAh.
          </p>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-[#263149] bg-[#0a0d14]">
        <div className="flex flex-col gap-2 border-b border-[#1a1f2e] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Battery className="h-4 w-4 text-cyan-400" />
              Détails anonymisés
            </h2>
            <p className="mt-1 text-[11px] text-gray-500">
              Uniquement les pseudonymes et métriques anonymisées prévus par le résumé de santé mobile.
              {summary.detailsTruncated ? ` Affichage limité aux ${summary.detailsLimit} derniers appareils.` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Clock3 className="h-3.5 w-3.5" />
            {formatNumber(summary.totals.reports)} rapports retenus
          </div>
        </div>

        {summary.devices.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-500">Aucun appareil pseudonymisé sur la période.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1420px] w-full text-left text-xs">
              <thead className="bg-[#0d1422] text-[10px] uppercase tracking-wider text-gray-500">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Appareil</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Version</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Android</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Tunnel</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Dernier résultat</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Session</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Activité (proxy)</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Événements (proxy)</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Optimisation / vu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {summary.devices.map((device) => (
                  <DeviceRow key={device.pseudonym} device={device} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
