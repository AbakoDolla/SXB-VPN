import { useEffect, useState } from "react";
import { fetchDashboardStats, fetchActivityLogs, DashboardStats } from "../api/analytics";
import { ActivityLog, Client } from "../types";
import { Users, Server, RefreshCw, AlertTriangle, Wifi, WifiOff, Clock, UserCog } from "lucide-react";

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
  info:    "bg-blue-500/10 border-blue-500/20 text-blue-400",
  warning: "bg-amber-500/10 border-amber-500/20 text-amber-400",
  success: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  danger:  "bg-rose-500/10 border-rose-500/20 text-rose-400",
};

export default function DashboardView({ onNavigate }: Props) {
  const [loading, setLoading]   = useState(true);
  const [stats, setStats]       = useState<DashboardStats | null>(null);
  const [logs, setLogs]         = useState<ActivityLog[]>([]);
  const [clients, setClients]   = useState<Client[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("sxb_admin_token") || sessionStorage.getItem("sxb_admin_token") || "";
      const [s, l, cr] = await Promise.all([
        fetchDashboardStats(),
        fetchActivityLogs(),
        fetch("/api/clients", { headers: { Authorization: "Bearer " + token } }),
      ]);
      setStats(s);
      setLogs(l);
      if (cr.ok) setClients(await cr.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

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

  const statItems = [
    { label: "Clients total",    value: clients.length,               color: "text-cyan-400",    bg: "bg-cyan-500/10",    icon: Users },
    { label: "Connectés",        value: connected.length,             color: "text-emerald-400", bg: "bg-emerald-500/10", icon: Wifi },
    { label: "Comptes expirés",  value: stats?.expiredAccounts ?? 0,  color: "text-rose-400",    bg: "bg-rose-500/10",    icon: AlertTriangle },
    { label: "Serveurs actifs",  value: stats?.activeServers ?? 0,    color: "text-violet-400",  bg: "bg-violet-500/10",  icon: Server },
    { label: "Revendeurs",       value: stats?.activeResellers ?? 0,  color: "text-amber-400",   bg: "bg-amber-500/10",   icon: UserCog },
  ];

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tableau de bord</h1>
          <p className="text-sm text-gray-500 mt-0.5">Vue globale · SXB VPN</p>
        </div>
        <button onClick={load} className="p-2 rounded-xl text-gray-500 hover:text-white hover:bg-white/5 transition-colors cursor-pointer" title="Actualiser">
          <RefreshCw className="h-4 w-4" />
        </button>
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
                    <span className={"mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 " + (LOG_COLORS[log.type]?.split(" ")[0] || "bg-gray-600").replace("bg-", "bg-").replace("/10", "")} />
                    <div className="min-w-0">
                      <p className="text-xs text-gray-300 leading-snug">{log.action}</p>
                      <p className="text-[10px] text-gray-600 mt-0.5">{log.user} · {new Date(log.timestamp).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
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
