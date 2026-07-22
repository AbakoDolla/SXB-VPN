import { useState } from "react";
import { UserRole } from "../types";
import SSHManagerView from "./SSHManagerView";
import PayloadManagerView from "./PayloadManagerView";
import XrayManagerView from "./XrayManagerView";
import SingboxManagerView from "./SingboxManagerView";
import { Terminal, Code2, Zap, Box, Network } from "lucide-react";

interface Props {
  currentUserRole: UserRole;
  defaultTab?: string;
}

const TABS = [
  { id: "ssh", label: "SSH Manager", icon: Terminal, desc: "Comptes SSH, Slow DNS, Payload", roles: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
  { id: "payload", label: "Payload Manager", icon: Code2, desc: "Payloads HTTP Injector / SNI", roles: ["SUPER_ADMIN", "ADMIN"] },
  { id: "xray", label: "Xray / Protocols", icon: Zap, desc: "VLESS · VMess · Trojan · Shadowsocks", roles: ["SUPER_ADMIN", "ADMIN"] },
  { id: "singbox", label: "Sing-box", icon: Box, desc: "Sing-box · Hysteria2 · TUIC", roles: ["SUPER_ADMIN", "ADMIN"] },
];

export default function VpnEngineView({ currentUserRole, defaultTab = "ssh" }: Props) {
  const visibleTabs = TABS.filter(t => t.roles.includes(currentUserRole));
  const [activeTab, setActiveTab] = useState(
    visibleTabs.find(t => t.id === defaultTab)?.id ?? visibleTabs[0]?.id ?? "ssh"
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Network className="w-5 h-5 text-violet-400" />
          <h1 className="text-xl font-bold text-white tracking-tight">VPN Engine</h1>
        </div>
        <p className="text-xs text-gray-500">Gestion centralisée de tous les protocoles et configurations VPN</p>
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
                  ? "bg-violet-500/15 text-violet-300 border-violet-500/30"
                  : "bg-[#0a0d14] text-gray-500 border-[#1a1f2e] hover:text-gray-200 hover:border-[#252b3b]"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {isActive && (
                <span className="hidden sm:block text-[10px] text-violet-500/80 font-normal border-l border-violet-500/30 pl-2 ml-0.5">
                  {tab.desc}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "ssh" && <SSHManagerView currentUserRole={currentUserRole} />}
        {activeTab === "payload" && <PayloadManagerView currentUserRole={currentUserRole} />}
        {activeTab === "xray" && <XrayManagerView currentUserRole={currentUserRole} />}
        {activeTab === "singbox" && <SingboxManagerView currentUserRole={currentUserRole} />}
      </div>
    </div>
  );
}
