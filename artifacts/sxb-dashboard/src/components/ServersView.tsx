import { isAdmin as isAdminRole } from '../lib/roles';
import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchServers, createServer, updateServer, deleteServer } from "../api/servers";
import { VPSServer, UserRole } from "../types";
import { Server, Plus, Search, Trash2, Cpu, Globe, Activity, HelpCircle, HardDrive, Shield } from "lucide-react";

interface ServersViewProps {
  currentUserRole: UserRole;
}

export default function ServersView({ currentUserRole }: ServersViewProps) {
  const { t, locale, formatNumber, message, errorText } = useTranslation();
  const [servers, setServers] = useState<VPSServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAddServer, setShowAddServer] = useState(false);
  const [error, setError] = useState<React.ReactNode>(null);

  // Form states
  const [name, setName] = useState("");
  const [location, setLocation] = useState("Paris, France 🇫🇷");
  const [ip, setIp] = useState("");

  const isAdmin = isAdminRole(currentUserRole);
  const isSupport = currentUserRole === UserRole.SUPPORT;

  const loadServers = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchServers();
      setServers(data);
    } catch (err) {
      setError(errorText(err, "technical.errors.load"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !ip) { setError(message("technical.servers.requiredFields")); return; }

    try {
      await createServer({
        name,
        location,
        ip,
        status: "online",
      });
      setName("");
      setIp("");
      setShowAddServer(false);
      loadServers();
    } catch (err) {
      setError(errorText(err, "technical.servers.createError"));
    }
  };

  const handleTogglePower = async (id: string, currentStatus: "online" | "offline") => {
    if (!isAdmin) return;
    try {
      const newStatus = currentStatus === "online" ? "offline" : "online";
      await updateServer(id, { 
        status: newStatus,
        cpuLoad: 0,
        ramLoad: 0,
        activeUsers: 0
      });
      loadServers();
    } catch (err) {
      setError(errorText(err, "technical.servers.statusError"));
    }
  };

  const handleDelete = async (id: string) => {
    if (!isAdmin) return;
    if (!confirm(t("technical.servers.confirmDelete"))) return;
    try {
      await deleteServer(id);
      loadServers();
    } catch (err) {
      setError(errorText(err, "technical.errors.delete"));
    }
  };

  const filtered = servers.filter((s) => {
    return (s.name || "").toLowerCase().includes(search.toLowerCase()) || 
           (s.ip || "").toLowerCase().includes(search.toLowerCase()) ||
           (s.location || "").toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6" lang={locale}>
      {error && !showAddServer && <div role="alert" className="text-sm text-rose-400">{error}</div>}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t("technical.servers.title")}</h1>
          <p className="text-sm text-gray-400 mt-1">{t("technical.servers.subtitle")}</p>
        </div>

        {isAdmin && (
          <button
            onClick={() => setShowAddServer(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            {t("technical.servers.addNode")}
          </button>
        )}
      </div>

      {/* Filter and Search */}
      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
        <input
          type="text"
          placeholder={t("technical.servers.search")} aria-label={t("technical.servers.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {/* Server grid */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <Globe className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">{t("technical.common.loading")}</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((s) => {
            const isOnline = s.status === "online";
            
            // Generate standard telemetry look
            const cpuColor = s.cpuLoad > 85 ? "text-rose-500" : s.cpuLoad > 60 ? "text-amber-500" : "text-cyan-400";
            const ramColor = s.ramLoad > 85 ? "text-rose-500" : s.ramLoad > 60 ? "text-amber-500" : "text-emerald-400";

            return (
              <div 
                key={s.id} 
                className={`p-5 rounded-xl border transition-all ${
                  isOnline 
                    ? "border-gray-800/80 bg-gray-950/40 hover:border-gray-700/80" 
                    : "border-gray-900/60 bg-gray-950/10 opacity-70"
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                      <Server className="h-4 w-4 text-cyan-400" />
                      {s.name}
                    </h3>
                    <p className="text-[11px] text-gray-500 font-mono">{s.ip}</p>
                  </div>
                  
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    isOnline 
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                      : "bg-gray-500/10 text-gray-400 border border-gray-500/20"
                  }`}>
                    <span className={`h-1 w-1 rounded-full ${isOnline ? "bg-emerald-400" : "bg-gray-500"}`} />
                    {t(isOnline ? "technical.status.online" : "technical.status.offline")}
                  </span>
                </div>

                <div className="mt-4 flex items-center gap-1 text-xs text-gray-400">
                  <Globe className="h-3.5 w-3.5 text-gray-500" />
                  <span>{s.location}</span>
                </div>

                {/* Telemetry charts */}
                {isOnline && (
                  <div className="mt-5 grid grid-cols-2 gap-4 pt-4 border-t border-gray-900 font-mono text-[11px]">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-gray-500">
                        <span className="flex items-center gap-1"><Cpu className="h-3 w-3" /> {t("technical.servers.cpu")}</span>
                        <span className={cpuColor}>{formatNumber(s.cpuLoad / 100, { style: "percent" })}</span>
                      </div>
                      <div className="h-1.5 w-full bg-gray-950 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full ${s.cpuLoad > 85 ? "bg-rose-500" : s.cpuLoad > 60 ? "bg-amber-500" : "bg-cyan-500"}`} 
                          style={{ width: `${s.cpuLoad}%` }}
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-gray-500">
                        <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" /> {t("technical.servers.ram")}</span>
                        <span className={ramColor}>{formatNumber(s.ramLoad / 100, { style: "percent" })}</span>
                      </div>
                      <div className="h-1.5 w-full bg-gray-950 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full ${s.ramLoad > 85 ? "bg-rose-500" : s.ramLoad > 60 ? "bg-amber-500" : "bg-emerald-500"}`} 
                          style={{ width: `${s.ramLoad}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Users Count & Power actions */}
                <div className="mt-4 pt-3 border-t border-gray-900/60 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Activity className="h-3.5 w-3.5 text-emerald-400" />
                    <span>{t("technical.servers.connections")} <strong className="text-white">{formatNumber(s.activeUsers)}</strong></span>
                  </div>

                  {isAdmin && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleTogglePower(s.id, s.status)}
                        className={`px-2 py-1 text-[10px] font-bold rounded border cursor-pointer ${
                          isOnline 
                            ? "bg-amber-950/20 text-amber-400 border-amber-950 hover:bg-amber-950/40" 
                            : "bg-emerald-950/20 text-emerald-400 border-emerald-950 hover:bg-emerald-950/40"
                        }`}
                      >
                        {t(isOnline ? "technical.servers.stop" : "technical.servers.start")}
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        aria-label={t("technical.common.delete")}
                        className="p-1 hover:bg-rose-950/30 text-gray-500 hover:text-rose-400 rounded cursor-pointer border border-transparent hover:border-rose-900/40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <Server className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">{t("technical.servers.empty")}</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mt-1">{t("technical.servers.emptyHelp")}</p>
          {isAdmin && (
            <button
              onClick={() => setShowAddServer(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
            >
              {t("technical.servers.addFirst")}
            </button>
          )}
        </div>
      )}

      {/* Add Server Modal */}
      {showAddServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Server className="h-5 w-5 text-cyan-400" />
              {t("technical.servers.addNode")}
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
              {error && <div role="alert" className="text-sm text-rose-400">{error}</div>}
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("technical.servers.name")}</label>
                <input
                  type="text"
                  required
                  placeholder={t("technical.servers.nameExample")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("technical.servers.publicIp")}</label>
                <input
                  type="text"
                  required
                  placeholder="144.76.85.122"
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("technical.servers.location")}</label>
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                >
                  <option value="Paris, France 🇫🇷">{t("technical.servers.locations.paris")}</option>
                  <option value="Frankfurt, Allemagne 🇩🇪">{t("technical.servers.locations.frankfurt")}</option>
                  <option value="Amsterdam, Pays-Bas 🇳🇱">{t("technical.servers.locations.amsterdam")}</option>
                  <option value="Montreal, Canada 🇨🇦">{t("technical.servers.locations.montreal")}</option>
                  <option value="New York, USA 🇺🇸">{t("technical.servers.locations.newYork")}</option>
                </select>
              </div>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowAddServer(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  {t("technical.common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 cursor-pointer"
                >
                  {t("technical.servers.submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
