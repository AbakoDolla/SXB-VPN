import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { toast } from "sonner";
import {
  createReseller,
  deleteReseller,
  fetchResellerQuotaHistory,
  fetchResellers,
  renewResellerAccess,
  updateReseller,
} from "../api/resellers";
import { fetchVpnProfiles, VpnProfile } from "../api/vpn-profiles";
import { isAdmin as isAdminRole } from "../lib/roles";
import { Reseller, ResellerQuotaMovement, UserRole } from "../types";
import {
  ACCESS_BADGES,
  ACCESS_LABELS,
  QUOTA_BADGES,
  QUOTA_LABELS,
  daysUntil,
  defaultExpiryInput,
  formatBytes,
  formatDate,
  isFutureExpiry,
  minExpiryInput,
  percentOf,
  toIsoExpiry,
} from "../lib/resellerAccess";
import {
  CalendarClock, Coins, GitBranch, History, Landmark, RefreshCw, Search,
  ShieldCheck, Trash2, UserCheck, UserPlus, X,
} from "lucide-react";

interface ResellersViewProps {
  currentUserRole: UserRole;
  actorName: string;
}

/**
 * Revendeurs — agréments, échéances et plafonds.
 *
 * Trois notions y sont tenues séparées, parce que les confondre est ce qui
 * rendait l'écran illisible :
 *
 *   VALIDITÉ (`accessState`)  jusqu'à quand le revendeur a le droit d'agir.
 *   PLAFOND  (`quotaState`)   combien de volume il peut encore engager.
 *   ENGAGÉ / CONSOMMÉ         ce qu'il a distribué à ses clients, et ce que
 *                             ceux-ci ont réellement écoulé.
 *
 * Un plafond à zéro n'est PAS « illimité » : c'est un revendeur qui n'a rien
 * reçu. Seul un plafond négatif, choisi explicitement, lève la limite.
 */
export default function ResellersView({ currentUserRole, actorName }: ResellersViewProps) {
  const { t } = useTranslation();
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [quotaHistory, setQuotaHistory] = useState<ResellerQuotaMovement[]>([]);
  const [assignedCounts, setAssignedCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Création d'un revendeur — chemin canonique unique.
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    email: "",
    phone: "",
    quotaGB: 100,
    unlimited: false,
    status: "active" as "active" | "suspended",
    commission: 20,
    accessExpiresAt: defaultExpiryInput(365),
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdCredentials, setCreatedCredentials] = useState<{ email: string; password?: string } | null>(null);

  // Renouvellement de l'échéance.
  const [renewTarget, setRenewTarget] = useState<Reseller | null>(null);
  const [renewValue, setRenewValue] = useState(defaultExpiryInput(365));
  const [renewing, setRenewing] = useState(false);

  const isReseller = currentUserRole === UserRole.RESELLER;
  const isSupport = currentUserRole === UserRole.SUPPORT;
  // OWNER inclus : le serveur l'autorise, l'interface ne doit pas être plus
  // restrictive que l'API.
  const canManage = isAdminRole(currentUserRole);

  const loadResellers = async () => {
    setLoading(true);
    try {
      const [data, history] = await Promise.all([
        isReseller ? Promise.resolve([] as Reseller[]) : fetchResellers(),
        isSupport ? Promise.resolve([] as ResellerQuotaMovement[]) : fetchResellerQuotaHistory(),
      ]);
      setResellers(data);
      setQuotaHistory(history);

      // Indicateur « configurations attribuées » : l'échec de cette lecture
      // secondaire ne doit jamais vider la liste des revendeurs.
      if (canManage) {
        const profiles = await fetchVpnProfiles().catch(() => [] as VpnProfile[]);
        const counts: Record<string, number> = {};
        for (const profile of profiles) {
          for (const link of profile.resellers ?? []) {
            counts[link.resellerId] = (counts[link.resellerId] ?? 0) + 1;
          }
        }
        setAssignedCounts(counts);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadResellers(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");
    if (!isFutureExpiry(createForm.accessExpiresAt)) {
      setCreateError("La date d'expiration de l'accès doit être renseignée et future.");
      return;
    }
    const iso = toIsoExpiry(createForm.accessExpiresAt);
    if (!iso) {
      setCreateError("La date d'expiration de l'accès est invalide.");
      return;
    }
    setCreating(true);
    try {
      const created = await createReseller({
        name: createForm.name.trim(),
        email: createForm.email.trim(),
        phone: createForm.phone.trim() || undefined,
        // Négatif = plafond levé explicitement ; 0 = aucun volume attribué.
        quotaGB: createForm.unlimited ? -1 : Math.max(0, Number(createForm.quotaGB) || 0),
        status: createForm.status,
        commission: Number(createForm.commission) || 0,
        accessExpiresAt: iso,
      });
      setCreatedCredentials({ email: created.email, password: created.generatedPassword });
      setShowCreate(false);
      setCreateForm({
        name: "", email: "", phone: "", quotaGB: 100, unlimited: false,
        status: "active", commission: 20, accessExpiresAt: defaultExpiryInput(365),
      });
      toast.success("Revendeur créé — compte, rôle et agrément en une seule opération");
      await loadResellers();
    } catch (err: any) {
      setCreateError(err?.message || "Erreur lors de la création du revendeur");
    } finally {
      setCreating(false);
    }
  };

  const handleRenew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renewTarget) return;
    if (!isFutureExpiry(renewValue)) {
      toast.error("La nouvelle échéance doit être future.");
      return;
    }
    const iso = toIsoExpiry(renewValue);
    if (!iso) { toast.error("Date invalide."); return; }
    setRenewing(true);
    try {
      await renewResellerAccess(renewTarget.id, iso);
      toast.success(`Accès renouvelé jusqu'au ${formatDate(iso)}`);
      setRenewTarget(null);
      await loadResellers();
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors du renouvellement");
    } finally {
      setRenewing(false);
    }
  };

  const handleAdjustQuota = async (r: Reseller) => {
    const saisie = window.prompt(
      "Nouveau plafond en Go pour ce revendeur.\n" +
      "• un nombre : plafond exact (0 = aucun volume attribué)\n" +
      "• « illimité » : lever le plafond",
      r.quotaUnlimited ? "illimité" : String(Math.round((r.quotaGB ?? r.balance ?? 0) * 10) / 10)
    );
    if (saisie === null) return;
    const reason = window.prompt("Motif de cet ajustement de quota :")?.trim();
    if (!reason) { toast.error("Le motif est obligatoire"); return; }

    const normalized = saisie.trim().toLowerCase();
    try {
      if (["illimité", "illimite", "unlimited"].includes(normalized)) {
        await updateReseller(r.id, { quotaGB: -1, reason });
      } else {
        const amount = Number(normalized.replace(",", "."));
        if (Number.isNaN(amount) || amount < 0) { toast.error("Veuillez saisir un nombre positif ou « illimité »"); return; }
        await updateReseller(r.id, { quotaGB: amount, reason });
      }
      toast.success("Plafond du revendeur mis à jour");
      await loadResellers();
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors de la mise à jour du plafond");
    }
  };

  const handleToggleStatus = async (r: Reseller) => {
    const next = r.status === "active" ? "suspended" : "active";
    const label = next === "suspended" ? "Suspendre" : "Réactiver";
    if (!window.confirm(`${label} l'agrément de « ${r.name} » ?`)) return;
    try {
      await updateReseller(r.id, { status: next });
      toast.success(next === "suspended" ? "Agrément suspendu" : "Agrément réactivé");
      await loadResellers();
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors du changement de statut");
    }
  };

  const handleDelete = async (r: Reseller) => {
    if (!window.confirm(
      `Retirer l'agrément de « ${r.name} » ?\n\n` +
      "Seule la fiche revendeur est supprimée : son compte de connexion et les accès VPN de ses clients sont conservés."
    )) return;
    try {
      await deleteReseller(r.id);
      toast.success("Agrément retiré — clients conservés");
      await loadResellers();
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors du retrait de l'agrément");
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return resellers;
    return resellers.filter((r) =>
      (r.name || "").toLowerCase().includes(needle) || (r.email || "").toLowerCase().includes(needle));
  }, [resellers, search]);

  const formatLedgerBytes = (raw: string) => formatBytes(raw);

  const movementLabel: Record<ResellerQuotaMovement["kind"], string> = {
    ADMIN_ALLOCATION: "Allocation administrateur",
    ADMIN_WITHDRAWAL: "Retrait administrateur",
    ADMIN_CORRECTION: "Correction",
    QUOTA_COMMITMENT: "Engagement",
    QUOTA_RELEASE: "Libération",
  };

  const historyPanel = (
    <section className="overflow-hidden rounded-xl border border-gray-800/80 bg-gray-950/20">
      <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <History className="h-4 w-4 text-cyan-400" />
        <h2 className="text-sm font-semibold text-white">Historique auditable des quotas</h2>
      </div>
      {quotaHistory.length === 0 ? (
        <p className="p-6 text-center text-sm text-gray-500">Aucun mouvement enregistré.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-900/40 uppercase text-gray-400">
              <tr>
                {!isReseller && <th className="px-4 py-3">Revendeur</th>}
                <th className="px-4 py-3">Mouvement</th>
                <th className="px-4 py-3">Avant / après</th>
                <th className="px-4 py-3">Auteur</th>
                <th className="px-4 py-3">Motif</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-900">
              {quotaHistory.map((movement, index) => {
                const isLimit = movement.kind.startsWith("ADMIN_");
                const before = isLimit ? movement.quotaBeforeBytes : movement.allocatedBeforeBytes;
                const after = isLimit ? movement.quotaAfterBytes : movement.allocatedAfterBytes;
                return (
                  <tr key={`${movement.createdAt}-${index}`} className="text-gray-300">
                    {!isReseller && <td className="px-4 py-3 font-medium text-white">{movement.reseller}</td>}
                    <td className="px-4 py-3">{movementLabel[movement.kind]}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono">
                      {formatLedgerBytes(before)} → {formatLedgerBytes(after)}
                    </td>
                    <td className="px-4 py-3">{movement.author}</td>
                    <td className="max-w-xs px-4 py-3">{movement.reason}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {new Date(movement.createdAt).toLocaleString("fr-FR")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  if (isReseller) {
    return (
      <div className="space-y-6">
        <div className="mx-auto max-w-lg rounded-xl border border-gray-800 bg-gray-950/20 p-8 text-center backdrop-blur-md">
          <Landmark className="mx-auto mb-3 h-10 w-10 text-cyan-400" />
          <h2 className="text-lg font-bold text-white">Espace revendeur</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">
            L'historique ci-dessous est strictement limité aux mouvements de votre propre quota.
          </p>
        </div>
        {historyPanel}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-white">{t("resellers.title")}</h2>
          <p className="mt-1 text-sm text-gray-400">
            Agrément, échéance et plafond de chaque revendeur. Un compte de connexion seul ne fait pas un revendeur :
            seul l'agrément ci-dessous lui donne des pouvoirs.
          </p>
        </div>

        {canManage && (
          <button
            onClick={() => { setShowCreate(true); setCreateError(""); }}
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition-all hover:from-cyan-400 hover:to-blue-500"
          >
            <UserPlus className="h-4 w-4" />
            Créer un revendeur
          </button>
        )}
      </div>

      {createdCredentials && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-300">Revendeur créé — identifiants à transmettre</p>
              <p className="mt-1 font-mono text-xs text-emerald-100">{createdCredentials.email}</p>
              {createdCredentials.password ? (
                <p className="mt-1 font-mono text-xs text-amber-200">
                  Mot de passe provisoire : {createdCredentials.password}
                </p>
              ) : (
                <p className="mt-1 text-xs text-emerald-200/80">
                  Le compte existait déjà : ses identifiants actuels restent inchangés.
                </p>
              )}
            </div>
            <button onClick={() => setCreatedCredentials(null)} className="text-gray-400 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher un revendeur…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-800 bg-gray-900 py-2 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCw className="mb-4 h-7 w-7 animate-spin text-cyan-400" />
          <p className="font-mono text-sm">{t("common.loading")}</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  <th className="px-4 py-3">{t("resellers.fields.name")}</th>
                  <th className="px-4 py-3">Validité de l'accès</th>
                  <th className="px-4 py-3">Quota data</th>
                  <th className="px-4 py-3 text-center">{t("resellers.fields.clients_count")}</th>
                  <th className="px-4 py-3 text-center">Configurations</th>
                  <th className="px-4 py-3 text-center">{t("resellers.fields.status")}</th>
                  {canManage && <th className="px-4 py-3 text-right">{t("common.actions")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {filtered.map((r) => {
                  const access = r.resellerAccess;
                  const accessState = r.accessState ?? access?.accessState ?? (r.status === "active" ? "active" : "suspended");
                  const quotaState = r.quotaState ?? access?.quotaState ?? "available";
                  const remaining = daysUntil(r.accessExpiresAt ?? access?.accessExpiresAt ?? null);
                  const quotaBytes = access?.quotaBytes ?? String(r.quotaBytes ?? 0);
                  const allocatedBytes = access?.quotaAllocatedBytes ?? String(r.quotaAllocatedBytes ?? r.quotaUsedBytes ?? 0);
                  const unlimited = r.quotaUnlimited || quotaState === "unlimited";
                  const pct = unlimited ? 0 : percentOf(allocatedBytes, quotaBytes);
                  const assigned = assignedCounts[r.id] ?? 0;

                  return (
                    <tr key={r.id} className="transition-colors hover:bg-gray-900/20">
                      <td className="px-4 py-4 font-medium text-white">
                        <div className="flex items-center gap-2">
                          <UserCheck className="h-4 w-4 shrink-0 text-cyan-400" />
                          <div className="min-w-0">
                            <p className="truncate">{r.name}</p>
                            <p className="truncate text-xs font-normal text-gray-500">{r.email}</p>
                          </div>
                        </div>
                      </td>

                      <td className="min-w-52 px-4 py-4">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${ACCESS_BADGES[accessState]}`}>
                          <CalendarClock className="h-3 w-3" />
                          {ACCESS_LABELS[accessState]}
                        </span>
                        <p className="mt-1 text-xs text-gray-400">
                          {r.accessExpiresAt || access?.accessExpiresAt
                            ? <>Jusqu'au {formatDate(r.accessExpiresAt ?? access?.accessExpiresAt)}</>
                            : "Aucune échéance enregistrée (fiche antérieure)"}
                        </p>
                        {remaining !== null && remaining >= 0 && remaining <= 30 && (
                          <p className="text-[11px] text-amber-400">Expire dans {remaining} jour{remaining > 1 ? "s" : ""}</p>
                        )}
                        {remaining !== null && remaining < 0 && (
                          <p className="text-[11px] text-rose-400">Échéance dépassée — renouvellement requis</p>
                        )}
                      </td>

                      <td className="min-w-56 px-4 py-4">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${QUOTA_BADGES[quotaState]}`}>
                          {QUOTA_LABELS[quotaState]}
                        </span>
                        {unlimited ? (
                          <p className="mt-1 text-xs text-gray-500">Aucun plafond — choix explicite de l'administrateur</p>
                        ) : (
                          <div className="mt-1.5">
                            <div className="mb-1 flex justify-between font-mono text-xs">
                              <span className="text-cyan-400">{formatBytes(allocatedBytes)}</span>
                              <span className="text-gray-500">{formatBytes(quotaBytes)}</span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-gray-900">
                              <div
                                className={`h-full ${pct >= 100 ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-gradient-to-r from-cyan-500 to-blue-500"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            {/* « engagé » = distribué aux clients, ce qui décompte le
                                plafond ; « consommé » = trafic réellement écoulé. */}
                            <div className="mt-1 flex justify-between text-[10px] text-gray-500">
                              <span>engagé</span>
                              <span>consommé {formatBytes(r.quotaConsumedBytes ?? 0)}</span>
                            </div>
                            <p className="text-[10px] text-gray-500">
                              Reste {formatBytes(access?.quotaRemainingBytes ?? r.quotaRemainingBytes ?? 0)}
                            </p>
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-4 text-center text-white">{r.clientsCount}</td>

                      <td className="px-4 py-4 text-center">
                        {assigned > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 text-xs text-violet-300">
                            <GitBranch className="h-3 w-3" />
                            {assigned}
                          </span>
                        ) : (
                          <span className="text-xs text-amber-400" title="Sans configuration attribuée, ce revendeur ne peut créer aucun forfait.">
                            Aucune
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-4 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                          r.status === "active"
                            ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                            : "border border-amber-500/20 bg-amber-500/10 text-amber-400"
                        }`}>
                          {r.status === "active" ? "Actif" : "Suspendu"}
                        </span>
                      </td>

                      {canManage && (
                        <td className="px-4 py-4 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              onClick={() => {
                                setRenewTarget(r);
                                setRenewValue(defaultExpiryInput(365));
                              }}
                              className="flex items-center gap-1 rounded border border-emerald-800/30 bg-emerald-950 px-2.5 py-1 text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50"
                            >
                              <CalendarClock className="h-3.5 w-3.5" /> Renouveler
                            </button>
                            <button
                              onClick={() => handleAdjustQuota(r)}
                              className="flex items-center gap-1 rounded border border-cyan-800/20 bg-cyan-950 px-2.5 py-1 text-xs font-semibold text-cyan-400 hover:bg-cyan-900/50"
                            >
                              <Coins className="h-3.5 w-3.5" /> Quota
                            </button>
                            <button
                              onClick={() => handleToggleStatus(r)}
                              className="flex items-center gap-1 rounded border border-amber-800/20 bg-amber-950 px-2.5 py-1 text-xs font-semibold text-amber-400 hover:bg-amber-900/50"
                            >
                              {r.status === "active" ? "Suspendre" : "Réactiver"}
                            </button>
                            <button
                              onClick={() => handleDelete(r)}
                              title="Retirer l'agrément (clients conservés)"
                              className="rounded border border-rose-800/20 bg-rose-950 p-1.5 text-rose-400 hover:bg-rose-900/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-gray-800 bg-gray-950/10 p-12 text-center">
          <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-gray-700" />
          <h3 className="text-base font-semibold text-white">{t("resellers.empty_state")}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-400">{t("resellers.empty_state_desc")}</p>
          {canManage && (
            <button
              onClick={() => { setShowCreate(true); setCreateError(""); }}
              className="mt-5 rounded-lg border border-cyan-800/40 bg-cyan-950 px-4 py-2 text-xs font-semibold text-cyan-400 transition-all hover:bg-cyan-900/50"
            >
              Créer le premier revendeur
            </button>
          )}
        </div>
      )}

      {historyPanel}

      {/* Création — flux canonique : compte + rôle + agrément en une transaction */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold text-white">
                <UserPlus className="h-5 w-5 text-cyan-400" />
                Créer un revendeur
              </h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="mb-4 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs leading-relaxed text-cyan-200">
              Le compte de connexion, le rôle et l'agrément commercial sont créés ensemble. C'est le seul chemin :
              créer un compte au rôle RESELLER depuis l'onglet « Comptes » ne produirait pas d'agrément.
            </p>

            <form onSubmit={handleCreate} className="space-y-4">
              {createError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
                  {createError}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">Nom complet *</label>
                  <input
                    required minLength={2} type="text" value={createForm.name}
                    onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                    placeholder="Awa Traoré"
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">Email *</label>
                  <input
                    required type="email" value={createForm.email}
                    onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                    placeholder="awa@example.com"
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">Téléphone</label>
                  <input
                    type="text" value={createForm.phone}
                    onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                    placeholder="+225 07 XX XX XX"
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Expiration de l'accès *
                  </label>
                  <input
                    required type="datetime-local" min={minExpiryInput()}
                    value={createForm.accessExpiresAt}
                    onChange={(e) => setCreateForm({ ...createForm, accessExpiresAt: e.target.value })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                  <p className="mt-1 text-[11px] text-gray-500">
                    Obligatoire et future : un agrément sans échéance est perpétuel.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Quota attribué (Go)
                  </label>
                  <input
                    type="number" min={0} step={1} disabled={createForm.unlimited}
                    value={createForm.quotaGB}
                    onChange={(e) => setCreateForm({ ...createForm, quotaGB: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50"
                  />
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-gray-400">
                    <input
                      type="checkbox" checked={createForm.unlimited}
                      onChange={(e) => setCreateForm({ ...createForm, unlimited: e.target.checked })}
                      className="rounded border-gray-700 bg-gray-900 text-cyan-500"
                    />
                    Quota illimité (choix explicite)
                  </label>
                  <p className="mt-1 text-[11px] text-gray-500">
                    0 Go signifie « aucun volume attribué », jamais « illimité ».
                  </p>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">Commission (%)</label>
                  <input
                    type="number" min={0} max={100} value={createForm.commission}
                    onChange={(e) => setCreateForm({ ...createForm, commission: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                  <label className="mb-1.5 mt-3 block text-xs font-semibold uppercase tracking-wider text-gray-400">Statut</label>
                  <select
                    value={createForm.status}
                    onChange={(e) => setCreateForm({ ...createForm, status: e.target.value as "active" | "suspended" })}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none"
                  >
                    <option value="active">Actif</option>
                    <option value="suspended">Suspendu</option>
                  </select>
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Un mot de passe provisoire est généré et affiché une seule fois après la création.
              </p>

              <div className="mt-6 flex justify-end gap-2 border-t border-gray-900 pt-4">
                <button
                  type="button" onClick={() => setShowCreate(false)}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-gray-400 hover:bg-gray-800"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit" disabled={creating}
                  className="flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-black shadow-lg hover:bg-cyan-400 disabled:opacity-50"
                >
                  {creating && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  Créer le revendeur
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Renouvellement de l'échéance */}
      {renewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
            <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-white">
              <CalendarClock className="h-5 w-5 text-emerald-400" />
              Renouveler l'accès
            </h2>
            <p className="mb-4 text-sm text-gray-400">
              {renewTarget.name} — échéance actuelle : {formatDate(renewTarget.accessExpiresAt)}
            </p>
            <form onSubmit={handleRenew} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                  Nouvelle échéance *
                </label>
                <input
                  required type="datetime-local" min={minExpiryInput()} value={renewValue}
                  onChange={(e) => setRenewValue(e.target.value)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  Pour couper l'accès immédiatement, utilisez « Suspendre » : c'est réversible et lisible.
                </p>
              </div>
              <div className="flex justify-end gap-2 border-t border-gray-900 pt-4">
                <button
                  type="button" onClick={() => setRenewTarget(null)}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-gray-400 hover:bg-gray-800"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit" disabled={renewing}
                  className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
                >
                  {renewing && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  Renouveler
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
