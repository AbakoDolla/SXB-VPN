import { useTranslation } from '../contexts/I18nContext';

interface Props {
  onNavigate: (route: string) => void;
}

export default function DashboardView({ onNavigate }: Props) {
  const { t } = useTranslation();
  
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-6">
          <p className="text-gray-400 text-sm">Total Clients</p>
          <p className="text-3xl font-bold text-cyan-400 mt-2">0</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-6">
          <p className="text-gray-400 text-sm">Total Tokens</p>
          <p className="text-3xl font-bold text-emerald-400 mt-2">0</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-6">
          <p className="text-gray-400 text-sm">Serveurs Actifs</p>
          <p className="text-3xl font-bold text-amber-400 mt-2">0</p>
        </div>
      </div>
    </div>
  );
}
