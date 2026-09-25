import { ChevronRight } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import type { DataAddition } from "../api/data-additions";

interface DataAdditionRowProps {
  addition: DataAddition;
  /** Ouvre l'historique du serveur de cette ligne. Sans lui, la ligne est inerte. */
  onOpen?: (profileId: string) => void;
  /** Dans le détail d'UN serveur, son nom serait répété sur chaque ligne. */
  showServer?: boolean;
}

/**
 * Une ligne de « Données ajoutées » : combien, sur quel serveur, quand, par qui.
 *
 * Le montant ouvre la ligne, en chiffres tabulaires, pour qu'une colonne de
 * « +5 Go / +10 Go / +20 Go » se lise d'un coup d'œil.
 */
export default function DataAdditionRow({ addition, onOpen, showServer = true }: DataAdditionRowProps) {
  const { t, formatBytes, formatDate } = useTranslation();
  const amount = formatBytes(addition.addedBytes);
  const server = addition.profileName || t("operations.dataAdded.unknownServer");
  const kind = t(addition.kind === "creation" ? "operations.dataAdded.kindCreation" : "operations.dataAdded.kindAddition");
  const details = [
    showServer ? kind : null,
    addition.clientName ? t("operations.dataAdded.client", { name: addition.clientName }) : null,
    t("operations.dataAdded.by", { name: addition.actorName }),
  ].filter(Boolean).join(" · ");

  const content = (
    <>
      <span className="shrink-0 min-w-[4.75rem] rounded-md bg-emerald-500/10 px-2 py-1 text-center text-sm font-bold tabular-nums text-emerald-300">
        +{amount}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="min-w-0 truncate text-sm font-semibold text-white">{showServer ? server : kind}</span>
          <time dateTime={addition.createdAt} className="shrink-0 text-xs tabular-nums text-gray-400">
            {formatDate(addition.createdAt, { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </span>
        <span className="mt-0.5 block break-words text-xs text-gray-400">{details}</span>
      </span>
      {onOpen && <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />}
    </>
  );

  const shape = "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left";
  if (!onOpen) return <div className={shape}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(addition.profileId)}
      aria-label={t("operations.dataAdded.openServer", { server, amount })}
      className={`${shape} cursor-pointer transition-colors hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400`}
    >
      {content}
    </button>
  );
}
