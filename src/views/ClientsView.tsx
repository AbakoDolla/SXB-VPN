export default function ClientsView({ currentUserRole, actorName }: { currentUserRole: string; actorName: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">Clients</h1>
      <p className="text-gray-400">Gestion des clients ({currentUserRole})</p>
    </div>
  );
}
