export default function ResellersView({ currentUserRole, actorName }: { currentUserRole: string; actorName: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">Revendeurs</h1>
      <p className="text-gray-400">Gestion des revendeurs ({currentUserRole})</p>
    </div>
  );
}
