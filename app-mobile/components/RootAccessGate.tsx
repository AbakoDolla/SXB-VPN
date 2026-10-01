import React, { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, NativeEventEmitter, NativeModules, Platform, ToastAndroid } from 'react-native';
import { useTranslation } from '@/localization';

interface RootState {
  allowed: boolean;
  rooted: boolean;
  keyId?: string;
  code?: string;
}
interface RootBridge {
  checkRootAppAccess(): Promise<string>;
  exitForRootAccess(message: string): void;
  addListener(name: string): void;
  removeListeners(count: number): void;
}

function parseState(value: string): RootState {
  const state: unknown = JSON.parse(value);
  if (!state || typeof state !== 'object' || !('allowed' in state) || !('rooted' in state) ||
      typeof state.allowed !== 'boolean' || typeof state.rooted !== 'boolean') throw new Error('ROOT_RESPONSE_INVALID');
  const keyId = 'keyId' in state && typeof state.keyId === 'string' && /^[a-f0-9]{64}$/.test(state.keyId)
    ? state.keyId : undefined;
  return { allowed: state.allowed, rooted: state.rooted, keyId };
}

/** Mount no account, navigation or VPN provider before the native startup decision. */
export default function RootAccessGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState(Platform.OS !== 'android');
  const sequence = useRef(0);
  const messages = useRef(t);
  messages.current = t;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const module = NativeModules.SxbVpnNative as RootBridge | undefined;
    let disposed = false;
    const deny = (keyId?: string) => {
      setAllowed(false);
      const message = messages.current('root_access_denied').replace('{{reference}}', keyId?.slice(0, 12) || '—');
      if (module?.exitForRootAccess) module.exitForRootAccess(message);
      else {
        console.warn('[SXB] ROOT_CHECK_UNAVAILABLE');
        ToastAndroid.show(message, ToastAndroid.LONG);
        BackHandler.exitApp();
      }
    };
    const apply = (raw: string) => {
      const state = parseState(raw);
      if (state.allowed) setAllowed(true);
      else deny(state.keyId);
    };
    const check = async () => {
      const request = ++sequence.current;
      try {
        if (!module?.checkRootAppAccess) throw new Error('ROOT_CHECK_UNAVAILABLE');
        const result = await module.checkRootAppAccess();
        if (!disposed && request === sequence.current) apply(result);
      } catch {
        console.warn('[SXB] ROOT_CHECK_UNAVAILABLE');
        if (!disposed && request === sequence.current) deny();
      }
    };
    const events = module ? new NativeEventEmitter(NativeModules.SxbVpnNative).addListener(
      'onRootAppAccessChange', (event: { state?: unknown }) => {
        if (disposed || typeof event.state !== 'string') return;
        ++sequence.current;
        try { apply(event.state); }
        catch { console.warn('[SXB] ROOT_RESPONSE_INVALID'); deny(); }
      },
    ) : null;
    const foreground = AppState.addEventListener('change', next => { if (next === 'active') void check(); });
    void check();
    return () => { disposed = true; ++sequence.current; events?.remove(); foreground.remove(); };
  }, []);
  return allowed ? <>{children}</> : null;
}
