import { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchRoles, fetchPermissions, updateRolePermissions } from "../api/permissions";
import { RBACRole, AppPermission, UserRole } from "../types";
import { Shield, RefreshCw, KeyRound, Check, ShieldAlert } from "lucide-react";

interface RBACViewProps {
  currentUserRole: UserRole;
  onRolePermissionsUpdated: () => void;
}

export default function RBACView({ currentUserRole, onRolePermissionsUpdated }: RBACViewProps) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<RBACRole[]>([]);
  const [permissions, setPermissions] = useState<AppPermission[]>([]);
  const [loading, setLoading] = useState(true);

  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;

  const loadRBAC = async () => {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([fetchRoles(), fetchPermissions()]);
      setRoles(r);
      setPermissions(p);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRBAC();
  }, []);

  const handleTogglePermission = async (roleId: string, permCode: string, isCurrentlyChecked: boolean) => {
    if (!isAdmin) return;
    
    // Prevent locking Admin out of their own critical scopes
    if (roleId === "role-admin" && (permCode === "rbac:write" || permCode === "rbac:read")) {
      alert("Interdiction de sécurité : L'administrateur système ne peut pas révoquer ses propres permissions d'administration RBAC !");
      return;
    }

    const role = roles.find((r) => r.id === roleId);
    if (!role) return;

    let newPermissions: string[];
    if (isCurrentlyChecked) {
      newPermissions = role.permissions.filter((p) => p !== permCode);
    } else {
      newPermissions = [...role.permissions, permCode];
    }

    try {
      await updateRolePermissions(roleId, newPermissions);
      // Reload lists
      const updatedRoles = await fetchRoles();
      setRoles(updatedRoles);
      onRolePermissionsUpdated(); // Notify parent layout to refresh auth rules
    } catch (err) {
      alert(err instanceof Error ? err.message : t("common.error_generic"));
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
        <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm font-mono">{t("common.loading")}</p>
      </div>
    );
  }

  // Group permissions by category
  const categories = Array.from(new Set(permissions.map((p) => p.category)));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          <Shield className="h-6 w-6 text-cyan-400" />
          {t("sidebar.rbac")} (Contrôle d'Habilitations)
        </h1>
        <p className="text-sm text-gray-400 mt-1">Configurez les droits d'accès granulaires de chaque niveau d'habilitation (Admin, Support, Revendeur) de la plateforme.</p>
      </div>

      {!isAdmin && (
        <div className="p-4 border border-cyan-800 bg-cyan-950/20 text-cyan-300 rounded-lg text-xs leading-relaxed flex gap-3 items-start">
          <ShieldAlert className="h-5 w-5 text-cyan-400 shrink-0" />
          <div>
            <p className="font-bold">Mode Lecture Seule Actif</p>
            <p className="mt-0.5">Seul un Administrateur système peut modifier la table de vérité RBAC ci-dessous.</p>
          </div>
        </div>
      )}

      {/* RBAC Grid Matrix */}
      <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                <th className="py-4 px-6 w-1/3">Permission & Catégorie</th>
                <th className="py-4 px-6 w-1/3">Code Technique</th>
                {roles.map((r) => (
                  <th key={r.id} className="py-4 px-6 text-center">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold font-mono border ${
                      r.name === UserRole.SUPER_ADMIN
                        ? "bg-rose-950 text-rose-400 border-rose-800/40"
                        : r.name === UserRole.ADMIN 
                        ? "bg-cyan-950 text-cyan-400 border-cyan-800/40" 
                        : r.name === UserRole.SUPPORT
                        ? "bg-blue-950 text-blue-400 border-blue-800/40"
                        : "bg-purple-950 text-purple-400 border-purple-800/40"
                    }`}>
                      {r.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-900 text-sm">
              {categories.map((category) => {
                const catPermissions = permissions.filter((p) => p.category === category);
                
                return (
                  <tr key={category} className="bg-gray-900/10">
                    <td colSpan={2 + roles.length} className="py-3 px-6 text-xs font-bold uppercase tracking-wider text-gray-500 bg-gray-900/20">
                      {category}
                    </td>
                  </tr>
                );
              })}

              {categories.map((category) => {
                const catPermissions = permissions.filter((p) => p.category === category);
                
                return catPermissions.map((perm) => (
                  <tr key={perm.id} className="hover:bg-gray-900/10 transition-colors">
                    <td className="py-3.5 px-6 font-medium text-white">
                      <div>{perm.description}</div>
                    </td>
                    <td className="py-3.5 px-6 font-mono text-xs text-gray-500">
                      {perm.code}
                    </td>
                    
                    {roles.map((role) => {
                      const isChecked = role.permissions.includes(perm.code);
                      return (
                        <td key={role.id} className="py-3.5 px-6 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={!isAdmin}
                            onChange={() => handleTogglePermission(role.id, perm.code, isChecked)}
                            className={`h-4.5 w-4.5 rounded text-cyan-500 focus:ring-cyan-500/30 bg-gray-900 border-gray-800 transition-all ${
                              isAdmin ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                            }`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
