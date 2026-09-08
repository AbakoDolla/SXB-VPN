import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchRoles, fetchPermissions, updateRolePermissions } from "../api/permissions";
import { RBACRole, AppPermission, UserRole } from "../types";
import { isOwner as isOwnerRole } from "../lib/roles";
import { Shield, RefreshCw, Check, ShieldAlert, AlertTriangle, X, Lock } from "lucide-react";

interface RBACViewProps {
  currentUserRole: UserRole;
  onRolePermissionsUpdated: () => void;
}

/**
 * Permissions accordées à chaque rôle.
 *
 * Deux principes tiennent cet écran :
 *
 *   1. L'AUTORISATION EST SERVEUR. `PATCH /api/rbac/roles/:id` n'accepte que
 *      SUPER_ADMIN (et OWNER, par le point unique de contournement). Ce que
 *      l'interface désactive n'est qu'un confort : elle ne protège rien seule,
 *      et elle ne doit surtout pas être PLUS permissive que le serveur.
 *
 *   2. AUCUNE ÉLÉVATION DE PRIVILÈGE. Trois garde-fous sont posés ici :
 *      — le rôle OWNER n'est pas modifiable : il contourne les permissions,
 *        les cocher ou les décocher ne changerait rien et laisserait croire
 *        le contraire ;
 *      — SUPER_ADMIN ne peut pas se retirer l'administration RBAC, sans quoi
 *        plus personne ne pourrait la rétablir ;
 *      — accorder une permission sensible à un rôle subalterne exige une
 *        confirmation nommée, et non un clic sur une case au milieu de
 *        soixante autres.
 */

/** Permissions qui donnent barre sur la plateforme, les comptes ou l'argent. */
const DANGEROUS_PERMISSIONS = [
  "rbac", "users.create", "users.delete", "reseller.manage", "vpnprofile.manage",
  "clients.manage", "subscription.manage", "tokens.create", "server.manage",
  "maintenance", "owner",
];

/** Rôles subalternes : leur accorder une permission sensible est une décision. */
const SUBORDINATE_ROLES = [UserRole.SUPPORT, UserRole.RESELLER, "CLIENT", "USER"];

function isDangerous(code: string): boolean {
  const normalized = code.toLowerCase();
  return DANGEROUS_PERMISSIONS.some((needle) => normalized.startsWith(needle) || normalized.includes(`:${needle}`));
}

const ROLE_BADGES: Record<string, string> = {
  OWNER: "bg-rose-950 text-rose-300 border-rose-800/50",
  SUPER_ADMIN: "bg-rose-950 text-rose-400 border-rose-800/40",
  ADMIN: "bg-cyan-950 text-cyan-400 border-cyan-800/40",
  SUPPORT: "bg-blue-950 text-blue-400 border-blue-800/40",
  RESELLER: "bg-purple-950 text-purple-400 border-purple-800/40",
};

export default function RBACView({ currentUserRole, onRolePermissionsUpdated }: RBACViewProps) {
  const { t, formatNumber, errorMessage } = useTranslation();
  const [roles, setRoles] = useState<RBACRole[]>([]);
  const [permissions, setPermissions] = useState<AppPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    { roleId: string; roleName: string; permCode: string; granting: boolean } | null
  >(null);

  // Le serveur n'accepte que SUPER_ADMIN, et OWNER par contournement unique.
  // ADMIN garde une vue complète, en lecture seule.
  const canEdit = isOwnerRole(currentUserRole) || currentUserRole === UserRole.SUPER_ADMIN;
  const permissionLabel = (code: string) => {
    const key = `commerce.rbac.permissions.${code}`;
    const label = t(key);
    return label === key ? permissions.find(permission => permission.code === code)?.description || code : label;
  };
  const categoryLabel = (category: string) => {
    const key = `commerce.rbac.categories.${category}`;
    const label = t(key);
    return label === key ? category : label;
  };

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

  useEffect(() => { loadRBAC(); }, []);

  /** Le rôle OWNER contourne les permissions : sa ligne reste en lecture seule. */
  const isRoleLocked = (roleName: string) => roleName === UserRole.OWNER;

  /**
   * Un basculement retirerait-il à SUPER_ADMIN sa capacité à administrer le
   * RBAC ? Si oui, plus personne ne pourrait la lui rendre.
   */
  const wouldLockOutRbac = (roleName: string, permCode: string, granting: boolean) =>
    !granting && roleName === UserRole.SUPER_ADMIN && permCode.toLowerCase().startsWith("rbac");

  const applyToggle = async (roleId: string, permCode: string, granting: boolean) => {
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;
    const next = granting
      ? Array.from(new Set([...role.permissions, permCode]))
      : role.permissions.filter((p) => p !== permCode);

    setSaving(`${roleId}:${permCode}`);
    try {
      await updateRolePermissions(roleId, next);
      // On relit le serveur plutôt que de croire l'état local : lui seul dit
      // ce qui a réellement été enregistré.
      setRoles(await fetchRoles());
      onRolePermissionsUpdated();
    } catch (err) {
      window.alert(errorMessage(err, 'commerce.common.errorGeneric'));
    } finally {
      setSaving(null);
    }
  };

  const handleTogglePermission = (roleId: string, permCode: string, isChecked: boolean) => {
    if (!canEdit) return;
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;
    const granting = !isChecked;

    if (isRoleLocked(String(role.name))) {
      window.alert(
        t('commerce.rbac.ownerLocked')
      );
      return;
    }

    if (wouldLockOutRbac(String(role.name), permCode, granting)) {
      window.alert(
        t('commerce.rbac.preventLockout')
      );
      return;
    }

    // Une permission sensible accordée à un rôle subalterne se confirme.
    const sensitive = isDangerous(permCode) && (granting || SUBORDINATE_ROLES.includes(role.name as UserRole));
    if (sensitive) {
      setConfirmation({
        roleId,
        roleName: String(role.name),
        permCode,
        granting,
      });
      return;
    }

    applyToggle(roleId, permCode, granting);
  };

  const categories = useMemo(
    () => Array.from(new Set(permissions.map((p) => p.category))).sort(),
    [permissions]
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
        <RefreshCw className="mb-4 h-7 w-7 animate-spin text-cyan-400" />
        <p className="font-mono text-sm">{t('commerce.common.loading')}</p>
      </div>
    );
  }

  const PermissionCheckbox = ({
    role, perm, checked,
  }: { role: RBACRole; perm: AppPermission; checked: boolean }) => {
    const locked = isRoleLocked(String(role.name));
    const disabled = !canEdit || locked || saving === `${role.id}:${perm.code}`;
    return (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={t('commerce.rbac.checkbox', { permission: perm.code, role: String(role.name) })}
        onChange={() => handleTogglePermission(role.id, perm.code, checked)}
        className={`h-4 w-4 rounded border-gray-800 bg-gray-900 text-cyan-500 transition-all focus:ring-cyan-500/30 ${
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        }`}
      />
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-white">
          <Shield className="h-5 w-5 text-cyan-400" />
          {t('commerce.rbac.title')}
        </h2>
        <p className="mt-1 text-sm text-gray-400">
          {t('commerce.rbac.subtitle')}
        </p>
      </div>

      {!canEdit && (
        <div className="flex items-start gap-3 rounded-lg border border-cyan-800 bg-cyan-950/20 p-4 text-xs leading-relaxed text-cyan-300">
          <ShieldAlert className="h-5 w-5 shrink-0 text-cyan-400" />
          <div>
            <p className="font-bold">{t('commerce.rbac.readOnly')}</p>
            <p className="mt-0.5">
              {t('commerce.rbac.readOnlyHint')}
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">
          <AlertTriangle className="h-3 w-3" /> {t('commerce.rbac.sensitive')}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-900/60 px-2 py-0.5">
          <Lock className="h-3 w-3" /> {t('commerce.rbac.lockedRole')}
        </span>
      </div>

      {/* ── Grand écran : matrice complète ─────────────────────────────────── */}
      <div className="hidden overflow-hidden rounded-2xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md lg:block dashboard-card">
        <div className="overflow-x-auto overscroll-x-contain">
          <div className="min-w-[780px]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  <th className="w-1/3 px-6 py-4">{t('commerce.rbac.permissionCategory')}</th>
                  <th className="w-1/4 px-6 py-4">{t('commerce.rbac.code')}</th>
                  {roles.map((r) => (
                    <th key={r.id} className="px-6 py-4 text-center">
                      <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-xs font-bold ${
                        ROLE_BADGES[String(r.name)] || "border-gray-700 bg-gray-900 text-gray-300"
                      }`}>
                        {isRoleLocked(String(r.name)) && <Lock className="h-3 w-3" />}
                        {r.name}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {categories.map((category) => (
                  <Fragment key={category}>
                    <tr className="bg-gray-900/20">
                      <td
                        colSpan={2 + roles.length}
                        className="px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500"
                      >
                        {categoryLabel(category)}
                      </td>
                    </tr>
                    {permissions.filter((p) => p.category === category).map((perm) => (
                      <tr key={perm.id} className="transition-colors hover:bg-gray-900/10">
                        <td className="px-6 py-3.5 font-medium text-white">
                          <div className="flex items-center gap-2">
                            {isDangerous(perm.code) && (
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-label={t('commerce.rbac.sensitive')} />
                            )}
                            <span>{permissionLabel(perm.code)}</span>
                          </div>
                        </td>
                        <td className="px-6 py-3.5 font-mono text-xs text-gray-500">{perm.code}</td>
                        {roles.map((role) => (
                          <td key={role.id} className="px-6 py-3.5 text-center">
                            <PermissionCheckbox
                              role={role}
                              perm={perm}
                              checked={role.permissions.includes(perm.code)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Petit écran : une carte par rôle ───────────────────────────────── */}
      <div className="space-y-4 lg:hidden">
        {roles.map((role) => (
          <details key={role.id} className="overflow-hidden rounded-2xl border border-gray-800/80 bg-gray-950/30">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3">
              <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-xs font-bold ${
                ROLE_BADGES[String(role.name)] || "border-gray-700 bg-gray-900 text-gray-300"
              }`}>
                {isRoleLocked(String(role.name)) && <Lock className="h-3 w-3" />}
                {role.name}
              </span>
              <span className="text-xs text-gray-500">{t('commerce.rbac.permissionCount', { count: formatNumber(role.permissions.length) })}</span>
            </summary>
            <div className="divide-y divide-gray-900 border-t border-gray-800/80">
              {permissions.map((perm) => (
                <label key={`${role.id}-${perm.id}`} className="flex items-start justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm text-white">
                      {isDangerous(perm.code) && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
                      {permissionLabel(perm.code)}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-gray-500">{perm.code}</span>
                  </span>
                  <PermissionCheckbox role={role} perm={perm} checked={role.permissions.includes(perm.code)} />
                </label>
              ))}
            </div>
          </details>
        ))}
      </div>

      {/* Confirmation nommée pour un changement sensible */}
      {confirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-[#252b3b] bg-[#0f1218] p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <h3 className="flex items-center gap-2 text-base font-semibold text-white">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                {t('commerce.rbac.confirmSensitive')}
              </h3>
              <button onClick={() => setConfirmation(null)} className="text-gray-500 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2 text-sm text-gray-300">
              <p>
                <span className="text-gray-500">{t('commerce.rbac.roleLabel')}</span> {confirmation.roleName}
              </p>
              <p>
                <span className="text-gray-500">{t('commerce.rbac.permissionLabel')}</span> {permissionLabel(confirmation.permCode)}{" "}
                <span className="font-mono text-xs text-gray-500">({confirmation.permCode})</span>
              </p>
              <p className={confirmation.granting ? "text-rose-300" : "text-amber-300"}>
                {confirmation.granting
                  ? t('commerce.rbac.grantHint')
                  : t('commerce.rbac.removeHint')}
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmation(null)}
                className="rounded-lg border border-[#1a1f2e] px-3 py-2 text-xs text-gray-300 hover:bg-white/5"
              >
                {t('commerce.common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = confirmation;
                  setConfirmation(null);
                  applyToggle(pending.roleId, pending.permCode, pending.granting);
                }}
                className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-2 text-xs font-semibold text-black hover:bg-cyan-400"
              >
                <Check className="h-3.5 w-3.5" />
                {confirmation.granting ? t('commerce.rbac.grant') : t('commerce.rbac.remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
