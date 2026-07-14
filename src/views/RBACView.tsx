export default function RBACView({ currentUserRole, onRolePermissionsUpdated }: { currentUserRole: string; onRolePermissionsUpdated: () => void }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">RBAC</h1>
      <p className="text-gray-400">Gestion des rôles et permissions ({currentUserRole})</p>
    </div>
  );
}
