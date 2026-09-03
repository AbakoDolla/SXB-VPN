import React, { useState, useEffect } from 'react';
import { User, UserRole } from '../types';
import { useTranslation } from '../contexts/I18nContext';
import {
  LayoutDashboard, Users, Server, Shield, Key, Smartphone,
  Settings, LogOut, UserCog, Terminal, Code2, Zap, Box,
  Menu, X, UserPlus, HeadphonesIcon, BadgePercent, Activity,
  ChevronDown, Network, Radio, Cpu, BarChart3, Ticket,
  PackageOpen, GitBranch, ScrollText, BellRing, Download,
} from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeRoute: string;
  onNavigate: (route: string) => void;
  currentUser: User;
  onUserChanged: (user: User) => void;
  onLogout: () => void;
  maintenanceEnabled?: boolean;
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
  maintenanceEnabled = false,
}: LayoutProps) {
  const { t } = useTranslation();
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
      'vpn-profiles': 'vpnengine', announcements: 'admin',
      sessions: 'monitoring', analytics: 'monitoring', servers: 'monitoring', monitoring: 'monitoring',
      accounts: 'admin', resellers: 'admin', rbac: 'admin', 'app-updates': 'admin',
    };
    const group = groupMap[activeRoute];
    if (group) setOpenGroups(prev => ({ ...prev, [group]: true }));
  }, [activeRoute]);

  const role = currentUser.role;

  const ALL_ROLES = ['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'];
  // Rôles internes : tout ce qui touche à l'infrastructure, aux autres
  // revendeurs ou à la configuration du système leur est réservé.
  const STAFF = ['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  const ADMINS = ['OWNER', 'SUPER_ADMIN', 'ADMIN'];

  const navStructure: NavEntry[] = [
    {
      kind: 'leaf',
      id: 'dashboard',
      label: t('sidebar.dashboard'),
      icon: LayoutDashboard,
      roles: ALL_ROLES,
    },
    {
      kind: 'group',
      id: 'clients',
      label: t('sidebar.clients'),
      icon: Users,
      color: 'text-cyan-400',
      roles: ALL_ROLES,
      items: [
        { kind: 'leaf', id: 'clients', label: t('sidebar.vpn_accounts'), icon: Users, roles: ALL_ROLES },
        { kind: 'leaf', id: 'subscriptions', label: t('sidebar.subscriptions'), icon: PackageOpen, roles: ALL_ROLES },
        // Le revendeur doit suivre les appareils de SES clients : c'est là
        // qu'il constate une activation ou une consommation anormale.
        { kind: 'leaf', id: 'devices', label: t('sidebar.devices'), icon: Smartphone, roles: ALL_ROLES },
        { kind: 'leaf', id: 'tokens', label: t('sidebar.tokens'), icon: Key, roles: ALL_ROLES },
        { kind: 'leaf', id: 'vouchers', label: t('sidebar.vouchers'), icon: BadgePercent, roles: ALL_ROLES },
      ],
    },
    // Configurations techniques : jamais pour un revendeur. Il dispose à la
    // place de « Services VPN disponibles », qui n'expose que les noms
    // commerciaux des configurations qui lui sont attribuées.
    {
      kind: 'leaf',
      id: 'vpn-profiles',
      label: t('sidebar.configurations'),
      icon: GitBranch,
      roles: STAFF,
    },
    {
      kind: 'leaf',
      id: 'reseller-services',
      label: 'Services VPN disponibles',
      icon: GitBranch,
      roles: ['RESELLER'],
    },
    {
      kind: 'group',
      id: 'monitoring',
      label: t('sidebar.monitoring'),
      icon: Activity,
      color: 'text-emerald-400',
      roles: STAFF,
      items: [
        { kind: 'leaf', id: 'sessions', label: t('sidebar.sessions'), icon: Radio, roles: ADMINS },
        { kind: 'leaf', id: 'analytics', label: t('sidebar.analytics'), icon: BarChart3, roles: STAFF },
        { kind: 'leaf', id: 'servers', label: t('sidebar.servers'), icon: Server, roles: STAFF },
      ],
    },
    {
      kind: 'group',
      id: 'admin',
      label: t('sidebar.admin'),
      icon: Shield,
      color: 'text-amber-400',
      // Le revendeur y figurait pour la seule entrée « Mises à jour de l'app »,
      // ce qui lui affichait un menu « Administration ». Un revendeur ne doit
      // voir aucun panneau d'administration.
      roles: STAFF,
      items: [
        { kind: 'leaf', id: 'accounts', label: t('sidebar.accounts'), icon: UserPlus, roles: ADMINS },
        { kind: 'leaf', id: 'resellers', label: t('sidebar.resellers'), icon: UserCog, roles: ADMINS },
        { kind: 'leaf', id: 'rbac', label: t('sidebar.rbac'), icon: Shield, roles: ADMINS },
        { kind: 'leaf', id: 'announcements', label: t('sidebar.annonces'), icon: BellRing, roles: STAFF },
        { kind: 'leaf', id: 'app-updates', label: t('sidebar.app_updates'), icon: Download, roles: STAFF },
      ],
    },
    {
      kind: 'leaf',
      id: 'support',
      label: t('sidebar.support'),
      icon: HeadphonesIcon,
      // Ouvrir un ticket fait partie des actions attendues d'un revendeur.
      roles: ALL_ROLES,
    },
    {
      kind: 'leaf',
      id: 'settings',
      label: t('sidebar.settings'),
      icon: Settings,
      // Profil et préférences ; la création de comptes reste hors de portée
      // (l'onglet Équipe renvoie vers la page Comptes, réservée aux admins).
      roles: ALL_ROLES,
    },
    // ── Rôle racine OWNER uniquement ─────────────────────────────────────────
    {
      kind: 'leaf',
      id: 'owner-log',
      label: 'Journal propriétaire',
      icon: ScrollText,
      roles: ['OWNER'],
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
    OWNER: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
    SUPER_ADMIN: 'text-red-400 bg-red-500/10 border-red-500/20',
    ADMIN: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    SUPPORT: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    RESELLER: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  };

  const roleLabels: Record<string, string> = {
    OWNER: t('role_owner') || 'Propriétaire',
    SUPER_ADMIN: t('role_super_admin') || 'Super Admin',
    ADMIN: t('admin'),
    SUPPORT: t('support'),
    RESELLER: t('reseller'),
  };

  const isActive = (id: string) => activeRoute === id;
  const isGroupActive = (group: NavGroup) => group.items.some(item => item.id === activeRoute);

  const SidebarContent = ({ onClose }: { onClose?: () => void }) => (
    <div className="flex flex-col h-full dashboard-sidebar">
      {/* Logo */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-[#1a1f2e] shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <img src="/assets/images/logo_sxb_2026.png" alt="SXB" className="w-5 h-5 object-contain" />
          </div>
          <div>
            <span className="text-white font-bold text-sm tracking-tight">SXB VPN</span>
            <div className="text-[10px] text-gray-500 leading-none">{t('control_panel')}</div>
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
            title={t('logout')}
            className="text-gray-600 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen dashboard-shell text-white overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-56 shrink-0 flex-col dashboard-sidebar border-r border-[#1a1f2e]">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-64 dashboard-sidebar border-r border-[#1a1f2e] z-50">
            <SidebarContent onClose={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="lg:hidden dashboard-topbar flex items-center justify-between px-4 h-12 border-b border-[#1a1f2e] shrink-0">
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

        <main className="flex-1 overflow-y-auto p-4 md:p-5 lg:p-6 animate-fadeIn">
          {/* Bannière persistante « MODE MAINTENANCE ACTIF » — OWNER uniquement */}
          {maintenanceEnabled && role === 'OWNER' && (
            <div className="mb-4 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-300 text-xs font-bold tracking-widest uppercase">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
              </span>
              {t('maintenance_active')}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
