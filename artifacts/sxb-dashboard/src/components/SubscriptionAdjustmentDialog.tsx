import { useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import type { Subscription } from "../api/subscriptions";

export type SubscriptionAdjustment = "add_data" | "extend_duration";

interface Props {
  subscription: Subscription;
  action: SubscriptionAdjustment;
  busy: boolean;
  allowed: boolean;
  onSubmit: (value: number) => Promise<void>;
  onClose: () => void;
}

export default function SubscriptionAdjustmentDialog({ subscription, action, busy, allowed, onSubmit, onClose }: Props) {
  const { t, errorMessage } = useTranslation();
  const isData = action === "add_data";
  const [value, setValue] = useState(isData ? 5 : 30);
  const [failure, setFailure] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) { setFailure("commerce.common.actionPending"); return; }
    if (!allowed) { setFailure("commerce.common.unavailableAccess"); return; }
    if (!Number.isFinite(value) || value < (isData ? 0.5 : 1) || value > (isData ? 1_000_000 : 3650) ||
      (!isData && !Number.isInteger(value))) {
      setFailure("commerce.subscriptions.invalidAdjustment");
      return;
    }
    setFailure(null);
    try { await onSubmit(value); }
    catch (error) { setFailure(error); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="subscription-adjustment-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl border border-[#252b3b] bg-[#0f1218] p-6">
        <h2 id="subscription-adjustment-title" className="text-lg font-semibold text-white">
          {t(isData ? "commerce.subscriptions.addData" : "commerce.subscriptions.extendPlan")}
        </h2>
        <p className="text-sm text-gray-300">{subscription.name}</p>
        <p className="text-sm leading-relaxed text-cyan-200">
          {t(isData ? "commerce.subscriptions.bulk.addDataHint" : "commerce.subscriptions.bulk.extendHint")}
        </p>
        <p className="text-xs text-gray-400">{t("commerce.subscriptions.keepActivation")}</p>
        {failure !== null && <p role="alert" className="text-sm text-rose-400">{errorMessage(failure, "commerce.subscriptions.bulk.error")}</p>}
        <label className="block space-y-2 text-sm text-gray-300">
          <span>{t(isData ? "commerce.subscriptions.bulk.addGb" : "commerce.subscriptions.bulk.addDays")}</span>
          <input type="number" name={isData ? "quotaGB" : "durationDays"} required min={isData ? 0.5 : 1}
            max={isData ? 1_000_000 : 3650} step={isData ? 0.5 : 1} value={value}
            onChange={event => setValue(Number(event.target.value))} disabled={busy}
            className="w-full rounded-lg border border-[#252b3b] bg-[#07090e] px-3 py-2 text-white disabled:opacity-40" />
        </label>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-lg border border-[#252b3b] px-3 py-2 text-sm text-gray-300 disabled:opacity-40">{t("commerce.common.cancel")}</button>
          <button type="submit" disabled={busy || !allowed}
            className="flex items-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-black disabled:opacity-40">
            {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
            {t(busy ? "commerce.common.actionPending" : "commerce.common.confirm")}
          </button>
        </div>
      </form>
    </div>
  );
}
