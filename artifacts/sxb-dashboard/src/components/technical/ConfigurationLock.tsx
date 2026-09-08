import { useId } from "react";
import { LockKeyhole } from "lucide-react";
import { useTranslation } from "../../contexts/I18nContext";
import type { EngineAccountMetadata } from "../../api/engine-account";

export function validateLockPassword(value: string, vpnPassword: string): string | null {
  if (Array.from(value).length < 8 || new TextEncoder().encode(value).length > 72) {
    return "technical.lock.invalidLength";
  }
  return value === vpnPassword ? "technical.lock.mustDiffer" : null;
}

export function LockPasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-gray-400 mb-1.5">{t("technical.lock.password")}</label>
      <input id={id} name="lockPassword" type="password" autoComplete="new-password" required
        value={value} onChange={event => onChange(event.target.value)} aria-describedby={`${id}-help`}
        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
      <p id={`${id}-help`} className="text-xs text-gray-500 mt-1.5">{t("technical.lock.help")}</p>
    </div>
  );
}

export function LockedAccountNotice({ account }: { account: EngineAccountMetadata }) {
  const { t, formatDate, formatBytes } = useTranslation();
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-2" data-locked-account={account.id}>
      <h3 className="font-medium text-white">{account.name}</h3>
      <p className="flex items-center gap-2 text-sm text-amber-400">
        <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("technical.lock.locked")}
      </p>
      <p className="text-xs text-gray-400">{t("technical.lock.openConfigurations", { name: account.name })}</p>
      <p className="text-xs text-gray-500">
        {t("technical.fields.status")}: {t(`technical.status.${account.status}`)}
        {" · "}{t("technical.fields.quota")}: {formatBytes(account.quotaUsed)} / {account.quotaTotal === null ? t("technical.common.unlimited") : formatBytes(account.quotaTotal)}
        {" · "}{t("technical.fields.expiration")}: {account.expireAt ? formatDate(account.expireAt) : t("technical.common.unlimited")}
      </p>
    </div>
  );
}
