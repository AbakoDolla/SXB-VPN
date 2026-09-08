import { AlertTriangle, CalendarClock, Gauge, Lock, RefreshCw } from "lucide-react";
import { useResellerAccess } from "../contexts/ResellerAccessContext";
import {
  MESSAGE_ACCES_EXPIRE,
  MESSAGE_ACCES_SUSPENDU,
  formatBytes,
  formatDate,
  daysUntil,
  percentOf,
} from "../lib/resellerAccess";

/**
 * Bandeau d'état de l'agrément revendeur.
 *
 * Trois situations, trois traitements distincts — les confondre était le
 * défaut d'origine, où tout refus s'affichait « accès expiré » :
 *
 *   ÉCHÉANCE DÉPASSÉE  espace entièrement bloqué. Les données restent
 *                      affichées (le revendeur doit pouvoir constater son
 *                      parc), mais aucune écriture n'est possible : le
 *                      serveur les refuse toutes.
 *   AGRÉMENT SUSPENDU  même blocage, autre cause et autre recours.
 *   PLAFOND ATTEINT    bandeau rouge, mais l'espace reste utilisable : seules
 *                      les actions qui AUGMENTENT l'engagement sont fermées.
 *                      Suspendre, révoquer, supprimer, réduire restent ouverts,
 *                      car c'est par là qu'on libère du volume.
 */
export function ResellerAccessBanner() {
  const { access, blocked, quotaReached, refresh, error } = useResellerAccess();
  if (error) {
    return (
      <div role="alert" className="mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200">
        État de l’agrément indisponible : {error}
      </div>
    );
  }
  if (!access) return null;

  if (blocked) {
    const expired = access.accessState === "expired";
    return (
      <div
        role="alert"
        data-testid="reseller-access-banner"
        className="mb-4 rounded-2xl border border-rose-500/50 bg-rose-500/10 p-4 sm:p-5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
            <div>
              <p className="text-sm font-bold text-rose-200">
                {expired ? MESSAGE_ACCES_EXPIRE : MESSAGE_ACCES_SUSPENDU}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-rose-200/80">
                {expired
                  ? `Votre agrément a pris fin le ${formatDate(access.accessExpiresAt)}. Vos données restent consultables, mais aucune modification n'est possible tant qu'un administrateur ne l'a pas renouvelé.`
                  : "Votre agrément est suspendu. Vos données restent consultables ; contactez un administrateur pour le rétablir."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { refresh(); }}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/15"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Vérifier de nouveau
          </button>
        </div>
      </div>
    );
  }

  if (quotaReached) {
    return (
      <div
        role="alert"
        data-testid="reseller-quota-banner"
        className="mb-4 rounded-2xl border border-rose-500/50 bg-rose-500/10 p-4"
      >
        <div className="flex items-start gap-3">
          <Gauge className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-rose-200">
              Plafond de quota atteint — {formatBytes(access.quotaAllocatedBytes)} engagés sur {formatBytes(access.quotaBytes)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-rose-200/80">
              Les créations et les augmentations de volume sont suspendues. Suspendre, révoquer, supprimer un
              forfait ou en réduire le volume restent possibles : ce sont les gestes qui libèrent du quota.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Agrément valide : rappel discret de l'échéance quand elle approche.
  const remaining = daysUntil(access.accessExpiresAt);
  if (remaining !== null && remaining <= 30) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <p className="text-xs text-amber-200">
          Votre agrément expire dans {remaining} jour{remaining > 1 ? "s" : ""} — le {formatDate(access.accessExpiresAt)}.
          Demandez son renouvellement à un administrateur avant cette date.
        </p>
      </div>
    );
  }

  return null;
}

/**
 * Carte d'état détaillée, à placer en tête d'un écran de gestion.
 * Elle dit ce qui reste permis, plutôt que de laisser l'exploitant le
 * découvrir en heurtant un refus.
 */
export function ResellerAccessSummaryCard() {
  const { access } = useResellerAccess();
  if (!access) return null;

  const pct = access.quotaUnlimited ? 0 : percentOf(access.quotaAllocatedBytes, access.quotaBytes);
  return (
    <div className="rounded-2xl border border-[#1a1f2e] bg-[#0f1218] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-gray-500">Mon agrément</p>
          <p className="mt-1 text-sm font-semibold text-white">
            {access.accessState === "active" ? "Actif" : access.accessState === "expired" ? "Expiré" : "Suspendu"}
            <span className="ml-2 font-normal text-gray-500">
              jusqu'au {formatDate(access.accessExpiresAt)}
            </span>
          </p>
        </div>
        <div className="min-w-0 sm:w-64">
          <div className="flex items-center justify-between text-[11px] text-gray-500">
            <span>Engagé {formatBytes(access.quotaAllocatedBytes)}</span>
            <span>
              {access.quotaUnlimited ? "Illimité" : `Plafond ${formatBytes(access.quotaBytes)}`}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#1a1f2e]">
            <div
              className={`h-full rounded-full ${pct >= 100 ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-cyan-500"}`}
              style={{ width: `${access.quotaUnlimited ? 100 : pct}%` }}
            />
          </div>
          {!access.quotaUnlimited && (
            <p className="mt-1 text-[11px] text-gray-500">
              Reste {formatBytes(access.quotaRemainingBytes)} à distribuer
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Message inline expliquant pourquoi une commande est désactivée.
 * Un bouton grisé sans motif est indiscernable d'un bogue.
 */
export function ResellerActionNotice({ reducesExposure = false }: { reducesExposure?: boolean }) {
  const { allows, blocked, error } = useResellerAccess();
  if (allows({ reducesExposure })) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-rose-300">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {error
        ? "Action indisponible : l’état de votre agrément n’a pas pu être vérifié."
        : blocked
        ? "Action indisponible : votre agrément doit être renouvelé par un administrateur."
        : "Action indisponible : plafond de quota atteint. Libérez du volume pour la rouvrir."}
    </p>
  );
}
