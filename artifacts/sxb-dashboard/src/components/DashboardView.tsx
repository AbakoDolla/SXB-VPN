import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchDashboardStats, fetchTrafficAnalytics, fetchActivityLogs, DashboardStats } from "../api/analytics";
import { fetchClients } from "../api/clients";
import { fetchDevices } from "../api/devices";
import { fetchSessions } from "../api/sessions";
import { fetchServers } from "../api/servers";
import { apiRequest } from "../api/client";
import { TrafficDataPoint, ActivityLog, VPSServer, UserRole } from "../types";
import type { Device } from "../api/devices";
import {
  Users, Server, RefreshCw, Activity, AlertTriangle, Wifi,
  Clock, ShieldCheck, HardDrive, Cpu, Upload, Download,
  Database, TrendingUp, Radio, Zap, ArrowUpRight, PauseCircle, PlayCircle, Settings2, GitBranch,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, CartesianGrid, Legend,
} from "recharts";

interface DashboardViewProps {
  onNavigate: (route: string) => void;
  currentUserRole?: UserRole | string;
  maintenanceEnabled?: boolean;
  onMaintenanceToggle?: (enabled: boolean) => Promise<void>;
}

function StatCard({
  label, value, sub, icon: Icon, color, accent, onClick,
}: {
  label: string; value: string | number; sub?: string;
  icon: any; color: string; accent: string; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden rounded-xl border bg-[#0a0d14] dashboard-card sxb-animated-card p-4 flex flex-col gap-3 transition-all duration-200 ${onClick ? 'cursor-pointer hover:border-opacity-60 hover:scale-[1.01]' : ''} border-[#1a1f2e]`}
    >
      <div className="flex items-start justify-between">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accent}`}>
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <span className="text-[10px] font-medium text-gray-600 uppercase tracking-wider">{label}</span>
      </div>
      <div>
        <p className="text-2xl font-bold text-white tracking-tight">{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      <div className={`absolute -bottom-3 -right-3 w-16 h-16 rounded-full ${accent} opacity-20`} />
    </div>
  );
}

function ServerHealthCard({ server }: { server: VPSServer }) {
  const cpuColor = server.cpuLoad > 80 ? 'text-red-400' : server.cpuLoad > 60 ? 'text-amber-400' : 'text-emerald-400';
  const ramColor = server.ramLoad > 80 ? 'text-red-400' : server.ramLoad > 60 ? 'text-amber-400' : 'text-emerald-400';
  return (
    <div className="bg-[#0a0d14] dashboard-card sxb-animated-card border border-[#1a1f2e] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${server.status === 'online' ? 'bg-emerald-400 shadow-sm shadow-emerald-400' : 'bg-red-400'}`} />
          <span className="text-sm font-semibold text-white">{server.name}</span>
        </div>
        <span className="text-[10px] text-gray-500 font-mono">{server.ip}</span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500 flex items-center gap-1"><Cpu className="w-3 h-3" />CPU</span>
          <span className={`font-bold ${cpuColor}`}>{server.cpuLoad}%</span>
        </div>
        <div className="w-full bg-[#0f1218] rounded-full h-1.5">
          <div className={`h-1.5 rounded-full transition-all ${server.cpuLoad > 80 ? 'bg-red-400' : server.cpuLoad > 60 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${Math.min(server.cpuLoad, 100)}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500 flex items-center gap-1"><HardDrive className="w-3 h-3" />RAM</span>
          <span className={`font-bold ${ramColor}`}>{server.ramLoad}%</span>
        </div>
        <div className="w-full bg-[#0f1218] rounded-full h-1.5">
          <div className={`h-1.5 rounded-full transition-all ${server.ramLoad > 80 ? 'bg-red-400' : server.ramLoad > 60 ? 'bg-amber-400' : 'bg-blue-400'}`} style={{ width: `${Math.min(server.ramLoad, 100)}%` }} />
        </div>
      </div>
      <div className="flex items-center justify-between text-xs pt-1 border-t border-[#1a1f2e]">
        <span className="text-gray-500 flex items-center gap-1"><Radio className="w-3 h-3" />Actifs</span>
        <span className="text-cyan-400 font-bold">{server.activeUsers}</span>
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-lg p-2.5 text-xs shadow-xl">
      <p className="text-gray-400 mb-1.5 font-mono">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-gray-300">{p.name}:</span>
          <span className="text-white font-bold">{typeof p.value === 'number' ? p.value.toFixed(3) : p.value} GB</span>
        </div>
      ))}
    </div>
  );
};

function fmtBytes(bytes: number): string {
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
  return bytes + ' B';
}

export default function DashboardView({
  onNavigate,
  currentUserRole,
  maintenanceEnabled = false,
  onMaintenanceToggle,
}: DashboardViewProps) {
  const { t } = useTranslation();
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const isOwner = currentUserRole === UserRole.OWNER;
  // Le revendeur vend un service : l'infrastructure, les autres revendeurs et
  // les réglages système lui sont invisibles.
  const isReseller = currentUserRole === UserRole.RESELLER;
  const [assignedServices, setAssignedServices] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trafficData, setTrafficData] = useState<TrafficDataPoint[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [totalClients, setTotalClients] = useState(0);
  const [totalDevices, setTotalDevices] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeSessions, setActiveSessions] = useState(0);
  const [servers, setServers] = useState<VPSServer[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);
  const disposedRef = useRef(false);

  type LoadMode = "full" | "live";

  const loadData = useCallback(async (mode: LoadMode = "full") => {
    try {
      if (mode === "live") {
        // Polling léger : uniquement les données volatiles nécessaires aux
        // cartes quota, appareils et sessions. Les clients, logs et serveurs
        // restent sur le chargement complet/Actualiser pour ne pas surcharger l'API.
        const [s, tData, devices, sessions] = await Promise.all([
          fetchDashboardStats(),
          fetchTrafficAnalytics(),
          fetchDevices(),
          fetchSessions(),
        ]);
        if (disposedRef.current) return;
        setStats(s);
        setTrafficData(tData);
        setTotalDevices(devices.length);
        setDevices(devices);
        setActiveSessions(((sessions || []) as any[]).filter(session => session.status === 'active').length);
      } else {
        const [s, tData, lLogs, clients, devices, sessions, srvs] = await Promise.all([
          fetchDashboardStats(),
          fetchTrafficAnalytics(),
          // Le journal d'activité relève de l'exploitation de la plateforme :
          // il n'est ni affiché ni même demandé pour un revendeur.
          isReseller ? Promise.resolve([]) : fetchActivityLogs(),
          fetchClients().catch(() => []),
          fetchDevices().catch(() => []),
          fetchSessions().catch(() => []),
          fetchServers().catch(() => []),
        ]);
        if (disposedRef.current) return;
        setStats(s);
        setTrafficData(tData);
        setLogs(lLogs);
        setTotalClients(clients.length);
        setTotalDevices(devices.length);
        setDevices(devices);
        setActiveSessions(((sessions || []) as any[]).filter(session => session.status === 'active').length);
        setServers(srvs);
      }
      setLastUpdatedAt(new Date());
    } catch (error) {
      // Un échec d’un cycle ne doit pas effacer les dernières données valides.
      console.error("Dashboard load error:", error);
    }
  }, []);

  const initialLoad = async () => {
    setLoading(true);
    await loadData("full");
    setLoading(false);
  };

  const refresh = async () => {
    setRefreshing(true);
    await loadData("full");
    setRefreshing(false);
  };

  useEffect(() => {
    disposedRef.current = false;
    void initialLoad();
    return () => { disposedRef.current = true; };
  }, []);

  // Nombre de services attribués — remplace la carte « Serveurs » pour le
  // revendeur, qui n'a pas à connaître l'infrastructure.
  useEffect(() => {
    if (!isReseller) return;
    let cancelled = false;
    apiRequest<{ profiles: unknown[] }>('/vpn-profiles/assigned')
      .then((d: { profiles: unknown[] }) => { if (!cancelled) setAssignedServices(Array.isArray(d.profiles) ? d.profiles.length : 0); })
      .catch(() => { /* carte à zéro : jamais bloquant pour le tableau de bord */ });
    return () => { cancelled = true; };
  }, [isReseller]);

  // Polling sécurisé : 30 secondes, seulement quand l’onglet est visible,
  // sans chevauchement de requêtes et avec arrêt propre au démontage.
  useEffect(() => {
    const POLL_INTERVAL_MS = 30_000;

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
        await loadData("live");
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

    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedulePoll();
    return () => {
      clearPollTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadData]);

  // Compute traffic totals from data
  const totalDownload = trafficData.reduce((acc, d) => acc + (d.download || 0), 0);
  const totalUpload = trafficData.reduce((acc, d) => acc + (d.upload || 0), 0);
  const todayTraffic = trafficData.length > 0 ? trafficData[trafficData.length - 1] : null;
  const weeklyDownload = trafficData.slice(-7).reduce((acc, d) => acc + (d.download || 0), 0);

  // Les endpoints renvoient désormais des gigaoctets issus des compteurs réels.
  const consumedTrafficGB = stats ? `${Number(stats.consumedTraffic || 0).toFixed(2)} GB` : '—';
  const provisionedTrafficGB = stats ? `${Number(stats.provisionedTraffic || 0).toFixed(2)} GB` : '—';
  const remainingTrafficGB = stats ? `${Number(stats.remainingTraffic || 0).toFixed(2)} GB` : '—';

  // Alertes : le seuil est calculé par appareil à partir des octets réels
  // renvoyés par /api/devices. Un quota total nul n’est jamais considéré comme
  // « sous 10 % », car il signifie qu’aucun forfait n’est provisionné.
  const lowQuotaDevices = devices.filter(device => {
    const total = Number(device.quotaTotal || 0);
    const remaining = Number(device.quotaRemaining || Math.max(total - Number(device.quotaUsed || 0), 0));
    return device.status === 'active' && total > 0 && remaining / total < 0.10;
  });
  const lowQuotaMessage = lowQuotaDevices.length > 0
    ? `Quota critique : ${lowQuotaDevices.length} appareil(s) ont moins de 10 % restant${lowQuotaDevices.length > 1 ? '' : ''} — ${lowQuotaDevices.slice(0, 3).map(device => `${device.label || device.deviceId} (${((Number(device.quotaRemaining || 0) / Math.max(Number(device.quotaTotal || 1), 1)) * 100).toFixed(1)} %)`).join(', ')}${lowQuotaDevices.length > 3 ? '…' : ''}`
    : null;
  const alerts = [
    lowQuotaMessage ? { type: 'quota', msg: lowQuotaMessage } : null,
    stats?.expiredAccounts && stats.expiredAccounts > 0 ? { type: 'warning', msg: `${stats.expiredAccounts} compte(s) expiré(s)` } : null,
    servers.some(s => s.status === 'offline') ? { type: 'danger', msg: 'Serveur(s) hors ligne détecté(s)' } : null,
    servers.some(s => s.cpuLoad > 80) ? { type: 'warning', msg: 'CPU critique sur un ou plusieurs serveurs' } : null,
  ].filter(Boolean) as { type: string; msg: string }[];

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-gray-500">
        <RefreshCw className="h-6 w-6 animate-spin text-cyan-400" />
        <p className="text-xs font-mono">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">Dashboard</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Vue d'ensemble du réseau SXB VPN
            {lastUpdatedAt ? ` · Mise à jour ${lastUpdatedAt.toLocaleTimeString()}` : ''}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#0f1218] text-gray-400 border border-[#1a1f2e] hover:text-white hover:border-cyan-500/40 transition-all disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a, i) => (
                          <div key={i} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-xs font-medium ${
                a.type === 'quota' ? 'bg-rose-500/15 border-rose-500/40 text-rose-300 animate-pulse' : a.type === 'danger' ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
              }`}>

              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {a.msg}
            </div>
          ))}
        </div>
      )}

      {/* Carte Exploitation — OWNER uniquement (pause/play du dashboard) */}
      {isOwner && (
        <div className={`rounded-xl border p-4 transition-all ${
          maintenanceEnabled ? 'bg-rose-500/[0.07] border-rose-500/30' : 'bg-[#0a0d14] border-[#1a1f2e]'
        }`}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${maintenanceEnabled ? 'bg-rose-500/15' : 'bg-emerald-500/10'}`}>
                <Settings2 className={`w-4 h-4 ${maintenanceEnabled ? 'text-rose-400' : 'text-emerald-400'}`} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Exploitation</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {maintenanceEnabled
                    ? 'MODE MAINTENANCE ACTIF — le dashboard est en pause pour tous les autres rôles'
                    : 'Service en ligne — le dashboard est accessible à tous les rôles'}
                </p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={async () => { setMaintenanceBusy(true); try { await onMaintenanceToggle?.(true); } finally { setMaintenanceBusy(false); } }}
                disabled={maintenanceBusy || maintenanceEnabled}
                className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/25 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                <PauseCircle className="w-4 h-4" />
                Mettre le dashboard en pause
              </button>
              <button
                onClick={async () => { setMaintenanceBusy(true); try { await onMaintenanceToggle?.(false); } finally { setMaintenanceBusy(false); } }}
                disabled={maintenanceBusy || !maintenanceEnabled}
                className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                <PlayCircle className="w-4 h-4" />
                Remettre en service
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Row 1 — Clients & Réseau */}
      <div>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">
          {isReseller ? 'Mes clients' : 'Clients & Réseau'}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label={isReseller ? 'Mes clients' : 'Total Clients'} value={totalClients} sub="enregistrés" icon={Users} color="text-cyan-400" accent="bg-cyan-500/10" onClick={() => onNavigate('clients')} />
          <StatCard label="Connectés" value={stats?.activeUsers || 0} sub="sessions actives" icon={Wifi} color="text-emerald-400" accent="bg-emerald-500/10" onClick={() => onNavigate(isReseller ? 'clients' : 'sessions')} />
          <StatCard label="Appareils" value={totalDevices} sub="enregistrés" icon={HardDrive} color="text-blue-400" accent="bg-blue-500/10" onClick={() => onNavigate('devices')} />
          <StatCard label={isReseller ? 'Forfaits' : 'Sessions'} value={activeSessions} sub="actives" icon={Radio} color="text-violet-400" accent="bg-violet-500/10" onClick={() => onNavigate(isReseller ? 'subscriptions' : 'sessions')} />
          {/* L'infrastructure ne concerne pas le revendeur : il vend un service,
              il n'exploite pas les serveurs. On montre à la place les services
              qui lui sont attribués. */}
          {isReseller ? (
            <StatCard label="Mes services" value={assignedServices} sub="attribués" icon={GitBranch} color="text-amber-400" accent="bg-amber-500/10" onClick={() => onNavigate('reseller-services')} />
          ) : (
            <StatCard label="Serveurs" value={servers.filter(s => s.status === 'online').length} sub={`/ ${servers.length} total`} icon={Server} color="text-amber-400" accent="bg-amber-500/10" onClick={() => onNavigate('servers')} />
          )}
          <StatCard label="Expirés" value={stats?.expiredAccounts || 0} sub="à renouveler" icon={AlertTriangle} color="text-rose-400" accent="bg-rose-500/10" onClick={() => onNavigate('clients')} />
        </div>
      </div>

      {/* Row 2 — Trafic */}
      <div>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Trafic & Quota</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Download (réel)" value={fmtBytes(totalDownload * 1024 ** 3)} icon={Download} color="text-sky-400" accent="bg-sky-500/10" />
          <StatCard label="Upload (réel)" value={fmtBytes(totalUpload * 1024 ** 3)} icon={Upload} color="text-indigo-400" accent="bg-indigo-500/10" />
          <StatCard label="Trafic semaine" value={fmtBytes(weeklyDownload * 1024 ** 3)} icon={TrendingUp} color="text-teal-400" accent="bg-teal-500/10" />
          <StatCard label="Quota provisionné" value={provisionedTrafficGB} icon={HardDrive} color="text-blue-400" accent="bg-blue-500/10" />
          <StatCard label="Quota consommé" value={consumedTrafficGB} icon={Database} color="text-orange-400" accent="bg-orange-500/10" />
          <StatCard label="Quota restant" value={remainingTrafficGB} icon={TrendingUp} color="text-emerald-400" accent="bg-emerald-500/10" />
        </div>
      </div>

      {/* Traffic Chart */}
      {trafficData.length > 0 && (
        <div className="bg-[#0a0d14] dashboard-card sxb-animated-card border border-[#1a1f2e] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Trafic Temps Réel</h3>
            </div>
            <div className="flex items-center gap-4 text-[10px] text-gray-500">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cyan-400 inline-block" />Download</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-violet-400 inline-block" />Upload</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={trafficData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1f2e" />
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="download" name="Download" stroke="#22d3ee" strokeWidth={1.5} fill="url(#gDown)" dot={false} />
              <Area type="monotone" dataKey="upload" name="Upload" stroke="#a78bfa" strokeWidth={1.5} fill="url(#gUp)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Rangée basse — santé des serveurs et activité.
          Ces deux cartes relèvent de l'exploitation de la plateforme : aucune
          ne concerne un revendeur, et la rangée disparaît donc entièrement pour
          lui, plutôt que de laisser une grille vide. */}
      {!isReseller && (
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Santé des Serveurs</h3>
          </div>
          {servers.length > 0 ? (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {servers.map(server => <ServerHealthCard key={server.id} server={server} />)}
            </div>
          ) : (
            <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl p-6 text-center">
              <Server className="w-8 h-8 text-gray-700 mx-auto mb-2" />
              <p className="text-xs text-gray-500">Aucun serveur configuré</p>
              <button onClick={() => onNavigate('servers')} className="mt-2 text-xs text-cyan-400 hover:underline cursor-pointer">Ajouter un serveur</button>
            </div>
          )}
        </div>

        <div className="lg:col-span-3 bg-[#0a0d14] dashboard-card sxb-animated-card border border-[#1a1f2e] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-semibold text-white">Activité Récente</h3>
          </div>
          {logs.length > 0 ? (
            <div className="space-y-0 max-h-72 overflow-y-auto divide-y divide-[#1a1f2e]">
              {logs.slice(0, 15).map((log) => {
                const colors: Record<string, string> = {
                  info: 'text-blue-400 bg-blue-500/10',
                  warning: 'text-amber-400 bg-amber-500/10',
                  success: 'text-emerald-400 bg-emerald-500/10',
                  danger: 'text-rose-400 bg-rose-500/10',
                };
                return (
                  <div key={log.id} className="py-2.5 flex items-center gap-3 text-xs">
                    <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] uppercase ${colors[log.type] || colors.info}`}>
                      {log.type}
                    </span>
                    <span className="text-gray-300 flex-1 truncate">{log.action}</span>
                    <div className="flex items-center gap-2 text-gray-600 shrink-0">
                      <span className="hidden sm:block">{log.user}</span>
                      <span className="font-mono">{new Date(log.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-10 text-center text-gray-600">
              <Clock className="w-6 h-6 mx-auto mb-2 opacity-40" />
              <p className="text-xs">Aucune activité récente</p>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Quick-access row */}
      <div>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Accès Rapide</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(isReseller
            ? [
                // Les raccourcis du revendeur pointent vers ses propres outils :
                // aucun accès moteur ni serveur.
                { label: 'Mes clients', route: 'clients', icon: Users, color: 'text-cyan-400' },
                { label: 'Forfaits data', route: 'subscriptions', icon: Activity, color: 'text-emerald-400' },
                { label: 'Tokens SXB', route: 'tokens', icon: Zap, color: 'text-violet-400' },
                { label: 'Mes services', route: 'reseller-services', icon: GitBranch, color: 'text-amber-400' },
              ]
            : [
                { label: 'Nouveau client', route: 'clients', icon: Users, color: 'text-cyan-400' },
                { label: 'Sessions actives', route: 'sessions', icon: Activity, color: 'text-emerald-400' },
                { label: 'VPN Engine', route: 'vpn-engine', icon: Zap, color: 'text-violet-400' },
                { label: 'Serveurs', route: 'servers', icon: Server, color: 'text-amber-400' },
              ]
          ).map(item => (
            <button
              key={item.route}
              onClick={() => onNavigate(item.route)}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-[#0a0d14] border border-[#1a1f2e] hover:border-cyan-500/30 hover:bg-[#0f1218] text-xs font-medium text-gray-400 hover:text-white transition-all cursor-pointer text-left group"
            >
              <item.icon className={`w-4 h-4 ${item.color}`} />
              <span>{item.label}</span>
              <ArrowUpRight className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
