export default function RBACView({ currentUserRole, onRolePermissionsUpdated }: { currentUserRole: string; onRolePermissionsUpdated: () => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white">RBAC</h1>
        <p className="text-gray-400 text-sm mt-1">Gestion des rôles et permissions ({currentUserRole})</p>
      </div>
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 sm:p-6">
        <p className="text-gray-500">Configuration des rôles et permissions</p>
      </div>
    </div>
  );
}
