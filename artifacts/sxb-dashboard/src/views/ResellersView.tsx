export default function ResellersView({ currentUserRole, actorName }: { currentUserRole: string; actorName: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white">Revendeurs</h1>
        <p className="text-gray-400 text-sm mt-1">Gestion des revendeurs ({currentUserRole})</p>
      </div>
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 sm:p-6">
        <p className="text-gray-500">Aucun revendeur pour le moment</p>
      </div>
    </div>
  );
}
