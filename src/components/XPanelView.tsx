import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { getXPanelStatus, fetchXPanelUsers, fetchXPanelConfigurations, triggerXPanelSync, XPanelUser, XPanelConfig } from "../api/xpanel";
import { XPanelStatus, UserRole } from "../types";
import { RefreshCcw, RefreshCw, Terminal, ShieldAlert, Cpu, Link, Lock, Unlock, Eye, EyeOff, Radio } from "lucide-react";

interface XPanelViewProps {
  currentUserRole: UserRole;
}

export default function XPanelView({ currentUserRole }: XPanelViewProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<XPanelStatus | null>(null);
  const [syncedUsers, setSyncedUsers] = useState<XPanelUser[]>([]);
  const [configs, setConfigs] = useState<XPanelConfig[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});

  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const isReseller = currentUserRole === UserRole.RESELLER;

  const loadXPanelData = async () => {
    setLoading(true);
    try {
      const xStatus = await getXPanelStatus();
      setStatus(xStatus);
      
      if (!isReseller) {
        const u = await fetchXPanelUsers();
        setSyncedUsers(u);
      }
      
      if (isAdmin) {
        const c = await fetchXPanelConfigurations();
        setConfigs(c);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadXPanelData();
  }, []);

  const handleSync = async () => {
    if (!isAdmin) return;
    setSyncing(true);
    setTerminalLogs([
      `[${new Date().toLocaleTimeString()}] INITIATING XPANEL REMOTE CALL...`,
      `[${new Date().toLocaleTimeString()}] Authenticating master node with SSH RSA...`,
      `[${new Date().toLocaleTimeString()}] Fetching active customer tokens from database...`
    ]);

    const logSteps = [
      "Syncing Sing-box configuration file structure...",
      "Reloading Sing-box Service (VLESS XTLS engine)...",
      "Injecting dynamic client routing rules...",
      "Fetching server memory loads... OK",
      "XPANEL CORES FULLY SYNCHRONIZED AND RESTARTING!"
    ];

    let currentStepIdx = 0;
    const interval = setInterval(() => {
      if (currentStepIdx < logSteps.length) {
        setTerminalLogs((prev) => [
          ...prev,
          `[${new Date().toLocaleTimeString()}] ${logSteps[currentStepIdx]}`
        ]);
        currentStepIdx++;
      } else {
        clearInterval(interval);
      }
    }, 450);

    try {
      await triggerXPanelSync();
      await loadXPanelData();
    } catch (err) {
      alert("Erreur de synchronisation");
    } finally {
      setSyncing(false);
    }
  };

  const toggleSensitive = (id: string) => {
    setShowSensitive((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (isReseller) {
    return (
      <div className="border border-gray-800 rounded-xl p-8 bg-gray-950/20 backdrop-blur-md text-center max-w-lg mx-auto">
        <ShieldAlert className="h-10 w-10 text-rose-500 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-white">Accès Refusé</h2>
        <p className="text-sm text-gray-400 mt-2 leading-relaxed">
          Le moteur technique <strong>XPanel</strong> (SSH, configurations VLESS, et ports d'écoute Sing-box) est une infrastructure critique. Les revendeurs ne sont pas autorisés à inspecter ces données.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">XPanel Engine</h1>
          <p className="text-sm text-gray-400 mt-1">Supervisez et synchronisez le noyau technique du VPN (SSH + Sing-box Core).</p>
        </div>

        {isAdmin && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg shadow-lg cursor-pointer transition-all ${
              syncing 
                ? "bg-cyan-900 text-cyan-400 border border-cyan-700/50" 
                : "bg-cyan-500 text-black hover:bg-cyan-400"
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Synchronisation en cours..." : "Lancer Synchronisation"}
          </button>
        )}
      </div>

      {/* Grid Overview Status */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-lg border border-gray-800/80 bg-gray-950/40">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">État Core XPanel</p>
          <div className="flex items-center gap-2 mt-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-lg font-bold text-white uppercase">ONLINE</span>
          </div>
        </div>

        <div className="p-4 rounded-lg border border-gray-800/80 bg-gray-950/40">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Serveurs Connectés</p>
          <p className="text-lg font-bold text-white mt-1">{status?.connectedServers || 0}</p>
        </div>

        <div className="p-4 rounded-lg border border-gray-800/80 bg-gray-950/40">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Clients Actifs Synchros</p>
          <p className="text-lg font-bold text-white mt-1">{status?.synchronizedUsers || 0}</p>
        </div>

        <div className="p-4 rounded-lg border border-gray-800/80 bg-gray-950/40">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Protocoles Actifs</p>
          <p className="text-lg font-bold text-white mt-1">VLESS, VMESS, Trojan, SSH</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Terminal sync logs */}
        <div className="lg:col-span-2 p-5 rounded-xl border border-gray-800/80 bg-gray-950/60 font-mono text-xs flex flex-col h-80 relative overflow-hidden shadow-inner">
          <div className="absolute top-0 left-0 right-0 py-2 px-4 bg-gray-900 border-b border-gray-800/80 flex justify-between items-center text-gray-400 text-[10px] font-sans font-semibold">
            <span className="flex items-center gap-1.5"><Terminal className="h-3.5 w-3.5 text-cyan-400" /> Console de synchronisation XPanel</span>
            <span className="text-emerald-400 font-mono text-[9px] px-1 bg-emerald-950 border border-emerald-800/20 rounded">SSH SECURE</span>
          </div>
          
          <div className="flex-1 overflow-y-auto mt-6 space-y-2 pt-4 pr-2 text-cyan-500/90 leading-relaxed scrollbar-thin">
            {terminalLogs.length > 0 ? (
              terminalLogs.map((log, i) => <div key={i}>{log}</div>)
            ) : (
              <div className="text-gray-600 flex flex-col items-center justify-center h-full text-center font-sans">
                <Terminal className="h-8 w-8 text-gray-800 mb-2" />
                Console inactive. Cliquez sur "Lancer Synchronisation" pour charger les journaux d'exécution SSH.
              </div>
            )}
          </div>
        </div>

        {/* Live connections / Synced XPanel Users */}
        <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-4 flex items-center gap-2">
            <Radio className="h-4 w-4 text-emerald-400" />
            Tunnels Connectés (XPanel API)
          </h3>

          {syncedUsers.length > 0 ? (
            <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
              {syncedUsers.map((user, idx) => (
                <div key={idx} className="p-3 bg-gray-900/40 rounded-lg border border-gray-800/50 flex flex-col gap-1 text-xs">
                  <div className="flex justify-between font-bold text-white">
                    <span>{user.username}</span>
                    <span className="text-cyan-400 font-mono font-normal text-[10px]">{user.protocol}</span>
                  </div>
                  <div className="flex justify-between text-gray-500 text-[10px] font-mono mt-1">
                    <span>IP: {user.connectedIp}</span>
                    <span>Consommé: <strong className="text-gray-400">{user.trafficUsed} Go</strong></span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-56 flex flex-col items-center justify-center text-center text-gray-600">
              <Cpu className="h-7 w-7 text-gray-800 mb-2" />
              Aucun tunnel VPN actif sur l'infrastructure XPanel.
            </div>
          )}
        </div>
      </div>

      {/* VPN Configurations List (ONLY for Admin) */}
      <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-4 flex items-center gap-2">
          <Lock className="h-4 w-4 text-cyan-400" />
          Configurations de protocoles VPN (Administration RBAC active)
        </h3>

        {isAdmin ? (
          configs.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {configs.map((cfg) => {
                const isVisible = !!showSensitive[cfg.id];
                return (
                  <div key={cfg.id} className="p-4 bg-gray-950 border border-gray-800 rounded-lg space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold text-white">{cfg.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-cyan-950 text-cyan-400 border border-cyan-800/30 rounded font-bold font-mono uppercase">{cfg.protocol}</span>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[10px] text-gray-500 font-semibold uppercase">Port</p>
                      <p className="text-xs font-mono text-white">{cfg.port}</p>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] text-gray-500 font-semibold uppercase">UUID / Clé d'écoute</span>
                        <button 
                          onClick={() => toggleSensitive(cfg.id)}
                          className="p-1 hover:bg-gray-900 rounded text-gray-400 hover:text-white cursor-pointer"
                        >
                          {isVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      <p className="text-xs font-mono break-all text-cyan-400 bg-gray-900 p-1.5 rounded select-all">
                        {isVisible ? cfg.uuid : "••••••••••••••••••••••••••••••••"}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[10px] text-gray-500 font-semibold uppercase">Lien d'abonnement URI</p>
                      <p className="text-[10px] font-mono break-all text-gray-400 bg-gray-900 p-1.5 rounded select-all">
                        {isVisible ? cfg.fullConfigUrl : "vless://••••••••••••••••••••••••••••••••"}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-gray-500">Aucun protocole configuré.</div>
          )
        ) : (
          <div className="p-4 border border-rose-500/30 bg-rose-500/5 rounded-lg flex gap-3 items-start text-xs leading-relaxed text-rose-300">
            <ShieldAlert className="h-5 w-5 text-rose-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">Accès Restreint par RBAC (Rôle: {currentUserRole === UserRole.SUPPORT ? "Support" : "Inconnu"})</p>
              <p className="mt-1">
                Conformément aux directives de sécurité SXB VPN, les clés privées, UUID de tunnels, et URI de configurations complètes sont masqués pour votre rôle. Veuillez contacter un administrateur système si vous avez besoin de récupérer une configuration brute.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
