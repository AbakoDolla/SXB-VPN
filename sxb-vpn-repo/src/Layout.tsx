import { useState, useEffect } from 'react';
import { User, UserRole } from '../types';
import {
  LayoutDashboard, Users, Server, Shield, Key, Ticket, Smartphone,
  Settings, LogOut, UserCog, Terminal, Code2, Zap, Box, ShieldCheck, CreditCard,
  Menu, X, UserPlus, HeadphonesIcon, FileText, BadgePercent,
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
  onLogout,
}: LayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => { if (window.innerWidth >= 1024) setMobileNavOpen(false); };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileNavOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileNavOpen]);

  const navItems = [
    { id: 'dashboard',  label: 'Dashboard',           icon: LayoutDashboard,  roles: ['SUPER_ADMIN','ADMIN','SUPPORT','RESELLER'] },
    { id: 'clients',    label: 'Clients VPN',          icon: Users,            roles: ['SUPER_ADMIN','ADMIN','SUPPORT','RESELLER'] },
    { id: 'tokens',     label: 'Tokens SXB',           icon: Key,              roles: ['SUPER_ADMIN','ADMIN','SUPPORT','RESELLER'] },
    { id: 'devices',    label: 'Appareils',            icon: Smartphone,       roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'vouchers',   label: 'Vouchers',             icon: BadgePercent,     roles: ['SUPER_ADMIN','ADMIN','SUPPORT','RESELLER'] },
    { id: 'support',    label: 'Support',              icon: HeadphonesIcon,   roles: ['SUPER_ADMIN','ADMIN','SUPPORT'] },
    { id: 'resellers',  label: 'Revendeurs',           icon: UserCog,          roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'servers',    label: 'Serveurs',             icon: Server,           roles: ['SUPER_ADMIN','ADMIN','SUPPORT'] },
    { id: 'vpn-profiles',  label: 'Profils VPN',          icon: ShieldCheck,      roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'subscriptions', label: 'Abonnements',          icon: CreditCard,       roles: ['SUPER_ADMIN','ADMIN','SUPPORT'] },
    { id: 'ssh',       label: 'SSH Manager',          icon: Terminal,         roles: ['SUPER_ADMIN','ADMIN','SUPPORT'] },
    { id: 'payload',   label: 'Payload Manager',      icon: Code2,            roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'xray',      label: 'Xray Manager',         icon: Zap,              roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'singbox',   label: 'Sing-box Manager',     icon: Box,              roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'accounts',   label: 'Gestion des Comptes',  icon: UserPlus,         roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'rbac',       label: 'Rôles & Permissions',  icon: Shield,           roles: ['SUPER_ADMIN','ADMIN'] },
    { id: 'analytics',  label: 'Analytiques',          icon: FileText,         roles: ['SUPER_ADMIN','ADMIN','SUPPORT'] },
    { id: 'settings',   label: 'Paramètres',           icon: Settings,         roles: ['SUPER_ADMIN','ADMIN','SUPPORT','RESELLER'] },
  ];

  const filteredNav = navItems.filter(item => item.roles.includes(currentUser.role));

  function handleNavigate(route: string) {
    onNavigate(route);
    setMobileNavOpen(false);
  }

  const roleColors: Record<string, string> = {
    SUPER_ADMIN: 'text-red-400 bg-red-500/10',
    ADMIN:       'text-cyan-400 bg-cyan-500/10',
    SUPPORT:     'text-amber-400 bg-amber-500/10',
    RESELLER:    'text-violet-400 bg-violet-500/10',
  };

  const SidebarContent = ({ onClose }: { onClose?: () => void }) => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-5 border-b border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-3">
          <img src="/assets/images/logo_sxb_2026.png" alt="SXB VPN" className="w-8 h-8 rounded-lg object-contain shrink-0" />
          <div>
            <span className="text-white font-bold text-base">SXB VPN</span>
            <p className="text-[10px] text-gray-600 -mt-0.5">by StuffxBilal</p>
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2.5 space-y-0.5 overflow-y-auto">
        {filteredNav.map((item) => {
          const Icon = item.icon;
          const isActive = activeRoute === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 cursor-pointer ${
                isActive
                  ? 'bg-cyan-500/15 text-cyan-400 border-l-2 border-cyan-400 pl-[10px]'
                  : 'text-gray-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon className="w-4.5 h-4.5 shrink-0" />
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* User info */}
      <div className="p-3 border-t border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/5 transition-colors">
          {/* Avatar */}
          <div className="relative shrink-0">
            {(currentUser as any).avatarUrl ? (
              <img
                src={(currentUser as any).avatarUrl}
                alt={currentUser.name}
                className="w-9 h-9 rounded-full object-cover border border-gray-700"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
                <span className="text-white text-sm font-bold">
                  {currentUser.name?.charAt(0)?.toUpperCase() || '?'}
                </span>
              </div>
            )}
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#0a0d14]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-medium truncate">{currentUser.name}</p>
            <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${roleColors[currentUser.role] || 'text-gray-400 bg-gray-500/10'}`}>
              {currentUser.role}
            </span>
          </div>
          <button
            onClick={onLogout}
            title="Déconnexion"
            className="text-gray-600 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-[#07090e] text-white overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col bg-[#0a0d14] border-r border-[#1a1f2e]">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-[#0a0d14] border-r border-[#1a1f2e] z-50">
            <SidebarContent onClose={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center justify-between px-4 h-14 border-b border-[#1a1f2e] bg-[#0a0d14] shrink-0">
          <button onClick={() => setMobileNavOpen(true)} className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 cursor-pointer">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <img src="/assets/images/logo_sxb_2026.png" alt="SXB VPN" className="w-6 h-6 rounded object-contain" />
            <span className="text-white font-bold text-sm">SXB VPN</span>
          </div>
          <div className="w-8" />
        </div>

        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
