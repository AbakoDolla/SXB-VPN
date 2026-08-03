import { useState } from "react";
import { RefreshCw, Lock, ChevronRight } from "lucide-react";

/**
 * MaintenancePage — page publique « Maintenance en cours, réessayez plus tard ».
 * Aucune information sensible (rôles, endpoints, version) n'est exposée.
 * Un lien discret « Espace propriétaire » permet au compte racine OWNER
 * d'accéder au formulaire de connexion (/login) pendant la pause.
 */
export default function MaintenancePage({ onOwnerLogin }: { onOwnerLogin?: () => void }) {
  const [showOwnerAccess, setShowOwnerAccess] = useState(false);

  return (
    <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        {/* Logo */}
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 mx-auto mb-6 flex items-center justify-center shadow-xl shadow-cyan-500/20">
          <img src="/assets/images/logo_sxb_2026.png" alt="SXB VPN Logo" className="w-11 h-11 object-contain" />
        </div>

        <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-8 shadow-2xl">
          <div className="mx-auto mb-5 w-11 h-11 rounded-full border-2 border-[#1e293b] border-t-amber-400 animate-spin" />
          <span className="inline-block px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[10px] font-bold tracking-widest uppercase mb-4">
            Mode maintenance actif
          </span>
          <h1 className="text-xl font-bold text-white mb-2">Maintenance en cours</h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            Notre plateforme est momentanément indisponible.
            <br />
            Merci de réessayer dans quelques instants.
          </p>

          <button
            onClick={() => setShowOwnerAccess(v => !v)}
            className="mt-6 inline-flex items-center gap-1.5 text-[11px] text-gray-600 hover:text-gray-400 transition-colors cursor-pointer"
          >
            <Lock className="w-3 h-3" />
            Espace propriétaire
            <ChevronRight className={`w-3 h-3 transition-transform ${showOwnerAccess ? 'rotate-90' : ''}`} />
          </button>

          {showOwnerAccess && (
            <div className="mt-4 p-3 rounded-lg bg-[#07090e] border border-[#1a1f2e]">
              <p className="text-[11px] text-gray-500 mb-2 flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3" />
                L'accès à la connexion reste disponible pour l'exploitation.
              </p>
              <button
                onClick={onOwnerLogin}
                className="inline-flex items-center justify-center w-full py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-semibold transition-all cursor-pointer"
              >
                Se connecter à l'espace d'exploitation
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-600 mt-5">SXB VPN Control Panel</p>
      </div>
    </div>
  );
}
