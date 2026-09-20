import React, { createContext, useContext, useRef, useState, useSyncExternalStore } from 'react';
import { getPrivacyConsent, loadPrivacyConsent, savePrivacyConsent, subscribePrivacyConsent } from '@/services/privacyConsent';
import { type PrivacyConsent } from '@/services/privacyPolicy';
import { clearMobileHealth } from '@/services/mobileHealth';
import { unregisterPushToken } from '@/services/pushNotifications';

const PrivacyContext = createContext({
  consent: getPrivacyConsent(),
  loading: true,
  error: false,
  reload: async () => {},
  save: async (_next: PrivacyConsent) => {},
});

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const consent = useSyncExternalStore(subscribePrivacyConsent, getPrivacyConsent, getPrivacyConsent);
  // Le consentement est acquis d'office : plus rien à charger au démarrage,
  // donc aucun écran d'attente avant que l'application ne soit utilisable.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const pendingChange = useRef<PrivacyConsent | null>(null);
  const save = async (next: PrivacyConsent) => {
    pendingChange.current = next;
    try {
      await savePrivacyConsent(next);
      // No remaining optional outbox is sent after withdrawal, even offline.
      if (!next.diagnostics || !next.vpn) await clearMobileHealth();
      if (!next.notifications || !next.vpn) await unregisterPushToken('');
      pendingChange.current = null;
      setError(false);
    } catch (failure) {
      setError(true);
      throw failure;
    }
  };
  const reload = async () => {
    setLoading(true);
    setError(false);
    try {
      if (pendingChange.current) await save(pendingChange.current);
      else await loadPrivacyConsent();
    } catch { setError(true); }
    finally { setLoading(false); }
  };
  return <PrivacyContext.Provider value={{ consent, loading, error, reload, save }}>{children}</PrivacyContext.Provider>;
}

export const usePrivacy = () => useContext(PrivacyContext);
