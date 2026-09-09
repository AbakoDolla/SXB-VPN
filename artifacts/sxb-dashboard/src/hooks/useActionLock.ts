import { useRef, useState } from "react";

export function useActionLock() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState<string | null>(null);

  async function run<T>(action: string, operation: () => Promise<T>): Promise<T> {
    // State alone does not exclude two clicks before React's next render.
    if (inFlight.current) throw new Error("commerce.common.actionPending");
    inFlight.current = true;
    setPending(action);
    try {
      return await operation();
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  return { pending, run };
}
