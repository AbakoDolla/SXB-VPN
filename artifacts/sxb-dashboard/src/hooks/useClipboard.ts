import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "../contexts/I18nContext";

export function useClipboard() {
  const { message } = useTranslation();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetCopy = () => {
    generation.current++;
    if (timer.current !== null) clearTimeout(timer.current);
    setCopiedId(null);
  };

  useEffect(() => () => {
    generation.current++;
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const copy = async (key: string, value: string) => {
    resetCopy();
    const attempt = generation.current;
    try {
      await navigator.clipboard.writeText(value);
      if (attempt !== generation.current) return;
      setCopiedId(key);
      timer.current = setTimeout(() => setCopiedId(null), 1500);
    } catch {
      if (attempt === generation.current) toast.error(message("commerce.common.copyFailed"));
    }
  };

  return { copiedId, copy, resetCopy };
}
