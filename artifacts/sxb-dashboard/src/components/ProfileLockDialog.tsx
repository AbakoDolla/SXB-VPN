import { useState, type FormEvent } from 'react';
import { useTranslation } from '../contexts/I18nContext';

export function validProfilePassword(password: string): boolean {
  return [...password].length >= 8 && new TextEncoder().encode(password).length <= 72 &&
    !password.includes('\0') && !!password.trim();
}

export default function ProfileLockDialog({ name, mode, onSubmit, onClose }: {
  name: string;
  mode: 'unlock' | 'set';
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t, errorMessage } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validProfilePassword(password) || (mode === 'set' && password !== confirmation)) {
      setInvalid(true); return;
    }
    setBusy(true); setError(null); setInvalid(false);
    const value = password;
    setPassword(''); setConfirmation('');
    try { await onSubmit(value); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const known = ['PROFILE_LOCKED', 'PROFILE_UNLOCK_FAILED', 'PROFILE_LOCK_PASSWORD_INVALID',
    'PROFILE_UNLOCK_RATE_LIMITED', 'PROFILE_ENGINE_LINK_AMBIGUOUS', 'PROFILE_ENGINE_LINKED'].includes(code);
  return <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="profile-lock-title" onSubmit={submit}
      className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-6 w-full max-w-md space-y-4">
      <h2 id="profile-lock-title" className="font-semibold text-white">{t(`configurations.lock.${mode}`, { name })}</h2>
      <p className="text-sm text-gray-400">{t('configurations.lock.help')}</p>
      <label className="block text-sm text-gray-300">{t('configurations.lock.password')}
        <input autoFocus type="password" autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'}
          value={password} onChange={e => setPassword(e.target.value)} required maxLength={72}
          className="block w-full mt-2 p-3 rounded-lg bg-black/30 border border-gray-700" />
      </label>
      {mode === 'set' && <label className="block text-sm text-gray-300">{t('configurations.lock.confirm')}
        <input type="password" autoComplete="new-password" value={confirmation}
          onChange={e => setConfirmation(e.target.value)} required maxLength={72}
          className="block w-full mt-2 p-3 rounded-lg bg-black/30 border border-gray-700" />
      </label>}
      {invalid && <p role="alert" className="text-rose-400 text-sm">{t('configurations.lock.invalid')}</p>}
      {!!error && <p role="alert" className="text-rose-400 text-sm">
        {known ? t(`configurations.lock.errors.${code}`) : errorMessage(error)}
      </p>}
      <div className="flex justify-end gap-3 text-sm">
        <button type="button" onClick={onClose} className="text-gray-300">{t('configurations.lock.cancel')}</button>
        <button disabled={busy} className="px-4 py-2 rounded-lg bg-emerald-600 text-white disabled:opacity-50">
          {t(busy ? 'configurations.lock.busy' : 'configurations.lock.submit')}
        </button>
      </div>
    </form>
  </div>;
}
