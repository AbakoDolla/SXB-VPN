import { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchRoles, fetchPermissions, updateRolePermissions } from "../api/permissions";
import { RBACRole, AppPermission, UserRole } from "../types";
import { Shield, RefreshCw, Check, ShieldAlert, ChevronDown, ChevronUp, Lock } from "lucide-react";

interface RBACViewProps {
  currentUserRole: UserRole;
  onRolePermissionsUpdated: () => void;
}

const ROLE_STYLES: Record<string, { badge: string; bg: string; dot: string }> = {
  SUPER_ADMIN: { badge: "bg-rose-950/60 text-rose-300 border-rose-700/40",   bg: "bg-rose-500/10",   dot: "bg-rose-400" },
  ADMIN:       { badge: "bg-cyan-950/60 text-cyan-300 border-cyan-700/40",   bg: "bg-cyan-500/10",   dot: "bg-cyan-400" },
  SUPPORT:     { badge: "bg-blue-950/60 text-blue-300 border-blue-700/40",   bg: "bg-blue-500/10",   dot: "bg-blue-400" },
  RESELLER:    { badge: "bg-purple-950/60 text-purple-300 border-purple-700/40", bg: "bg-purple-500/10", dot: "bg-purple-400" },
};

function RolePill({ name }: { name: string }) {
  const s = ROLE_STYLES[name] ?? { badge: "bg-gray-900 text-gray-400 border-gray-800" };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold font-mono border ${s.badge}`}>
      {name.replace("_", " ")}
    </span>
  );
}

export default function RBACView({ currentUserRole, onRolePermissionsUpdated }: RBACViewProps) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<RBACRole[]>([]);
  const [permissions, setPermissions] = useState<AppPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;

  const loadRBAC = async () => {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([fetchRoles(), fetchPermissions()]);
      setRoles(r);
      setPermissions(p);
      const cats = Array.from(new Set(p.map(x => x.category)));
      const init: Record<string, boolean> = {};
      cats.forEach(c => { init[c] = true; });
      setExpandedCategories(init);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRBAC(); }, []);

  const handleTogglePermission = async (roleId: string, permCode: string, isCurrentlyChecked: boolean) => {
    if (!isAdmin) return;
    if (roleId === "role-admin" && (permCode === "rbac:write" || permCode === "rbac:read")) {
      alert("Sécurité : un administrateur ne peut pas révoquer ses propres droits RBAC.");
      return;
    }
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;
    const newPermissions = isCurrentlyChecked
      ? role.permissions.filter((p) => p !== permCode)
      : [...role.permissions, permCode];

    setSaving(`${roleId}-${permCode}`);
    try {
      await updateRolePermissions(roleId, newPermissions);
      const updatedRoles = await fetchRoles();
      setRoles(updatedRoles);
      onRolePermissionsUpdated();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("common.error_generic"));
    } finally {
      setSaving(null);
    }
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-400">
        <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm font-mono">{t("common.loading")}</p>
      </div>
    );
  }

  const categories = Array.from(new Set(permissions.map((p) => p.category)));

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2 flex-wrap">
            <Shield className="h-5 w-5 text-cyan-400 shrink-0" />
            {t("sidebar.rbac")}
          </h1>
          <p className="text-xs sm:text-sm text-gray-400 mt-1">
            Droits d'accès granulaires par niveau d'habilitation.
          </p>
        </div>
        <button
          onClick={loadRBAC}
          className="self-start sm:self-auto flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 border border-[#1a1f2e] text-gray-400 hover:text-white rounded-xl text-sm transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Actualiser
        </button>
      </div>

      {!isAdmin && (
        <div className="p-3 sm:p-4 border border-cyan-800/50 bg-cyan-950/20 text-cyan-300 rounded-xl text-xs flex gap-3 items-start">
          <ShieldAlert className="h-5 w-5 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Mode Lecture Seule</p>
            <p className="mt-0.5 text-cyan-400/70">Seul un Administrateur peut modifier la table RBAC.</p>
          </div>
        </div>
      )}

      {/* Role legend pills */}
      <div className="flex flex-wrap gap-2">
        {roles.map(r => <RolePill key={r.id} name={r.name} />)}
      </div>

      {/* ── MOBILE & TABLET: Card-based accordion ── */}
      <div className="xl:hidden space-y-2.5">
        {categories.map((category) => {
          const catPerms = permissions.filter(p => p.category === category);
          const isOpen = expandedCategories[category] ?? true;
          return (
            <div key={category} className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl overflow-hidden">
              {/* Category header */}
              <button
                onClick={() => toggleCategory(category)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-300">{category}</span>
                  <span className="text-[10px] text-gray-600 bg-white/5 px-1.5 py-0.5 rounded font-mono">{catPerms.length}</span>
                </div>
                {isOpen ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
              </button>

              {isOpen && (
                <div className="divide-y divide-[#1a1f2e]">
                  {catPerms.map(perm => (
                    <div key={perm.id} className="px-4 py-3 space-y-2.5">
                      {/* Permission info */}
                      <div>
                        <p className="text-sm font-medium text-white leading-tight">{perm.description}</p>
                        <code className="text-[10px] text-gray-500 font-mono">{perm.code}</code>
                      </div>
                      {/* Role toggles — responsive wrap */}
                      <div className="flex flex-wrap gap-1.5">
                        {roles.map(role => {
                          const isChecked = role.permissions.includes(perm.code);
                          const isSaving = saving === `${role.id}-${perm.code}`;
                          const s = ROLE_STYLES[role.name];
                          return (
                            <button
                              key={role.id}
                              disabled={!isAdmin || isSaving}
                              onClick={() => handleTogglePermission(role.id, perm.code, isChecked)}
                              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold font-mono transition-all select-none min-w-0 ${
                                isChecked
                                  ? (s?.badge || "bg-gray-800 text-gray-300 border-gray-700")
                                  : "bg-gray-900/30 text-gray-600 border-gray-800/50"
                              } ${!isAdmin ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:opacity-90"}`}
                            >
                              {isSaving
                                ? <RefreshCw className="w-3 h-3 animate-spin" />
                                : isChecked
                                ? <Check className="w-3 h-3" />
                                : <span className="w-3 h-3 inline-block rounded-sm border border-current opacity-40" />
                              }
                              {role.name.replace("_", " ")}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── DESKTOP XL: Full table matrix ── */}
      <div className="hidden xl:block border border-[#1a1f2e] rounded-2xl bg-[#0f1218] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1a1f2e] bg-black/20">
                <th className="py-3.5 px-5 text-xs text-gray-500 font-semibold uppercase tracking-wider w-2/5">Permission</th>
                <th className="py-3.5 px-4 text-xs text-gray-500 font-semibold uppercase tracking-wider">Code</th>
                {roles.map((r) => (
                  <th key={r.id} className="py-3.5 px-4 text-center">
                    <RolePill name={r.name} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-[#1a1f2e]/50">
              {categories.map((category) => {
                const catPerms = permissions.filter(p => p.category === category);
                return [
                  <tr key={`cat-${category}`}>
                    <td colSpan={2 + roles.length} className="py-2.5 px-5 text-[10px] font-bold uppercase tracking-widest text-gray-500 bg-black/20 border-y border-[#1a1f2e]">
                      {category}
                    </td>
                  </tr>,
                  ...catPerms.map(perm => (
                    <tr key={perm.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3.5 px-5 font-medium text-white text-sm">{perm.description}</td>
                      <td className="py-3.5 px-4 font-mono text-xs text-gray-500">{perm.code}</td>
                      {roles.map(role => {
                        const isChecked = role.permissions.includes(perm.code);
                        const isSaving = saving === `${role.id}-${perm.code}`;
                        return (
                          <td key={role.id} className="py-3.5 px-4 text-center">
                            {isSaving ? (
                              <RefreshCw className="w-4 h-4 text-gray-500 animate-spin mx-auto" />
                            ) : (
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={!isAdmin}
                                onChange={() => handleTogglePermission(role.id, perm.code, isChecked)}
                                className={`h-4 w-4 rounded text-cyan-500 focus:ring-cyan-500/30 bg-gray-900 border-gray-700 transition-all ${
                                  isAdmin ? "cursor-pointer" : "cursor-not-allowed opacity-40"
                                }`}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
