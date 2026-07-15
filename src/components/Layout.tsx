import { useState } from 'react';
import { User, UserRole } from '../types';
import {
  LayoutDashboard, Users, Server, Shield, Key, Ticket,
  Settings, ChevronRight, LogOut, PanelsLeftRight, UserCog,
  Menu, X
} from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeRoute: string;
  onNavigate: (route: string) => void;
  currentUser: User;
  onUserChanged: (user: User) => void;
  onLogout: () => void;
}

export default function Layout({
  children,
  activeRoute,
  onNavigate,
  currentUser,
  onLogout
}: LayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['ADMIN', 'SUPPORT', 'RESELLER'] },
    { id: 'clients', label: 'Clients', icon: Users, roles: ['ADMIN', 'SUPPORT', 'RESELLER'] },
    { id: 'resellers', label: 'Revendeurs', icon: UserCog, roles: ['ADMIN'] },
    { id: 'servers', label: 'Serveurs', icon: Server, roles: ['ADMIN'] },
    { id: 'xpanel', label: 'XPanel', icon: PanelsLeftRight, roles: ['ADMIN'] },
    { id: 'tokens', label: 'Tokens', icon: Key, roles: ['ADMIN', 'RESELLER'] },
    { id: 'vouchers', label: 'Vouchers', icon: Ticket, roles: ['ADMIN', 'RESELLER'] },
    { id: 'rbac', label: 'RBAC', icon: Shield, roles: ['ADMIN'] },
    { id: 'settings', label: 'Paramètres', icon: Settings, roles: ['ADMIN'] },
  ];

  const filteredNav = navItems.filter(item => item.roles.includes(currentUser.role));

  function handleNavigate(route: string) {
    onNavigate(route);
    setMobileNavOpen(false); // ferme le tiroir après sélection sur mobile
  }

  const SidebarContent = () => (
    <>
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-6 border-b border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-3">
          <img 
            src="/assets/images/logo_shield_1784022646518.jpg" 
            alt="SXB VPN Logo" 
            className="w-8 h-8 rounded-lg object-contain shrink-0"
          />
          <span className="text-white font-bold">SXB VPN</span>
        </div>
        {/* Bouton fermer — visible seulement dans le tiroir mobile */}
        <button
          onClick={() => setMobileNavOpen(false)}
          className="lg:hidden text-gray-400 hover:text-white p-1"
          aria-label="Fermer le menu"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {filteredNav.map(item => {
          const Icon = item.icon;
          const isActive = activeRoute === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 lg:py-2 rounded-lg transition-colors ${isActive ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
            >
              <Icon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">{item.label}</span>
              {isActive && <ChevronRight className="w-4 h-4 ml-auto shrink-0" />}
            </button>
          );
        })}
      </nav>

      {/* User section */}
      <div className="p-4 border-t border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shrink-0">
            <span className="text-white font-semibold">
              {currentUser.name.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white font-medium truncate">{currentUser.name}</p>
            <p className="text-xs text-gray-500 truncate">{currentUser.role}</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Déconnexion
        </button>
      </div>
    </>
  );

  const activeLabel = filteredNav.find(i => i.id === activeRoute)?.label ?? 'SXB VPN';

  return (
    <div className="min-h-screen bg-[#07090e] flex">
      {/* ── Sidebar : toujours visible ── */}
      <aside className="w-64 bg-[#0a0d14] border-r border-[#1a1f2e] flex-col shrink-0">
        <SidebarContent />
      </aside>

      {/* ── Contenu principal ── */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* Topbar mobile — visible seulement sur mobile */}
        <header className="md:hidden h-14 flex items-center gap-3 px-4 border-b border-[#1a1f2e] bg-[#0a0d14]/95 backdrop-blur-sm sticky top-0 z-40 shrink-0">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="text-gray-300 hover:text-white p-1.5 -ml-1.5"
            aria-label="Ouvrir le menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="text-white font-semibold truncate">{activeLabel}</span>
        </header>

        {/* ── Tiroir mobile ── */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            {/* Fond assombri */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setMobileNavOpen(false)}
            />
            {/* Panneau du tiroir */}
            <aside className="absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-[#0a0d14] border-r border-[#1a1f2e] flex flex-col shadow-2xl">
              <SidebarContent />
            </aside>
          </div>
        )}

        <main className="flex-1 overflow-auto">
          <div className="p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
