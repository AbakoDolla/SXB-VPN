export default function TokensView({ currentUserRole }: { currentUserRole: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">Tokens</h1>
      <p className="text-gray-400">Gestion des tokens ({currentUserRole})</p>
    </div>
  );
}
