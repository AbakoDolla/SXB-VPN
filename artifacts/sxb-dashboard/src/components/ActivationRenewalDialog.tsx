import { useRef, useState, type FormEvent } from "react";
import { RefreshCw, X } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import ActivationCodeResult from "./ActivationCodeResult";

interface RenewalResult {
  token: string;
  expireAt: string | null;
}

interface Props {
  name: string;
  previousToken: string;
  expireAt: string | null;
  fixedDurationDays?: number;
  allowed: boolean;
  busy: boolean;
  onRenew: (durationDays: number) => Promise<RenewalResult>;
  onClose: () => void;
}

export default function ActivationRenewalDialog({
  name, previousToken, expireAt, fixedDurationDays, allowed, busy, onRenew, onClose,
}: Props) {
  const { t, formatNumber, formatDate, errorMessage } = useTranslation();
  const [durationDays, setDurationDays] = useState(fixedDurationDays ?? 30);
  const [result, setResult] = useState<RenewalResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [completed, setCompleted] = useState(false);
  const request = useRef<"idle" | "pending" | "completed">("idle");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request.current !== "idle" || busy) {
      setFailure("commerce.common.actionPending");
      return;
    }
    if (!allowed) { setFailure("errors.auth.forbidden_permission"); return; }
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
      setFailure("commerce.devices.invalidDuration");
      return;
    }
    request.current = "pending";
    setFailure(null);
    try {
      const renewed = await onRenew(durationDays);
      request.current = "completed";
      setCompleted(true);
      if (!renewed || typeof renewed.token !== "string" || !renewed.token.startsWith("SXB-USER-") ||
        renewed.token === previousToken || !renewed.expireAt || !Number.isFinite(Date.parse(renewed.expireAt))) {
        setFailure("commerce.devices.renewalResponseInvalid");
        return;
      }
      setFailure(null);
      setResult(renewed);
    } catch (error) {
      request.current = "idle";
      setFailure(error);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="activation-renewal-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-[#252b3b] bg-[#0f1218] p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 id="activation-renewal-title" className="text-lg font-semibold text-white">
            {t(result ? "commerce.devices.renewalComplete" : "commerce.devices.renewDevice")}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("commerce.common.close")}
            className="text-gray-400 hover:text-white disabled:opacity-40">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="break-words text-sm text-gray-300">{name}</p>
        {failure !== null && <p role="alert" className="text-sm text-rose-400">{errorMessage(failure, "commerce.devices.renewError")}</p>}
        {result ? (
          <ActivationCodeResult token={result.token} expireAt={result.expireAt} />
        ) : !completed && (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-xs text-gray-400">{t("commerce.devices.currentExpiry", { date: formatDate(expireAt) })}</p>
            <label className="block space-y-2 text-sm text-gray-300">
              <span>{t("commerce.devices.renewalDays")}</span>
              {fixedDurationDays === undefined ? (
                <input type="number" name="durationDays" min={1} max={3650} step={1} required
                  value={durationDays} onChange={event => setDurationDays(Number(event.target.value))} disabled={busy}
                  className="w-full rounded-xl border border-[#252b3b] bg-[#07090e] px-3 py-2 text-white disabled:opacity-50" />
              ) : (
                <span className="block">{t("commerce.common.days", { count: formatNumber(durationDays) })}</span>
              )}
            </label>
            <p className="text-sm leading-relaxed text-amber-200">{t("commerce.devices.confirmRenew", { days: formatNumber(durationDays) })}</p>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} disabled={busy}
                className="rounded-lg border border-[#252b3b] px-3 py-2 text-sm text-gray-300 disabled:opacity-40">{t("commerce.common.cancel")}</button>
              <button type="submit" disabled={busy || !allowed}
                className="flex items-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-black disabled:opacity-40">
                {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
                {t(busy ? "commerce.common.actionPending" : "commerce.devices.confirmRenewal")}
              </button>
            </div>
          </form>
        )}
        {completed && <button type="button" onClick={onClose} disabled={busy}
          className="w-full rounded-lg border border-[#252b3b] px-3 py-2 text-sm text-gray-300 disabled:opacity-40">{t("commerce.common.close")}</button>}
      </div>
    </div>
  );
}
