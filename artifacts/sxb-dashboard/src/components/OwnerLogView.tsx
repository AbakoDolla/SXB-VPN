import { useEffect, useState } from "react";
import { ActivityLog } from "../types";
import { fetchOwnerLogs, fetchMaintenanceState, setMaintenanceMode } from "../api/owner";
import { ScrollText, RefreshCw, PauseCircle, PlayCircle, Clock } from "lucide-react";

/**
 * OwnerLogView — « Journal propriétaire ».
 * Page réservée au rôle OWNER (garde côté route React + filtre serveur
 * /api/audit-logs/owner, la sécurité réelle étant le filtre serveur).
 * Affiche la traçabilité de sécurité : authentifications OWNER,
 * suspensions/révocations, bascules maintenance.
 */
export default function OwnerLogView() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [maintenance, setMaintenance] = useState<{ enabled: boolean; loading: boolean }>({ enabled: false, loading: true });

  const load = async () => {
    setLoading(true);
    try {
      const [ownerLogs, state] = await Promise.all([
        fetchOwnerLogs(200),
        fetchMaintenanceState().catch(() => null),
      ]);
      setLogs(ownerLogs);
      if (state) setMaintenance({ enabled: state.enabled, loading: false });
    } catch {
      /* ignoré — le serveur reste la source de vérité */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (enabled: boolean) => {
    setMaintenance(prev => ({ ...prev, loading: true }));
    try {
      const state = await setMaintenanceMode(enabled);
      setMaintenance({ enabled: state.enabled, loading: false });
      await load();
    } catch {
      setMaintenance(prev => ({ ...prev, loading: false }));
    }
  };

  const badgeColors: Record<string, string> = {
    info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <ScrollText className="w-5 h-5 text-rose-400" />
            Journal propriétaire
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Traçabilité de sécurité réservée au compte racine — invisible des autres rôles
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#0f1218] text-gray-400 border border-[#1a1f2e] hover:text-white hover:border-cyan-500/40 transition-all disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
      </div>

      {/* Carte Exploitation — pause/play du dashboard */}
      <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${maintenance.enabled ? 'bg-rose-500 shadow-sm shadow-rose-500' : 'bg-emerald-400 shadow-sm shadow-emerald-400'}`} />
            <div>
              <p className="text-sm font-semibold text-white">Exploitation du dashboard</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {maintenance.loading
                  ? "Lecture de l'état…"
                  : maintenance.enabled
                    ? "MODE MAINTENANCE ACTIF — le dashboard est en pause pour tous les autres rôles"
                    : "Service en ligne — le dashboard est accessible à tous les rôles"}
              </p>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => toggle(true)}
              disabled={maintenance.loading || maintenance.enabled}
              className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/25 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              <PauseCircle className="w-4 h-4" />
              Mettre le dashboard en pause
            </button>
            <button
              onClick={() => toggle(false)}
              disabled={maintenance.loading || !maintenance.enabled}
              className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              <PlayCircle className="w-4 h-4" />
              Remettre en service
            </button>
          </div>
        </div>
      </div>

      {/* Journal */}
      <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1a1f2e] flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Entrées de sécurité</span>
          <span className="text-[11px] text-gray-600">{logs.length} entrée(s)</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="w-5 h-5 text-cyan-400 animate-spin" />
          </div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center text-gray-600">
            <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">Aucune entrée de sécurité pour le moment</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-24">Type</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider">Action</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-32">Acteur</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-44">Horodatage</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-semibold uppercase tracking-wider w-36">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {logs.map(log => (
                  <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase ${badgeColors[log.type] || badgeColors.info}`}>
                        {log.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{log.action}</td>
                    <td className="px-4 py-3 text-gray-400">{log.user}</td>
                    <td className="px-4 py-3 text-gray-500 font-mono">
                      {new Date(log.timestamp).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })}
                    </td>
                    <td className="px-4 py-3 text-gray-600 font-mono">{log.ipAddress || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
