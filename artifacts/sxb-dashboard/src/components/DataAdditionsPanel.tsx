import { ChevronRight, Database } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import type { DataAddition } from "../api/data-additions";
import DataAdditionRow from "./DataAdditionRow";

interface DataAdditionsPanelProps {
  additions: DataAddition[];
  /** Cumul de tout l'historique visible, pas seulement des lignes affichées. */
  totals?: { count: number; addedBytes: string } | null;
  /** Ouvre « Données ajoutées » — sur un serveur précis, ou sur tous. */
  onOpen: (profileId?: string) => void;
}

/**
 * « Données ajoutées » sur le tableau de bord.
 *
 * La carte reprend le dernier ajout — « +5 Go · ajout à MTN Server » —, la liste
 * les derniers ajouts. Chaque entrée ouvre l'historique complet de SON serveur ;
 * « Voir tous les serveurs » ouvre le résumé de chacun.
 */
export default function DataAdditionsPanel({ additions, totals = null, onOpen }: DataAdditionsPanelProps) {
  const { t, formatBytes, formatNumber } = useTranslation();
  const latest = additions[0] ?? null;
  const latestServer = latest ? latest.profileName || t("operations.dataAdded.unknownServer") : "";

  return (
    <section aria-labelledby="dashboard-data-added">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="dashboard-data-added" className="min-w-0 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          {t("operations.dataAdded.section")}
        </h2>
        <button
          type="button"
          onClick={() => onOpen()}
          className="flex shrink-0 cursor-pointer items-center gap-1 text-xs font-semibold text-cyan-300 transition-colors hover:text-cyan-200"
        >
          {t("operations.dataAdded.viewAll")}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <button
          type="button"
          onClick={() => onOpen(latest?.profileId)}
          aria-label={latest
            ? t("operations.dataAdded.openServer", { server: latestServer, amount: formatBytes(latest.addedBytes) })
            : t("operations.dataAdded.viewAll")}
          className="dashboard-card sxb-animated-card relative flex cursor-pointer flex-col justify-between gap-3 overflow-hidden rounded-xl border border-[#1a1f2e] bg-[#0a0d14] p-4 text-left transition-all duration-200 hover:scale-[1.01] hover:border-cyan-500/40 lg:col-span-2"
        >
          <span className="flex items-start justify-between">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10">
              <Database className="h-4 w-4 text-cyan-400" aria-hidden="true" />
            </span>
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">{t("operations.dataAdded.section")}</span>
          </span>
          <span className="flex items-end justify-between gap-2">
            <span className="min-w-0">
              <span className="block text-2xl font-bold tracking-tight text-white tabular-nums">
                {latest ? `+${formatBytes(latest.addedBytes)}` : formatBytes(0)}
              </span>
              <span className="mt-0.5 block truncate text-xs text-gray-400">
                {latest ? t("operations.dataAdded.latestTo", { server: latestServer }) : t("operations.dataAdded.none")}
              </span>
            </span>
            <ChevronRight className="mb-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
          </span>
          {totals && totals.count > 0 && (
            <span className="border-t border-[#1a1f2e] pt-3 text-xs font-medium tabular-nums text-gray-300">
              {t("operations.dataAdded.cardTotals", {
                amount: formatBytes(totals.addedBytes),
                count: formatNumber(totals.count),
              })}
            </span>
          )}
        </button>
        <div className="rounded-xl border border-[#1a1f2e] bg-[#0a0d14] p-1.5 sm:col-span-2 lg:col-span-4">
          {additions.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-400">{t("operations.dataAdded.noneHint")}</p>
          ) : (
            <ul className="divide-y divide-[#1a1f2e]">
              {additions.slice(0, 5).map(addition => (
                <li key={addition.id}>
                  <DataAdditionRow addition={addition} onOpen={profileId => onOpen(profileId)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
