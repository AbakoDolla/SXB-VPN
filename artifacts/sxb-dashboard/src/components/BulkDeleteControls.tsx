import { AlertTriangle, Trash2 } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import type { BulkDeleteController } from "../hooks/useBulkDelete";

export default function BulkDeleteControls({ controller: bulk, hintKey }: {
  controller: BulkDeleteController;
  hintKey: string;
}) {
  const { t, formatNumber, errorMessage } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-rose-500/20 bg-[#0f1218] p-4 space-y-3">
        <p className="text-sm text-gray-300">
          {t("operations.bulkDelete.selection", { selected: formatNumber(bulk.selectedCount), total: formatNumber(bulk.filteredCount) })}
        </p>
        <p className="text-xs text-gray-400">{t(hintKey)}</p>
        <p className="text-xs text-gray-500">{t("operations.bulkDelete.loadedOnly", { limit: formatNumber(bulk.maxBatch) })}</p>
        {bulk.excludedCount > 0 && <p className="text-xs text-amber-300">
          {t("operations.bulkDelete.excluded", { count: formatNumber(bulk.excludedCount) })}
        </p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={bulk.selectAll} disabled={bulk.busy || !bulk.canSelect || !bulk.selectableCount}
            className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 disabled:opacity-40">
            {t("operations.bulkDelete.selectAll", { count: formatNumber(bulk.selectableCount) })}
          </button>
          <button type="button" onClick={bulk.clearSelection} disabled={bulk.busy || !bulk.selectedCount}
            className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 disabled:opacity-40">
            {t("operations.bulkDelete.clear")}
          </button>
          <button type="button" onClick={bulk.openConfirmation}
            disabled={bulk.busy || !bulk.canDelete || !bulk.selectedCount || bulk.selectedCount > bulk.maxBatch}
            className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 disabled:opacity-40">
            <Trash2 className="h-4 w-4" />
            {t("operations.bulkDelete.deleteSelected", { count: formatNumber(bulk.selectedCount) })}
          </button>
        </div>
        {bulk.selectedCount > bulk.maxBatch && <p role="alert" className="text-xs text-amber-300">
          {t("operations.bulkDelete.limit", { count: formatNumber(bulk.selectedCount), limit: formatNumber(bulk.maxBatch) })}
        </p>}
        {!!bulk.error && <p role="alert" className="text-sm text-rose-300">{errorMessage(bulk.error, "errors.bulkDelete.failed")}</p>}
      </div>

      {bulk.result && <div role="status" className="rounded-xl border border-gray-700 bg-[#0f1218] p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white">{t("operations.bulkDelete.result", {
          succeeded: formatNumber(bulk.result.succeeded.length), failed: formatNumber(bulk.result.failed.length),
        })}</h3>
        {bulk.result.succeeded.length > 0 && <div>
          <p className="text-xs text-emerald-300">{t("operations.bulkDelete.succeeded")}</p>
          <ul className="max-h-40 overflow-y-auto text-xs text-gray-300">
            {bulk.result.succeeded.map(item => <li key={item.id}>{item.label} ({item.id})</li>)}
          </ul>
        </div>}
        {bulk.result.failed.length > 0 && <div>
          <p className="text-xs text-amber-300">{t("operations.bulkDelete.failedRetained")}</p>
          <ul className="max-h-56 overflow-y-auto space-y-2 text-xs text-rose-300">
            {bulk.result.failed.map(item => <li key={item.id}>
              {item.label} ({item.id}): {errorMessage(item.error, "errors.bulkDelete.failed")}
            </li>)}
          </ul>
        </div>}
      </div>}

      {bulk.confirmation && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
        <div role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" className="w-full max-w-lg space-y-4 rounded-xl border border-rose-500/30 bg-[#0a0d14] p-5">
          <h2 id="bulk-delete-title" className="flex items-center gap-2 text-base font-semibold text-rose-300">
            <AlertTriangle className="h-5 w-5" />{t("operations.bulkDelete.confirmTitle")}
          </h2>
          <p className="text-sm text-gray-300">{t("operations.bulkDelete.confirmScope", {
            count: formatNumber(bulk.confirmation.items.length), total: formatNumber(bulk.confirmation.filteredCount),
          })}</p>
          <p className="text-xs text-amber-300">{t(hintKey)}</p>
          {!!bulk.error && <p role="alert" className="text-sm text-rose-300">{errorMessage(bulk.error, "errors.bulkDelete.failed")}</p>}
          <ul className="max-h-48 overflow-y-auto text-xs text-gray-300">
            {bulk.confirmation.items.map(item => <li key={item.id}>{item.label} ({item.id})</li>)}
          </ul>
          {bulk.running && <p role="status" className="text-sm text-cyan-300">{t("operations.bulkDelete.progress", {
            count: formatNumber(bulk.progress), total: formatNumber(bulk.confirmation.items.length),
          })}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={bulk.closeConfirmation} disabled={bulk.running}
              className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 disabled:opacity-40">
              {t("operations.common.cancel")}
            </button>
            <button type="button" onClick={bulk.execute} disabled={bulk.running || !bulk.canDelete}
              className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
              {t("operations.bulkDelete.confirmDelete", { count: formatNumber(bulk.confirmation.items.length) })}
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}
