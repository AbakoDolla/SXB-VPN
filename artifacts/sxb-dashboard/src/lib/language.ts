export type Language = "fr" | "en";
export const LANGUAGE_STORAGE_KEY = "sxb_vpn_lang";

export function detectLanguage(saved: string | null, browserLanguage = "fr"): Language {
  if (saved === "fr" || saved === "en") return saved;
  return browserLanguage.toLowerCase().split(/[-_]/)[0] === "en" ? "en" : "fr";
}

export function getLocale(language: Language = getLanguage()): "fr-FR" | "en-US" {
  return language === "en" ? "en-US" : "fr-FR";
}

let memoryLanguage: Language | undefined;
const listeners = new Set<() => void>();

function storageError(error: unknown): void {
  if (!(error instanceof Error) || !["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
  console.warn("Language preference storage is unavailable", error);
}

export function getLanguage(): Language {
  if (memoryLanguage) return memoryLanguage;
  let saved: string | null = null;
  try {
    if (typeof localStorage !== "undefined") saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch (error) { storageError(error); }
  return detectLanguage(saved, typeof navigator === "undefined" ? "fr" : navigator.language);
}

export function setLanguage(language: Language): void {
  memoryLanguage = language;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch (error) { storageError(error); }
  listeners.forEach(listener => listener());
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
    memoryLanguage = undefined;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
