export default function XPanelView({ currentUserRole }: { currentUserRole: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">XPanel</h1>
      <p className="text-gray-400">Configuration XPanel ({currentUserRole})</p>
    </div>
  );
}
