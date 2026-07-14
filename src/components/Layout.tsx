import React, { useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
// @ts-ignore
import logoUrl from "../assets/images/logo_shield_1784022646518.jpg";
import { User, UserRole } from "../types";
import { getCurrentUser, saveCurrentUser } from "../api/db";
import { login } from "../api/auth";
import { 
  LayoutDashboard, Users, ShieldAlert, ShieldCheck, LifeBuoy, Server, Cpu, 
  Settings, Key, Ticket, BarChart3, Shield, Menu, X, ChevronRight, RefreshCw, UserCircle2, ChevronDown, Check
} from "lucide-react";

interface LayoutProps {
  children: React.ReactNode;
  activeRoute: string;
  onNavigate: (route: string) => void;
  currentUser: User;
  onUserChanged: (user: User) => void;
}

export default function Layout({ children, activeRoute, onNavigate, currentUser, onUserChanged }: LayoutProps) {
  const { t, language } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showRoleSelector, setShowRoleSelector] = useState(false);

  const menuItems = [
    { id: "dashboard", label: t("common.sidebar.dashboard"), icon: LayoutDashboard },
    { id: "clients", label: t("common.sidebar.clients"), icon: Users },
    { id: "resellers", label: t("common.sidebar.resellers"), icon: ShieldCheck },
    { id: "servers", label: t("common.sidebar.servers"), icon: Server },
    { id: "xpanel", label: t("common.sidebar.xpanel"), icon: Cpu },
    { id: "tokens", label: t("common.sidebar.tokens"), icon: Key },
    { id: "vouchers", label: t("common.sidebar.vouchers"), icon: Ticket },
    { id: "support", label: t("common.sidebar.support"), icon: LifeBuoy },
    { id: "rbac", label: t("common.sidebar.rbac"), icon: Shield },
    { id: "settings", label: t("common.sidebar.settings"), icon: Settings },
  ];

  const handleRoleSimulation = async (role: UserRole) => {
    setLoadingSim(true);
    try {
      const emailMap = {
        [UserRole.ADMIN]: "admin@sxb-vpn.com",
        [UserRole.SUPPORT]: "support@sxb-vpn.com",
        [UserRole.RESELLER]: "revendeur@sxb-vpn.com",
      };
      const user = await login(emailMap[role], role);
      onUserChanged(user);
      setShowRoleSelector(false);
      // Navigate to dashboard on role change to reset view
      onNavigate("dashboard");
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingSim(false);
    }
  };

  const [loadingSim, setLoadingSim] = useState(false);

  return (
    <div className="min-h-screen bg-[#07090e] text-white flex flex-col md:flex-row font-sans selection:bg-cyan-500 selection:text-black">
      {/* Mobile Header */}
      <header className="md:hidden p-4 bg-[#0a0f18]/90 border-b border-gray-900/60 flex justify-between items-center sticky top-0 z-40 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <img 
            src={logoUrl} 
            alt="SXB VPN Logo" 
            className="h-8 w-8 object-contain filter drop-shadow-[0_0_8px_rgba(6,182,212,0.6)] rounded-lg"
            referrerPolicy="no-referrer"
          />
          <span className="font-bold tracking-wider bg-gradient-to-r from-white via-cyan-200 to-cyan-400 bg-clip-text text-transparent text-sm">SXB VPN</span>
        </div>
        
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="p-1.5 rounded-lg border border-gray-800 text-gray-400 hover:text-white"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>

      {/* Sidebar navigation */}
      <aside className={`w-64 bg-[#0a0f18]/90 border-r border-gray-900/60 flex-col justify-between fixed md:sticky top-0 h-screen z-40 backdrop-blur-md shrink-0 flex transition-transform md:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      }`}>
        <div className="flex flex-col flex-1 min-h-0">
          {/* Logo & title brand */}
          <div className="p-6 border-b border-gray-900/40 flex items-center gap-3">
            <img 
              src={logoUrl} 
              alt="SXB VPN Logo" 
              className="h-10 w-10 object-contain filter drop-shadow-[0_0_10px_rgba(6,182,212,0.7)] rounded-xl"
              referrerPolicy="no-referrer"
            />
            <div>
              <span className="font-extrabold tracking-widest text-lg bg-gradient-to-r from-white via-cyan-100 to-cyan-400 bg-clip-text text-transparent">SXB VPN</span>
              <p className="text-[9px] font-mono font-bold tracking-widest text-cyan-500/80 uppercase">SaaS Panel</p>
            </div>
          </div>

          {/* Navigation links */}
          <nav className="flex-1 px-4 py-6 overflow-y-auto space-y-1 scrollbar-thin">
            {menuItems.map((item) => {
              const IconComp = item.icon;
              const isActive = activeRoute === item.id;
              
              // Highlight item if role restricted
              const isXpanel = item.id === "xpanel";
              const isRbac = item.id === "rbac";
              const isResellerScope = item.id === "resellers";
              
              const isRestricted = 
                (currentUser.role === UserRole.RESELLER && (isXpanel || isRbac || isResellerScope)) ||
                (currentUser.role === UserRole.SUPPORT && (isRbac));

              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onNavigate(item.id);
                    setMobileOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                    isActive
                      ? "bg-gradient-to-r from-cyan-950 to-blue-950/60 text-cyan-400 border-l-2 border-cyan-500"
                      : "text-gray-400 hover:bg-gray-900/50 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <IconComp className={`h-4.5 w-4.5 ${isActive ? "text-cyan-400" : "text-gray-500 group-hover:text-gray-300"}`} />
                    <span>{item.label}</span>
                  </div>
                  {isRestricted ? (
                    <span className="text-[9px] px-1 bg-rose-950/40 text-rose-500 border border-rose-900/20 rounded">LOCK</span>
                  ) : (
                    <ChevronRight className="h-3 w-3 text-gray-600" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Footer info & current user */}
        <div className="p-4 border-t border-gray-900/60 bg-[#07090e]/80">
          <div className="flex items-center gap-3">
            <UserCircle2 className="h-8 w-8 text-cyan-500/80 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-white truncate">{currentUser.name}</p>
              <p className="text-[10px] text-gray-500 truncate font-mono">{currentUser.email}</p>
            </div>
          </div>
          
          <div className="mt-3 flex items-center justify-between text-[10px] font-semibold font-mono text-cyan-500 uppercase bg-cyan-950/20 px-2 py-1 rounded border border-cyan-900/20">
            <span>RÔLE ACTUEL :</span>
            <span className="font-extrabold">{currentUser.role}</span>
          </div>
        </div>
      </aside>

      {/* Main Content framing */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        {/* Top administration navbar */}
        <nav className="border-b border-gray-900/40 bg-[#0a0f18]/60 backdrop-blur-md p-4 flex justify-end items-center sticky top-0 z-30">
          <div className="flex items-center gap-4">
            {/* RBAC Simulator Selector Widget */}
            <div className="relative">
              <button
                onClick={() => setShowRoleSelector(!showRoleSelector)}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-bold bg-cyan-950 hover:bg-cyan-900/80 text-cyan-400 border border-cyan-800/40 rounded-lg cursor-pointer transition-all"
              >
                {loadingSim ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                <span>Simuler habilitation RBAC</span>
                <ChevronDown className="h-3 w-3" />
              </button>

              {showRoleSelector && (
                <div className="absolute right-0 mt-2 w-48 rounded-lg bg-gray-950 border border-gray-800 shadow-2xl overflow-hidden z-50">
                  <div className="p-2 border-b border-gray-900 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                    Changer de rôle (RBAC)
                  </div>
                  {Object.values(UserRole).map((role) => (
                    <button
                      key={role}
                      onClick={() => handleRoleSimulation(role)}
                      className={`w-full text-left px-3 py-2 text-xs font-semibold transition-all hover:bg-gray-900 cursor-pointer flex items-center justify-between ${
                        currentUser.role === role ? "text-cyan-400 bg-cyan-950/20" : "text-gray-400"
                      }`}
                    >
                      <span>{role}</span>
                      {currentUser.role === role && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Language visual indicator */}
            <span className="text-xs px-2.5 py-1 rounded bg-gray-900 border border-gray-800/80 text-gray-400 uppercase font-bold font-mono">
              {language === "fr" ? "FR 🇫🇷" : "EN 🇬🇧"}
            </span>
          </div>
        </nav>

        {/* View body */}
        <main className="p-6 md:p-8 flex-1 overflow-y-auto max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
