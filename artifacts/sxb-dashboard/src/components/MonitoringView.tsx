import { useState, useEffect } from "react";
import { UserRole, ActivityLog } from "../types";
import SessionsView from "./SessionsView";
import ServersView from "./ServersView";
import { Activity, Server, Radio, RefreshCw, Clock, Search } from "lucide-react";
import { fetchActivityLogs } from "../api/analytics";

interface Props {
  currentUserRole: UserRole;
  defaultTab?: string;
}

const TABS = [
  { id: "sessions", label: "Sessions", icon: Radio, roles: ["SUPER_ADMIN", "ADMIN"] },
  { id: "logs", label: "Logs & Activité", icon: Activity, roles: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
  { id: "servers", label: "Serveurs", icon: Server, roles: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
];

function LogsView() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchActivityLogs();
      setLogs(data);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = logs.filter(l => {
    const matchSearch = (l.action || "").toLowerCase().includes(search.toLowerCase()) || (l.user || "").toLowerCase().includes(search.toLowerCase());
    const matchType = typeFilter === "all" || l.type === typeFilter;
    return matchSearch && matchType;
  });

  const badgeColors: Record<string, string> = {
    info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  };

  const typeCounts = ["info", "warning", "success", "danger"].map(t => ({
    type: t,
    count: logs.filter(l => l.type === t).length,
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Logs & Activité</h2>
          <p className="text-xs text-gray-500 mt-0.5">{logs.length} entrées au total</p>
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#0f1218] text-gray-400 border border-[#1a1f2e] hover:text-white transition-all disabled:opacity-50 cursor-pointer">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
      </div>

      {/* Type stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {typeCounts.map(({ type, count }) => (
          <button
            key={type}
            onClick={() => setTypeFilter(prev => prev === type ? 'all' : type)}
            className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${typeFilter === type ? badgeColors[type] + ' border-opacity-50' : 'bg-[#0a0d14] border-[#1a1f2e] hover:border-[#252b3b]'}`}
          >
            <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{type}</p>
            <p className="text-xl font-bold text-white">{count}</p>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher par action ou utilisateur…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
        />
      </div>

      {/* Logs table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="w-5 h-5 text-cyan-400 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center text-gray-600">
          <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Aucun log trouvé</p>
        </div>
      ) : (
        <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-24">Type</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider">Action</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-32">Utilisateur</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-36">Horodatage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {filtered.map(log => (
                  <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase ${badgeColors[log.type] || badgeColors.info}`}>
                        {log.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{log.action}</td>
                    <td className="px-4 py-3 text-gray-400 font-medium">{log.user}</td>
                    <td className="px-4 py-3 text-gray-500 font-mono">
                      {new Date(log.timestamp).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MonitoringView({ currentUserRole, defaultTab = "sessions" }: Props) {
  const visibleTabs = TABS.filter(t => t.roles.includes(currentUserRole));
  const [activeTab, setActiveTab] = useState(
    visibleTabs.find(t => t.id === defaultTab)?.id ?? visibleTabs[0]?.id ?? "logs"
  );

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Activity className="w-5 h-5 text-emerald-400" />
          <h1 className="text-xl font-bold text-white tracking-tight">Monitoring</h1>
        </div>
        <p className="text-xs text-gray-500">Surveillance temps réel du réseau, des sessions et des serveurs</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 flex-wrap">
        {visibleTabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all border cursor-pointer ${
                isActive
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : "bg-[#0a0d14] text-gray-500 border-[#1a1f2e] hover:text-gray-200 hover:border-[#252b3b]"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "sessions" && <SessionsView />}
        {activeTab === "logs" && <LogsView />}
        {activeTab === "servers" && <ServersView currentUserRole={currentUserRole} />}
      </div>
    </div>
  );
}
