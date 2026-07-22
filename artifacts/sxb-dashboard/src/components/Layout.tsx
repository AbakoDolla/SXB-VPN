import { useState, useEffect } from 'react';
import { User, UserRole } from '../types';
import {
  LayoutDashboard, Users, Server, Shield, Key, Smartphone,
  Settings, LogOut, UserCog, Terminal, Code2, Zap, Box,
  Menu, X, UserPlus, HeadphonesIcon, BadgePercent, Activity,
  ChevronDown, Network, Radio, Cpu, BarChart3, Ticket,
  PackageOpen, GitBranch,
} from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeRoute: string;
  onNavigate: (route: string) => void;
  currentUser: User;
  onUserChanged: (user: User) => void;
  onLogout: () => void;
}

interface NavLeaf {
  kind: 'leaf';
  id: string;
  label: string;
  icon: any;
  roles: string[];
}

interface NavGroup {
  kind: 'group';
  id: string;
  label: string;
  icon: any;
  roles: string[];
  color: string;
  items: NavLeaf[];
}

type NavEntry = NavLeaf | NavGroup;

export default function Layout({
  children,
  activeRoute,
  onNavigate,
  currentUser,
  onLogout,
}: LayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    clients: true,
    vpnengine: false,
    monitoring: false,
    admin: false,
  });

  useEffect(() => {
    const handleResize = () => { if (window.innerWidth >= 1024) setMobileNavOpen(false); };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileNavOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileNavOpen]);

  // Auto-open group that contains the active route
  useEffect(() => {
    const groupMap: Record<string, string> = {
      clients: 'clients', devices: 'clients', tokens: 'clients', vouchers: 'clients',
      subscriptions: 'clients',
      'vpn-engine': 'vpnengine', xray: 'vpnengine', singbox: 'vpnengine', payload: 'vpnengine',
      'vpn-profiles': 'vpnengine',
      sessions: 'monitoring', analytics: 'monitoring', servers: 'monitoring', monitoring: 'monitoring',
      accounts: 'admin', resellers: 'admin', rbac: 'admin',
    };
    const group = groupMap[activeRoute];
    if (group) setOpenGroups(prev => ({ ...prev, [group]: true }));
  }, [activeRoute]);

  const role = currentUser.role;

  const navStructure: NavEntry[] = [
    {
      kind: 'leaf',
      id: 'dashboard',
      label: 'Dashboard',
      icon: LayoutDashboard,
      roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'],
    },
    {
      kind: 'group',
      id: 'clients',
      label: 'Clients',
      icon: Users,
      color: 'text-cyan-400',
      roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'],
      items: [
        { kind: 'leaf', id: 'clients', label: 'Clients VPN', icon: Users, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'] },
        { kind: 'leaf', id: 'subscriptions', label: 'Forfaits Data', icon: PackageOpen, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] },
        { kind: 'leaf', id: 'devices', label: 'Appareils', icon: Smartphone, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'tokens', label: 'Tokens SXB', icon: Key, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'] },
        { kind: 'leaf', id: 'vouchers', label: 'Vouchers', icon: BadgePercent, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'] },
      ],
    },
    {
      kind: 'group',
      id: 'vpnengine',
      label: 'VPN Engine',
      icon: Network,
      color: 'text-violet-400',
      roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'],
      items: [
        { kind: 'leaf', id: 'vpn-profiles', label: 'Profils VPN', icon: GitBranch, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'vpn-engine', label: 'SSH & Configs', icon: Terminal, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] },
        { kind: 'leaf', id: 'xray', label: 'Xray / Protocols', icon: Zap, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'singbox', label: 'Sing-box', icon: Box, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'payload', label: 'Payload Manager', icon: Code2, roles: ['SUPER_ADMIN', 'ADMIN'] },
      ],
    },
    {
      kind: 'group',
      id: 'monitoring',
      label: 'Monitoring',
      icon: Activity,
      color: 'text-emerald-400',
      roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'],
      items: [
        { kind: 'leaf', id: 'sessions', label: 'Sessions', icon: Radio, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'analytics', label: 'Logs & Activité', icon: BarChart3, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] },
        { kind: 'leaf', id: 'servers', label: 'Serveurs', icon: Server, roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] },
      ],
    },
    {
      kind: 'group',
      id: 'admin',
      label: 'Administration',
      icon: Shield,
      color: 'text-amber-400',
      roles: ['SUPER_ADMIN', 'ADMIN'],
      items: [
        { kind: 'leaf', id: 'accounts', label: 'Comptes', icon: UserPlus, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'resellers', label: 'Revendeurs', icon: UserCog, roles: ['SUPER_ADMIN', 'ADMIN'] },
        { kind: 'leaf', id: 'rbac', label: 'Rôles & Permissions', icon: Shield, roles: ['SUPER_ADMIN', 'ADMIN'] },
      ],
    },
    {
      kind: 'leaf',
      id: 'support',
      label: 'Support',
      icon: HeadphonesIcon,
      roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'],
    },
    {
      kind: 'leaf',
      id: 'settings',
      label: 'Paramètres',
      icon: Settings,
      roles: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'],
    },
  ];

  const filteredNav = navStructure.filter(entry => entry.roles.includes(role)).map(entry => {
    if (entry.kind === 'group') {
      return { ...entry, items: entry.items.filter(item => item.roles.includes(role)) };
    }
    return entry;
  }).filter(entry => entry.kind === 'leaf' || (entry.kind === 'group' && (entry as NavGroup).items.length > 0));

  function handleNavigate(route: string) {
    onNavigate(route);
    setMobileNavOpen(false);
  }

  function toggleGroup(groupId: string) {
    setOpenGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  }

  const roleColors: Record<string, string> = {
    SUPER_ADMIN: 'text-red-400 bg-red-500/10 border-red-500/20',
    ADMIN: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    SUPPORT: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    RESELLER: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  };

  const roleLabels: Record<string, string> = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN: 'Administrateur',
    SUPPORT: 'Support',
    RESELLER: 'Revendeur',
  };

  const isActive = (id: string) => activeRoute === id;
  const isGroupActive = (group: NavGroup) => group.items.some(item => item.id === activeRoute);

  const SidebarContent = ({ onClose }: { onClose?: () => void }) => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <img src="/assets/images/logo_sxb_2026.png" alt="SXB" className="w-5 h-5 object-contain" />
          </div>
          <div>
            <span className="text-white font-bold text-sm tracking-tight">SXB VPN</span>
            <div className="text-[10px] text-gray-500 leading-none">Control Panel</div>
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-500 hover:text-white p-1 rounded cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-[#1a1f2e]">
        {filteredNav.map(entry => {
          if (entry.kind === 'leaf') {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                onClick={() => handleNavigate(entry.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all text-left cursor-pointer ${
                  isActive(entry.id)
                    ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20'
                    : 'text-gray-400 hover:text-white hover:bg-white/5 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{entry.label}</span>
                {isActive(entry.id) && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-cyan-400" />}
              </button>
            );
          }

          const group = entry as NavGroup;
          const groupActive = isGroupActive(group);
          const isOpen = openGroups[group.id];
          const GroupIcon = group.icon;

          return (
            <div key={group.id}>
              <button
                onClick={() => toggleGroup(group.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                  groupActive
                    ? 'text-white bg-white/5'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                }`}
              >
                <GroupIcon className={`w-4 h-4 shrink-0 ${groupActive ? group.color : ''}`} />
                <span className="flex-1 text-left">{group.label}</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
              </button>

              {isOpen && (
                <div className="mt-0.5 ml-4 pl-2 border-l border-[#1a1f2e] space-y-0.5">
                  {group.items.map(item => {
                    const ItemIcon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleNavigate(item.id)}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all text-left cursor-pointer ${
                          isActive(item.id)
                            ? 'bg-cyan-500/15 text-cyan-400'
                            : 'text-gray-500 hover:text-gray-200 hover:bg-white/5'
                        }`}
                      >
                        <ItemIcon className="w-3.5 h-3.5 shrink-0" />
                        <span>{item.label}</span>
                        {isActive(item.id) && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-cyan-400" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="p-3 border-t border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-2.5 px-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center text-xs font-bold text-white shrink-0">
            {currentUser.name?.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white truncate">{currentUser.name}</p>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${roleColors[currentUser.role]}`}>
              {roleLabels[currentUser.role] || currentUser.role}
            </span>
          </div>
          <button
            onClick={onLogout}
            title="Déconnexion"
            className="text-gray-600 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-[#07090e] text-white overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-56 shrink-0 flex-col bg-[#0a0d14] border-r border-[#1a1f2e]">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-64 bg-[#0a0d14] border-r border-[#1a1f2e] z-50">
            <SidebarContent onClose={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center justify-between px-4 h-12 border-b border-[#1a1f2e] bg-[#0a0d14] shrink-0">
          <button onClick={() => setMobileNavOpen(true)} className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 cursor-pointer">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
              <img src="/assets/images/logo_sxb_2026.png" alt="SXB VPN" className="w-4 h-4 object-contain" />
            </div>
            <span className="text-white font-bold text-sm">SXB VPN</span>
          </div>
          <div className="w-8" />
        </div>

        <main className="flex-1 overflow-y-auto p-4 md:p-5 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
