import { useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Info, ShieldCheck } from 'lucide-react';
import { apiRequest } from '../api/client';

/**
 * Services VPN disponibles — vue du REVENDEUR.
 *
 * Le revendeur ne possède pas `vpnprofile.view` : il ne peut pas ouvrir l'écran
 * Configurations, et c'est voulu. Il a néanmoins besoin de savoir quels
 * services l'administrateur lui a attribués, pour les vendre et les assigner à
 * ses clients.
 *
 * Cet écran n'affiche donc QUE le nom commercial. Aucune adresse, aucun port,
 * aucun identifiant, aucun paramètre de transport : la route serveur
 * `/vpn-profiles/assigned` ne renvoie que `id`, `name` et `displayProtocol`.
 */
interface AssignedService {
  id: string;
  name: string;
  displayProtocol?: string | null;
}

export default function ResellerServicesView() {
  const [services, setServices] = useState<AssignedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ profiles: AssignedService[] }>('/vpn-profiles/assigned');
      setServices(Array.isArray(data.profiles) ? data.profiles : []);
    } catch (err: any) {
      setError(err?.message || 'Impossible de charger les services');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <GitBranch className="w-6 h-6 text-violet-400" />
            Services VPN disponibles
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            Les services que l’administrateur vous a attribués. Utilisez-les pour créer les forfaits de vos clients.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-xl border border-[#1a1f2e] text-gray-300 hover:bg-white/5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
      </div>

      <div className="flex items-start gap-2 p-3 bg-violet-500/5 border border-violet-500/20 rounded-xl text-xs text-violet-200">
        <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
        <p>
          Les paramètres techniques (serveur, port, identifiants) restent confidentiels et sont provisionnés
          directement, de façon chiffrée, sur l’appareil de votre client au moment de l’activation.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
          <RefreshCw className="w-5 h-5 animate-spin text-violet-400" />
          Chargement…
        </div>
      ) : services.length === 0 ? (
        <div className="text-center py-16 bg-[#0f1218] border border-[#1a1f2e] rounded-xl">
          <Info className="w-10 h-10 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400 text-sm">Aucun service ne vous a encore été attribué.</p>
          <p className="text-gray-600 text-xs mt-1">
            Contactez votre administrateur pour qu’il vous en attribue.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map(s => (
            <div key={s.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 hover:border-violet-500/30 transition-colors">
              <div className="flex items-start gap-2">
                <div className="p-2 rounded-lg bg-violet-500/10 shrink-0">
                  <GitBranch className="w-4 h-4 text-violet-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-white font-medium truncate" title={s.name}>{s.name}</p>
                  {s.displayProtocol && (
                    <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20">
                      {s.displayProtocol}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && services.length > 0 && (
        <p className="text-xs text-gray-500">
          {services.length} service{services.length > 1 ? 's' : ''} disponible{services.length > 1 ? 's' : ''}.
        </p>
      )}
    </div>
  );
}
