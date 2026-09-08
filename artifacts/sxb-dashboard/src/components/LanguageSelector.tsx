import { useTranslation } from "../contexts/I18nContext";

export default function LanguageSelector() {
  const { language, setLanguage, t } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-xs text-gray-400">
      <span>{t("core.language")}</span>
      <select
        aria-label={t("core.language")}
        value={language}
        onChange={event => setLanguage(event.target.value === "en" ? "en" : "fr")}
        className="rounded-lg border border-[#1a1f2e] bg-[#0a0d14] px-2 py-1.5 text-gray-200"
      >
        <option value="fr">{t("core.languages.fr")}</option>
        <option value="en">{t("core.languages.en")}</option>
      </select>
    </label>
  );
}
