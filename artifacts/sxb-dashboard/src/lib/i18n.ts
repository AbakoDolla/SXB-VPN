import { dictionaries } from "../locales";
import { getLanguage, getLocale, type Language } from "./language";

export { getLanguage, getLocale, type Language } from "./language";
export type TranslationParams = Record<string, string | number>;
export type Translate = (key: string, params?: TranslationParams) => string;

export function resolveTranslation(language: Language, key: string): string | undefined {
  const resolve = (parts: string[]) => {
    let value: unknown = dictionaries[language];
    for (const part of parts) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return typeof value === "string" ? value : undefined;
  };
  return resolve(key.split(".")) ?? resolve(["common", ...key.split(".")]);
}

export function translate(language: Language, key: string, params: TranslationParams = {}): string {
  const text = resolveTranslation(language, key) ?? key;
  return text.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}

export function formatNumber(value: number | bigint, language: Language = getLanguage(), options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(language), options).format(value);
}

export function formatDate(value: Date | string | number | null | undefined, language: Language = getLanguage(), options?: Intl.DateTimeFormatOptions): string {
  if (value === null || value === undefined || value === "") return "\u2014";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "\u2014";
  return new Intl.DateTimeFormat(getLocale(language), options).format(date);
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, language: Language = getLanguage()): string {
  return new Intl.RelativeTimeFormat(getLocale(language), { numeric: "auto" }).format(value, unit);
}

export function formatBytes(value: number | bigint | string | null | undefined, language: Language = getLanguage(), decimals = 1): string {
  if (value === null || value === undefined || value === "") return "\u2014";
  if (typeof value === "number" && !Number.isFinite(value)) return "\u2014";
  const source = typeof value === "number" ? Math.trunc(value) : value;
  if (typeof source === "string" && !/^-?\d+$/.test(source.trim())) return "\u2014";
  const bytes = BigInt(source);
  if (bytes < BigInt(0)) return translate(language, "core.unlimited");
  const units = ["bytes", "kilobytes", "megabytes", "gigabytes", "terabytes", "petabytes", "exabytes"];
  let index = 0;
  let scale = BigInt(1);
  while (index < units.length - 1 && bytes / scale >= BigInt(1024)) {
    scale *= BigInt(1024);
    index++;
  }
  if (!Number.isFinite(decimals)) throw new RangeError("Byte formatting precision must be finite");
  const digits = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const precision = BigInt(10) ** BigInt(digits);
  const scaled = bytes * precision / scale;
  const whole = scaled / precision;
  const fraction = (scaled % precision).toString().padStart(digits, "0").replace(/0+$/, "");
  const separator = new Intl.NumberFormat(getLocale(language)).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
  const number = formatNumber(whole, language) + (fraction ? separator + fraction : "");
  return `${number} ${translate(language, `core.units.${units[index]}`)}`;
}
