import { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchDashboardStats, fetchTrafficAnalytics, fetchUserAnalytics, fetchActivityLogs, DashboardStats } from "../api/analytics";
import { TrafficDataPoint, UserDataPoint, ActivityLog } from "../types";
import { Activity, Server, Users, RefreshCw, Flame, BarChart3, Clock, AlertTriangle, ShieldCheck } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";
import { motion } from "motion/react";

interface DashboardViewProps {
  onNavigate: (route: string) => void;
}

export default function DashboardView({ onNavigate }: DashboardViewProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trafficData, setTrafficData] = useState<TrafficDataPoint[]>([]);
  const [userData, setUserData] = useState<UserDataPoint[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [s, tData, uData, lLogs] = await Promise.all([
        fetchDashboardStats(),
        fetchTrafficAnalytics(),
        fetchUserAnalytics(),
        fetchActivityLogs(),
      ]);
      setStats(s);
      setTrafficData(tData);
      setUserData(uData);
      setLogs(lLogs);
    } catch (error) {
      console.error("Error loading dashboard stats:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
        <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm font-mono">{t("common.loading")}</p>
      </div>
    );
  }

  const hasData = trafficData.length > 0;

  return (
    <div className="space-y-8">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white font-sans">{t("dashboard.title")}</h1>
        <p className="text-sm text-gray-400 mt-1">{t("dashboard.subtitle")}</p>
      </div>

      {/* Grid statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="p-5 rounded-xl border border-gray-800/60 bg-gray-900/40 backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 text-cyan-500 opacity-20 group-hover:opacity-40 transition-opacity">
            <Users className="h-10 w-10" />
          </div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{t("dashboard.stats.active_users")}</p>
          <p className="text-3xl font-bold text-white mt-2 font-sans tracking-tight">{stats?.activeUsers || 0}</p>
          <div className="mt-2 text-xs text-gray-500">
            {stats && stats.activeUsers > 0 ? "● Session active" : "Aucun utilisateur actif"}
          </div>
        </div>

        <div className="p-5 rounded-xl border border-gray-800/60 bg-gray-900/40 backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 text-rose-500 opacity-20 group-hover:opacity-40 transition-opacity">
            <AlertTriangle className="h-10 w-10" />
          </div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{t("dashboard.stats.expired_accounts")}</p>
          <p className="text-3xl font-bold text-white mt-2 font-sans tracking-tight">{stats?.expiredAccounts || 0}</p>
          <div className="mt-2 text-xs text-gray-500">
            {stats && stats.expiredAccounts > 0 ? "Nécessite renouvellement" : "Réseau en bonne santé"}
          </div>
        </div>

        <div className="p-5 rounded-xl border border-gray-800/60 bg-gray-900/40 backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 text-blue-500 opacity-20 group-hover:opacity-40 transition-opacity">
            <Flame className="h-10 w-10" />
          </div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{t("dashboard.stats.consumed_traffic")}</p>
          <p className="text-3xl font-bold text-white mt-2 font-mono tracking-tight">{stats?.consumedTraffic || 0} <span className="text-lg font-sans">Go</span></p>
          <div className="mt-2 text-xs text-gray-500">Données cumulées</div>
        </div>

        <div className="p-5 rounded-xl border border-gray-800/60 bg-gray-900/40 backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 text-emerald-500 opacity-20 group-hover:opacity-40 transition-opacity">
            <Server className="h-10 w-10" />
          </div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{t("dashboard.stats.active_servers")}</p>
          <p className="text-3xl font-bold text-white mt-2 font-sans tracking-tight">{stats?.activeServers || 0}</p>
          <div className="mt-2 text-xs text-gray-500">Serveurs VPS en ligne</div>
        </div>

        <div className="p-5 rounded-xl border border-gray-800/60 bg-gray-900/40 backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 text-purple-500 opacity-20 group-hover:opacity-40 transition-opacity">
            <ShieldCheck className="h-10 w-10" />
          </div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{t("dashboard.stats.active_resellers")}</p>
          <p className="text-3xl font-bold text-white mt-2 font-sans tracking-tight">{stats?.activeResellers || 0}</p>
          <div className="mt-2 text-xs text-gray-500">Partenaires affiliés</div>
        </div>
      </div>

      {/* Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1: Traffic */}
        <div className="p-6 rounded-xl border border-gray-800/60 bg-gray-900/20 backdrop-blur-md">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-6 flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-cyan-400" />
            {t("dashboard.charts.traffic_title")}
          </h3>
          
          {hasData ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trafficData}>
                  <defs>
                    <linearGradient id="colorDl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorUl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" stroke="#4b5563" fontSize={11} tickLine={false} />
                  <YAxis stroke="#4b5563" fontSize={11} tickLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: "#111827", borderColor: "#1f2937", borderRadius: 8, color: "#fff" }} />
                  <Area type="monotone" dataKey="download" name="Download" stroke="#06b6d4" fillOpacity={1} fill="url(#colorDl)" />
                  <Area type="monotone" dataKey="upload" name="Upload" stroke="#3b82f6" fillOpacity={1} fill="url(#colorUl)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-72 flex flex-col items-center justify-center border border-dashed border-gray-800/80 rounded-lg p-6 bg-gray-900/10 text-center">
              <BarChart3 className="h-10 w-10 text-gray-600 mb-2" />
              <p className="text-sm font-semibold text-gray-400">{t("common.no_data")}</p>
              <p className="text-xs text-gray-500 max-w-xs mt-1">
                Aucun trafic enregistré. Créez un client et allouez du trafic pour activer les graphiques.
              </p>
              <button
                onClick={() => onNavigate("clients")}
                className="mt-4 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
              >
                {t("clients.add_client")}
              </button>
            </div>
          )}
        </div>

        {/* Chart 2: Users Growth */}
        <div className="p-6 rounded-xl border border-gray-800/60 bg-gray-900/20 backdrop-blur-md">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-6 flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-400" />
            {t("dashboard.charts.users_title")}
          </h3>

          {hasData ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={userData}>
                  <XAxis dataKey="time" stroke="#4b5563" fontSize={11} tickLine={false} />
                  <YAxis stroke="#4b5563" fontSize={11} tickLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: "#111827", borderColor: "#1f2937", borderRadius: 8, color: "#fff" }} />
                  <Line type="monotone" dataKey="count" name="Utilisateurs" stroke="#10b981" strokeWidth={2} activeDot={{ r: 6 }} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-72 flex flex-col items-center justify-center border border-dashed border-gray-800/80 rounded-lg p-6 bg-gray-900/10 text-center">
              <Users className="h-10 w-10 text-gray-600 mb-2" />
              <p className="text-sm font-semibold text-gray-400">{t("common.no_data")}</p>
              <p className="text-xs text-gray-500 max-w-xs mt-1">
                La courbe d'acquisition des clients s'activera lorsque vous inscrirez de nouveaux utilisateurs.
              </p>
              <button
                onClick={() => onNavigate("clients")}
                className="mt-4 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
              >
                Inscrire un utilisateur
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Activity logs stream */}
      <div className="p-6 rounded-xl border border-gray-800/60 bg-gray-900/20 backdrop-blur-md">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-cyan-400" />
          {t("dashboard.activity.title")}
        </h3>

        {logs.length > 0 ? (
          <div className="divide-y divide-gray-800/50 max-h-80 overflow-y-auto pr-2 font-mono">
            {logs.map((log) => {
              const badgeColors = {
                info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
                warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
                success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
                danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
              };

              return (
                <div key={log.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded border ${badgeColors[log.type]} font-semibold`}>
                      {log.type.toUpperCase()}
                    </span>
                    <span className="text-white">{log.action}</span>
                  </div>
                  <div className="flex items-center gap-4 text-gray-500 text-[10px]">
                    <span>par <span className="text-gray-400 font-medium">{log.user}</span></span>
                    <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-8 text-center border border-dashed border-gray-800/80 rounded-lg bg-gray-900/10 text-gray-500 text-xs">
            {t("dashboard.activity.no_activity")}
          </div>
        )}
      </div>
    </div>
  );
}
