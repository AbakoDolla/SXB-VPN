import { User, UserRole } from '../types';
import {
  LayoutDashboard, Users, Server, Shield, Key, Ticket,
  Settings, ChevronRight, LogOut, RefreshCw, PanelsLeftRight, UserCog
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
  onUserChanged,
  onLogout
}: LayoutProps) {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['ADMIN', 'SUPPORT', 'RESELLER'] },
    { id: 'clients', label: 'Clients', icon: Users, roles: ['ADMIN', 'SUPPORT', 'RESELLER'] },
    { id: 'resellers', label: 'Revendeurs', icon: UserCog, roles: ['ADMIN'] },
    { id: 'servers', label: 'Serveurs', icon: Server, roles: ['ADMIN'] },
    { id: 'xpanel', label: 'PanelsLeftRight', icon: PanelsLeftRight, roles: ['ADMIN'] },
    { id: 'tokens', label: 'Tokens', icon: Key, roles: ['ADMIN', 'RESELLER'] },
    { id: 'vouchers', label: 'Vouchers', icon: Ticket, roles: ['ADMIN', 'RESELLER'] },
    { id: 'rbac', label: 'RBAC', icon: Shield, roles: ['ADMIN'] },
    { id: 'settings', label: 'Paramètres', icon: Settings, roles: ['ADMIN'] },
  ];

  const filteredNav = navItems.filter(item => item.roles.includes(currentUser.role));

  return (
    <div className="min-h-screen bg-[#07090e] flex">
      {/* Sidebar */}
      <aside className="w-64 bg-[#0a0d14] border-r border-[#1a1f2e] flex flex-col">
        {/* Logo */}
        <div className="h-16 flex items-center px-6 border-b border-[#1a1f2e]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <span className="text-white font-bold">SXB VPN</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {filteredNav.map(item => {
            const Icon = item.icon;
            const isActive = activeRoute === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
                {isActive && <ChevronRight className="w-4 h-4 ml-auto" />}
              </button>
            );
          })}
        </nav>

        {/* User section */}
        <div className="p-4 border-t border-[#1a1f2e]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
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
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
