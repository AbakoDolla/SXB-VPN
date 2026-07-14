export default function ServersView({ currentUserRole }: { currentUserRole: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">Serveurs</h1>
      <p className="text-gray-400">Configuration des serveurs ({currentUserRole})</p>
    </div>
  );
}
