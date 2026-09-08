import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { UserRole, ResellerAccessSummary } from "../types";
import { subscribeResellerAccess } from "../api/client";
import { fetchMyResellerAccess } from "../api/resellers";
import { canPerform, isAccessBlocked, isQuotaReached } from "../lib/resellerAccess";
import { useTranslation } from "./I18nContext";

/**
 * État d'accès du revendeur connecté, partagé par toute l'interface.
 *
 * Deux sources, volontairement combinées :
 *   - l'état personnel (`/resellers/me/access`), disponible même si une
 *     permission d'analytics a été retirée ;
 *   - les refus du serveur, qui portent le même contrat et corrigent l'état
 *     dès qu'il a changé pendant la session (échéance atteinte, plafond
 *     consommé par une autre action).
 *
 * Sans la seconde source, un agrément expirant en cours de session laissait
 * l'interface afficher des boutons actifs jusqu'au prochain rechargement.
 * Sans la première, il fallait provoquer une erreur pour découvrir son état.
 */
interface ResellerAccessValue {
  access: ResellerAccessSummary | null;
  loading: boolean;
  error: string | null;
  /** Vrai uniquement pour un revendeur dont l'agrément est expiré ou suspendu. */
  blocked: boolean;
  /** Vrai quand le plafond est atteint : seules les actions réductrices restent. */
  quotaReached: boolean;
  refresh: () => Promise<void>;
  /** Une action est-elle permise ? `reducesExposure` pour les gestes libérateurs. */
  allows: (options?: { reducesExposure?: boolean }) => boolean;
}

const ResellerAccessContext = createContext<ResellerAccessValue>({
  access: null,
  loading: false,
  error: null,
  blocked: false,
  quotaReached: false,
  refresh: async () => {},
  allows: () => true,
});

export function useResellerAccess(): ResellerAccessValue {
  return useContext(ResellerAccessContext);
}

export function ResellerAccessProvider({
  role,
  children,
}: {
  role: UserRole | string | null | undefined;
  children: React.ReactNode;
}) {
  const { errorMessage } = useTranslation();
  const isReseller = role === UserRole.RESELLER;
  const [access, setAccess] = useState<ResellerAccessSummary | null>(null);
  const [loading, setLoading] = useState(isReseller);
  const [failure, setError] = useState<unknown>(null);
  const error = failure ? errorMessage(failure, "errors.resellers.unavailable") : null;

  const refresh = useCallback(async () => {
    if (!isReseller) { setAccess(null); setError(null); setLoading(false); return; }
    setLoading(true);
    try {
      setAccess(await fetchMyResellerAccess());
      setError(null);
    } catch (reason) {
      setError(reason ?? "errors.resellers.unavailable");
    } finally {
      setLoading(false);
    }
  }, [isReseller]);

  useEffect(() => { refresh(); }, [refresh]);

  // Republication centrale : tout refus ou toute réponse portant le contrat
  // met l'état à jour, sans rechargement ni redirection.
  useEffect(() => {
    if (!isReseller) return;
    return subscribeResellerAccess((next) => { setAccess(next); setError(null); });
  }, [isReseller]);

  useEffect(() => {
    if (!isReseller || !access?.accessExpiresAt || access.accessState !== "active") return;
    const remaining = new Date(access.accessExpiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timeout = setTimeout(() => {
      if (remaining <= 2_147_483_647) {
        setAccess(current => current ? { ...current, accessState: "expired" } : current);
      }
      void refresh();
    }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timeout);
  }, [isReseller, access?.accessExpiresAt, access?.accessState, refresh]);

  const value = useMemo<ResellerAccessValue>(() => ({
    access,
    loading,
    error,
    blocked: isReseller && isAccessBlocked(access),
    quotaReached: isReseller && isQuotaReached(access),
    refresh,
    allows: (options) => (isReseller ? !!access && !loading && !error && canPerform(access, options) : true),
  }), [access, error, loading, isReseller, refresh]);

  return <ResellerAccessContext.Provider value={value}>{children}</ResellerAccessContext.Provider>;
}
