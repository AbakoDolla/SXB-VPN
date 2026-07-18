import { useState } from "react";
import { ExternalLink, Monitor, RefreshCw } from "lucide-react";

const XPANEL_URL = "https://vpnsxb.afrihall.com:8443/kqUtkMEvgdtx/";

export default function XPanelView({ currentUserRole }: { currentUserRole: string }) {
  const [iframeKey, setIframeKey] = useState(0);

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">XPanel</h1>
          <p className="text-gray-400 text-sm mt-1">Panel d'administration VPN ({currentUserRole})</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Reload */}
          <button
            onClick={() => setIframeKey(k => k + 1)}
            title="Recharger"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white text-xs transition-colors"
          >
            <RefreshCw size={13} />
            Recharger
          </button>

          {/* Ouvrir dans un nouvel onglet */}
          <a
            href={XPANEL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#5B8DEF] hover:bg-[#4a7de0] text-white text-xs transition-colors"
          >
            <ExternalLink size={13} />
            Ouvrir XPanel
          </a>
        </div>
      </div>

      {/* URL info */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-lg px-4 py-2 flex items-center gap-2 text-xs text-gray-400">
        <Monitor size={13} className="text-[#5B8DEF] shrink-0" />
        <span className="font-mono truncate">{XPANEL_URL}</span>
      </div>

      {/* Iframe XPanel */}
      <div className="flex-1 bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden" style={{ minHeight: "600px" }}>
        <iframe
          key={iframeKey}
          src={XPANEL_URL}
          title="XPanel"
          className="w-full h-full border-0"
          style={{ height: "700px" }}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      </div>

      {/* Fallback note */}
      <p className="text-gray-600 text-xs text-center">
        Si l'interface ne s'affiche pas, cliquer sur "Ouvrir XPanel" pour l'ouvrir dans un nouvel onglet.
      </p>
    </div>
  );
}
