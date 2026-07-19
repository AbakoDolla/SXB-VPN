import { useEffect, useState } from "react";
import { fetchDashboardStats, fetchActivityLogs, DashboardStats } from "../api/analytics";
import { ActivityLog } from "../types";
import {
  Users, Server, RefreshCw, AlertTriangle, ShieldCheck,
  Flame, Wifi, Clock, UserPlus, CreditCard, TrendingUp,
  Smartphone, Activity,
} from "lucide-react";

interface Props { onNavigate: (route: string) => void }

function StatCard({ icon: Icon, label, value, color, sub }: {
  icon: any; label: string; value: number | string; color: string; sub?: string
}) {
  return (
    <div className="p-5 rounded-2xl border border-[#1a1f2e] bg-[#0a0d14] flex items-start gap-4">
      <div className={"w-10 h-10 rounded-xl flex items-center justify-center shrink-0 " + color.replace("text-", "bg-").replace("400","500/10").replace("500","500/10")}>
        <Icon className={"h-5 w-5 " + color} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 font-medium">{label}</p>
        <p className="text-2xl font-bold text-white mt-0.5 leading-none">{value}</p>
        {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

export default function DashboardView({ onNavigate }: Props) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats]   = useState<DashboardStats | null>(null);
  const [logs, setLogs]     = useState<ActivityLog[]>([]);
  const [clients, setClients] = useState<any[]>([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([fetchDashboardStats(), fetchActivityLogs()]);
      setStats(s);
      setLogs(l);
      // Fetch clients for connection status widget
      const token = localStorage.getItem("sxb_admin_token") || sessionStorage.getItem("sxb_admin_token") || "";
      const r = await fetch("/api/clients", { headers: { Authorization: "Bearer " + token } });
      if (r.ok) setClients(await r.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-400">
        <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm">Chargement du tableau de bord...</p>
      </div>
    );
  }

  // Connection status computation
  const connected = clients.filter(c => {
    if (!c.lastSeenAt && !c.activatedAt) return false;
    return Date.now() - new Date(c.lastSeenAt || c.activatedAt).getTime() < 10 * 60 * 1000;
  });
  const pending = clients.filter(c => !c.lastSeenAt && !c.activatedAt);
  const inactive = clients.filter(c => {
    if (!c.lastSeenAt && !c.activatedAt) return false;
    return Date.now() - new Date(c.lastSeenAt || c.activatedAt).getTime() >= 10 * 60 * 1000;
  });

  const logColors: Record<string, string> = {
    info:    "text-blue-400  bg-blue-500/10  border-blue-500/20",
    warning: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    success: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    danger:  "text-rose-400  bg-rose-500/10  border-rose-500/20",
  };

  return (
    <div className="space-y-7">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tableau de bord</h1>
          <p className="text-sm text-gray-500 mt-0.5">Vue globale du reseau SXB VPN</p>
        </div>
        <button onClick={loadData} className="p-2 rounded-xl text-gray-500 hover:text-white hover:bg-white/5 transition-colors cursor-pointer">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* ── Stats grid ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatCard icon={Users}        label="Clients actifs"   value={stats?.activeUsers      ?? 0} color="text-cyan-400"   sub={`${clients.length} total`} />
        <StatCard icon={Flame}        label="Data consommee"   value={`${stats?.consumedTraffic ?? 0} Go`} color="text-orange-400" />
        <StatCard icon={Server}       label="Serveurs en ligne" value={stats?.activeServers     ?? 0} color="text-emerald-400" />
        <StatCard icon={AlertTriangle} label="Comptes expires" value={stats?.expiredAccounts   ?? 0} color="text-rose-400" />
        <StatCard icon={ShieldCheck}  label="Revendeurs"       value={stats?.activeResellers   ?? 0} color="text-violet-400" />
      </div>

      {/* ── Main content: 2 cols ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Left col (2/3): App connection status */}
        <div className="lg:col-span-2 space-y-5">

          {/* Connection status widget */}
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Wifi className="h-4 w-4 text-cyan-400" /> Connexions App en temps reel
              </h2>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />{connected.length} connectes</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" />{inactive.length} inactifs</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-gray-600" />{pending.length} en attente</span>
              </div>
            </div>

            {clients.length === 0 ? (
              <div className="border border-dashed border-[#1a1f2e] rounded-xl p-8 text-center">
                <Smartphone className="h-10 w-10 text-gray-700 mx-auto mb-3" />
                <p className="text-sm text-gray-400 font-medium">Aucun client enregistre</p>
                <p className="text-xs text-gray-600 mt-1 max-w-xs mx-auto">Creez un client et attribuez-lui un forfait. Il apparaitra ici des qu il ouvrira l app.</p>
                <button onClick={() => onNavigate("clients")}
                  className="mt-4 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 cursor-pointer">
                  + Nouveau client
                </button>
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {clients.slice(0, 15).map((c: any) => {
                  const hasActivity = c.lastSeenAt || c.activatedAt;
                  const isConnected = hasActivity && Date.now() - new Date(c.lastSeenAt || c.activatedAt).getTime() < 10 * 60 * 1000;
                  const status = !hasActivity ? "pending" : isConnected ? "connected" : "inactive";
                  const dotClass = { connected: "bg-emerald-400 animate-pulse", inactive: "bg-amber-400", pending: "bg-gray-600" }[status];
                  const labelClass = { connected: "text-emerald-400", inactive: "text-amber-500", pending: "text-gray-500" }[status];
                  const label = { connected: "Connecte", inactive: "Inactif", pending: "Non active" }[status];
                  return (
                    <div key={c.id} className="flex items-center justify-between px-3 py-2.5 bg-[#0f1218] rounded-xl hover:bg-[#131720] transition-colors">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center shrink-0">
                          <span className="text-xs font-bold text-cyan-400">{(c.user?.name || c.name || "?")[0].toUpperCase()}</span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{c.user?.name || c.name || "—"}</p>
                          {c.deviceId
                            ? <p className="text-[10px] font-mono text-gray-600 truncate">{c.deviceId}</p>
                            : <p className="text-[10px] text-gray-700 italic">Pas de device ID</p>
                          }
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        {c.lastSeenAt && (
                          <span className="text-[10px] text-gray-600">
                            {new Date(c.lastSeenAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        )}
                        <span className={"text-xs font-medium flex items-center gap-1 " + labelClass}>
                          <span className={"h-1.5 w-1.5 rounded-full " + dotClass} />
                          {label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Activity logs */}
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
              <Activity className="h-4 w-4 text-gray-400" /> Activite recente
            </h2>
            {logs.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-6">Aucune activite enregistree.</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {logs.slice(0, 20).map(log => (
                  <div key={log.id} className="flex items-center gap-3 text-xs py-2 border-b border-[#0f1218] last:border-0">
                    <span className={"px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0 " + (logColors[log.type] ?? logColors.info)}>
                      {log.type.toUpperCase()}
                    </span>
                    <span className="text-gray-300 flex-1 truncate">{log.action}</span>
                    <span className="text-gray-600 shrink-0 font-mono text-[10px]">
                      {new Date(log.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right col (1/3): Quick actions + mini stats */}
        <div className="space-y-4">

          {/* Quick actions */}
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Actions rapides</h2>
            <div className="space-y-2">
              {[
                { icon: UserPlus,   label: "Nouveau client",   route: "clients",       color: "text-cyan-400   bg-cyan-500/10   hover:bg-cyan-500/20" },
                { icon: CreditCard, label: "Nouveau forfait",  route: "subscriptions", color: "text-blue-400   bg-blue-500/10   hover:bg-blue-500/20" },
                { icon: Server,     label: "Gerer serveurs",   route: "servers",       color: "text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20" },
                { icon: ShieldCheck,label: "Profils VPN",      route: "vpn-profiles",  color: "text-violet-400 bg-violet-500/10  hover:bg-violet-500/20" },
              ].map(({ icon: Icon, label, route, color }) => (
                <button key={route} onClick={() => onNavigate(route)}
                  className={"w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer " + color}>
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* App connection summary */}
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-violet-400" /> Appareils
            </h2>
            <div className="space-y-3">
              {[
                { label: "Connectes",  count: connected.length, color: "bg-emerald-500" },
                { label: "Inactifs",   count: inactive.length,  color: "bg-amber-500" },
                { label: "Non actives", count: pending.length,  color: "bg-gray-600" },
              ].map(({ label, count, color }) => {
                const pct = clients.length > 0 ? (count / clients.length) * 100 : 0;
                return (
                  <div key={label}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-400">{label}</span>
                      <span className="text-white font-semibold">{count}</span>
                    </div>
                    <div className="h-1.5 bg-[#1a1f2e] rounded-full overflow-hidden">
                      <div className={"h-full rounded-full " + color} style={{ width: pct + "%" }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={() => onNavigate("clients")}
              className="w-full mt-4 text-xs text-gray-500 hover:text-cyan-400 transition-colors cursor-pointer text-center">
              Voir tous les clients →
            </button>
          </div>

          {/* Network health */}
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-cyan-400" /> Sante reseau
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Serveurs actifs</span>
                <span className={stats?.activeServers ? "text-emerald-400 font-semibold" : "text-gray-600"}>{stats?.activeServers ?? 0} / {(stats?.activeServers ?? 0) + 1}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Comptes expires</span>
                <span className={(stats?.expiredAccounts ?? 0) > 0 ? "text-rose-400 font-semibold" : "text-gray-600"}>{stats?.expiredAccounts ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Revendeurs actifs</span>
                <span className="text-violet-400 font-semibold">{stats?.activeResellers ?? 0}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-[#1a1f2e]">
                <span className="text-gray-500">Statut global</span>
                <span className="text-emerald-400 font-bold">● Operationnel</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
