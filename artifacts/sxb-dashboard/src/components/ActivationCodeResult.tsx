import { Check, Copy } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import { useClipboard } from "../hooks/useClipboard";

export default function ActivationCodeResult({ token, expireAt }: { token: string; expireAt: string | null }) {
  const { t, formatDate } = useTranslation();
  const { copiedId, copy } = useClipboard();
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <p className="text-sm font-medium text-emerald-300">{t("commerce.devices.newActivationCode")}</p>
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-black/30 p-3">
          <code className="flex-1 break-all font-mono text-sm text-emerald-200">{token}</code>
          <button type="button" onClick={() => copy("activation-code", token)}
            aria-label={t(copiedId ? "commerce.common.copied" : "commerce.devices.copyToken")}
            className="text-emerald-300 hover:text-white">
            {copiedId ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
          </button>
        </div>
        <p className="text-xs text-gray-300">{t("commerce.devices.validUntil", { date: formatDate(expireAt) })}</p>
      </div>
      <p className="text-xs leading-relaxed text-gray-400">{t("commerce.devices.renewalPreservesAccess")}</p>
    </div>
  );
}
