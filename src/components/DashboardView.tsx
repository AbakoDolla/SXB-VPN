import { useEffect, useState, useRef, useCallback } from "react";
import { fetchDashboardStats, fetchActivityLogs, fetchTrafficAnalytics, DashboardStats } from "../api/analytics";
import { ActivityLog, Client, TrafficDataPoint } from "../types";
import {
  Users, Server, RefreshCw, AlertTriangle, Wifi, WifiOff, Clock,
  UserCog, Plus, Key, BadgePercent, TrendingUp, Database,
} from "lucide-react";

interface Props { onNavigate: (route: string) => void }

type ConnStatus = "connected" | "inactive" | "pending";
function connStatus(c: Client): ConnStatus {
  if (!c.lastSeenAt && !c.activatedAt) return "pending";
  return Date.now() - new Date(c.lastSeenAt || c.activatedAt!).getTime() < 10 * 60 * 1000
    ? "connected" : "inactive";
}

const STATUS_CFG = {
  connected: { label: "Connecté",    dot: "bg-emerald-400 animate-pulse", row: "text-emerald-400", Icon: Wifi },
  inactive:  { label: "Inactif",     dot: "bg-amber-400",                 row: "text-amber-400",   Icon: WifiOff },
  pending:   { label: "Non activé",  dot: "bg-gray-600",                  row: "text-gray-500",    Icon: Clock },
};

const LOG_COLORS: Record<string, string> = {
  info:    "bg-blue-400",
  warning: "bg-amber-400",
  success: "bg-emerald-400",
  danger:  "bg-rose-400",
};

// Mini SVG sparkline for traffic
function Sparkline({ data, color = "#22d3ee" }: { data: number[]; color?: string }) {
  if (data.length < 2) return <div className="h-10 flex items-end text-xs text-gray-600">—</div>;
  const max = Math.max(...data, 1);
  const w = 120;
  const h = 36;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  });
  const pathD = `M${pts.join(" L")}`;
  const areaD = `M${pts[0]} L${pts.join(" L")} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#grad-${color.replace("#", "")})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function bytesToGb(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}

const AUTO_REFRESH_SECS = 60;

export default function DashboardView({ onNavigate }: Props) {
  const [loading, setLoading]     = useState(true);
  const [stats, setStats]         = useState<DashboardStats | null>(null);
  const [logs, setLogs]           = useState<ActivityLog[]>([]);
  const [clients, setClients]     = useState<Client[]>([]);
  const [traffic, setTraffic]     = useState<TrafficDataPoint[]>([]);
  const [countdown, setCountdown] = useState(AUTO_REFRESH_SECS);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const token = localStorage.getItem("sxb_admin_token") || sessionStorage.getItem("sxb_admin_token") || "";
      const [s, l, cr, tr] = await Promise.all([
        fetchDashboardStats(),
        fetchActivityLogs(),
        fetch("/api/clients", { headers: { Authorization: "Bearer " + token } }),
        fetchTrafficAnalytics(),
      ]);
      setStats(s);
      setLogs(l);
      if (cr.ok) setClients(await cr.json());
      setTraffic(tr);
      setLastRefresh(new Date());
      setCountdown(AUTO_REFRESH_SECS);
    } catch (e) { console.error(e); }
    finally { if (!silent) setLoading(false); }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh countdown
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { load(true); return AUTO_REFRESH_SECS; }
        return c - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-400">
        <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm">Chargement...</p>
      </div>
    );
  }

  const connected = clients.filter(c => connStatus(c) === "connected");
  const inactive  = clients.filter(c => connStatus(c) === "inactive");
  const pending   = clients.filter(c => connStatus(c) === "pending");

  // Traffic sparklines
  const dlData = traffic.map(t => t.download ?? 0);
  const ulData = traffic.map(t => t.upload ?? 0);

  // Consumed traffic (GB)
  const consumedGb = stats?.consumedTraffic ? bytesToGb(stats.consumedTraffic) : 0;
  const totalProvisionedGb = clients.reduce((acc, c) => acc + (Number(c.quotaTotal ?? 0) / (1024 ** 3)), 0);
  const quotaUsagePct = totalProvisionedGb > 0 ? Math.min((consumedGb / totalProvisionedGb) * 100, 100) : 0;

  const statItems = [
    { label: "Clients total",    value: clients.length,               color: "text-cyan-400",    bg: "bg-cyan-500/10",    icon: Users },
    { label: "Connectés",        value: connected.length,             color: "text-emerald-400", bg: "bg-emerald-500/10", icon: Wifi },
    { label: "Comptes expirés",  value: stats?.expiredAccounts ?? 0,  color: "text-rose-400",    bg: "bg-rose-500/10",    icon: AlertTriangle },
    { label: "Serveurs actifs",  value: stats?.activeServers ?? 0,    color: "text-violet-400",  bg: "bg-violet-500/10",  icon: Server },
    { label: "Revendeurs",       value: stats?.activeResellers ?? 0,  color: "text-amber-400",   bg: "bg-amber-500/10",   icon: UserCog },
  ];

  const quickActions = [
    { label: "Nouveau client",  icon: Plus,        route: "clients",   color: "hover:border-cyan-500/50 hover:text-cyan-400" },
    { label: "Créer un token",  icon: Key,         route: "tokens",    color: "hover:border-violet-500/50 hover:text-violet-400" },
    { label: "Nouveau voucher", icon: BadgePercent, route: "vouchers", color: "hover:border-amber-500/50 hover:text-amber-400" },
    { label: "Voir analytics",  icon: TrendingUp,  route: "analytics", color: "hover:border-emerald-500/50 hover:text-emerald-400" },
  ];

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tableau de bord</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Vue globale · SXB VPN
            <span className="ml-3 text-gray-600 text-xs">
              Mis à jour à {lastRefresh.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-gray-600 bg-[#0a0d14] border border-[#1a1f2e] px-2.5 py-1.5 rounded-lg">
            <RefreshCw className="h-3 w-3" />
            {countdown}s
          </span>
          <button
            onClick={() => load()}
            className="p-2 rounded-xl text-gray-500 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            title="Actualiser maintenant"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {quickActions.map(({ label, icon: Icon, route, color }) => (
          <button
            key={route}
            onClick={() => onNavigate(route)}
            className={`flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[#0a0d14] border border-[#1a1f2e] text-gray-400 text-xs font-medium transition-all cursor-pointer ${color}`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        {statItems.map(({ label, value, color, bg, icon: Icon }) => (
          <div key={label} className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-4 flex items-center gap-3">
            <div className={"w-9 h-9 rounded-xl flex items-center justify-center shrink-0 " + bg}>
              <Icon className={"h-4 w-4 " + color} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 truncate">{label}</p>
              <p className={"text-xl font-bold " + color}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Traffic + Quota row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

        {/* Traffic sparklines */}
        <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-white flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-cyan-400" /> Trafic récent
            </h2>
            <span className="text-[10px] text-gray-600">{traffic.length} points</span>
          </div>
          <div className="space-y-2">
            <div>
              <div className="flex items-center justify-between text-[10px] text-gray-600 mb-1">
                <span>↓ Download</span>
                <span>{dlData.length > 0 ? (dlData[dlData.length - 1] / (1024 ** 2)).toFixed(1) : "0"} MB/s</span>
              </div>
              <Sparkline data={dlData} color="#22d3ee" />
            </div>
            <div>
              <div className="flex items-center justify-between text-[10px] text-gray-600 mb-1">
                <span>↑ Upload</span>
                <span>{ulData.length > 0 ? (ulData[ulData.length - 1] / (1024 ** 2)).toFixed(1) : "0"} MB/s</span>
              </div>
              <Sparkline data={ulData} color="#a78bfa" />
            </div>
          </div>
        </div>

        {/* Quota consumption bar */}
        <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-white flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5 text-violet-400" /> Consommation quota
            </h2>
            <span className="text-[10px] text-gray-600">{quotaUsagePct.toFixed(1)}%</span>
          </div>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-[10px] text-gray-500 mb-1.5">
                <span>Consommé</span>
                <span className="font-mono text-cyan-400">{consumedGb.toFixed(2)} Go</span>
              </div>
              <div className="h-2 bg-[#1a1f2e] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-violet-500 transition-all duration-700"
                  style={{ width: `${quotaUsagePct}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-gray-600 mt-1.5">
                <span>Total provisionné</span>
                <span className="font-mono">{totalProvisionedGb.toFixed(2)} Go</span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="text-center">
                <p className="text-emerald-400 font-bold text-base">{connected.length}</p>
                <p className="text-[10px] text-gray-600">Actifs</p>
              </div>
              <div className="text-center border-x border-[#1a1f2e]">
                <p className="text-amber-400 font-bold text-base">{inactive.length}</p>
                <p className="text-[10px] text-gray-600">Inactifs</p>
              </div>
              <div className="text-center">
                <p className="text-gray-500 font-bold text-base">{pending.length}</p>
                <p className="text-[10px] text-gray-600">En attente</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Client connection status — 2/3 width */}
        <div className="lg:col-span-2 bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#1a1f2e]">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Wifi className="h-4 w-4 text-cyan-400" /> Connexions en temps réel
            </h2>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />{connected.length} actif{connected.length !== 1 ? "s" : ""}</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />{inactive.length} inactif{inactive.length !== 1 ? "s" : ""}</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-600 inline-block" />{pending.length} en attente</span>
            </div>
          </div>

          {clients.length === 0 ? (
            <div className="py-16 text-center text-gray-600 text-sm">Aucun client enregistré</div>
          ) : (
            <div className="divide-y divide-[#1a1f2e]">
              {clients.slice(0, 12).map(c => {
                const st = connStatus(c);
                const { label, dot, row, Icon } = STATUS_CFG[st];
                const name = (c as any).user?.name || "—";
                const phone = (c as any).user?.phone || null;
                return (
                  <div key={c.id} className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02] transition-colors">
                    <span className={"w-2 h-2 rounded-full shrink-0 " + dot} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{name}</p>
                      {phone && <p className="text-xs text-gray-600 truncate">{phone}</p>}
                    </div>
                    {c.deviceId && (
                      <span className="hidden sm:block text-xs font-mono text-gray-600 truncate max-w-[140px]">{c.deviceId}</span>
                    )}
                    <span className={"flex items-center gap-1 text-xs font-medium shrink-0 " + row}>
                      <Icon className="h-3 w-3" />{label}
                    </span>
                  </div>
                );
              })}
              {clients.length > 12 && (
                <button onClick={() => onNavigate("clients")}
                  className="w-full py-3 text-xs text-gray-500 hover:text-cyan-400 transition-colors cursor-pointer text-center">
                  Voir les {clients.length - 12} autres clients →
                </button>
              )}
            </div>
          )}
        </div>

        {/* Activity log — 1/3 width */}
        <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1a1f2e]">
            <h2 className="text-sm font-semibold text-white">Activité récente</h2>
          </div>
          {logs.length === 0 ? (
            <div className="py-16 text-center text-gray-600 text-sm">Aucune activité</div>
          ) : (
            <div className="divide-y divide-[#1a1f2e]">
              {logs.slice(0, 10).map(log => (
                <div key={log.id} className="px-5 py-3">
                  <div className="flex items-start gap-2">
                    <span className={"mt-1 w-1.5 h-1.5 rounded-full shrink-0 " + (LOG_COLORS[log.type] || "bg-gray-600")} />
                    <div className="min-w-0">
                      <p className="text-xs text-gray-300 leading-snug">{log.action}</p>
                      <p className="text-[10px] text-gray-600 mt-0.5">
                        {log.user} · {new Date(log.timestamp).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
