import { useTranslation } from '../contexts/I18nContext';

interface Props {
  onNavigate: (route: string) => void;
}

export default function DashboardView({ onNavigate }: Props) {
  const { t } = useTranslation();
  
  const stats = [
    { label: 'Total Clients', value: '0', color: 'cyan' },
    { label: 'Total Tokens', value: '0', color: 'emerald' },
    { label: 'Serveurs Actifs', value: '0', color: 'amber' },
    { label: 'Revenus Mensuels', value: '0€', color: 'violet' },
  ];
  
  const colorClasses = {
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    violet: 'text-violet-400',
  };
  
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-400 text-sm mt-1">Vue d'ensemble de votre infrastructure VPN</p>
      </div>
      
      {/* Stats Grid: 1 col mobile, 2 cols tablet, 4 cols desktop */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {stats.map((stat, index) => (
          <div 
            key={index} 
            className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 sm:p-6 hover:border-[#2a3042] transition-colors"
          >
            <p className="text-gray-400 text-sm truncate">{stat.label}</p>
            <p className={`text-2xl sm:text-3xl font-bold mt-2 ${colorClasses[stat.color as keyof typeof colorClasses]}`}>
              {stat.value}
            </p>
          </div>
        ))}
      </div>
      
      {/* Quick Actions / Recent Activity placeholder */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Activité Récente</h2>
          <p className="text-gray-500 text-sm">Aucune activité récente</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Actions Rapides</h2>
          <div className="grid grid-cols-2 gap-3">
            <button 
              onClick={() => onNavigate('clients')}
              className="px-4 py-2.5 bg-cyan-500/10 text-cyan-400 rounded-lg hover:bg-cyan-500/20 transition-colors text-sm font-medium"
            >
              + Nouveau Client
            </button>
            <button 
              onClick={() => onNavigate('vouchers')}
              className="px-4 py-2.5 bg-emerald-500/10 text-emerald-400 rounded-lg hover:bg-emerald-500/20 transition-colors text-sm font-medium"
            >
              + Nouveau Voucher
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
