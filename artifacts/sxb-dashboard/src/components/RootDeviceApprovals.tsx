import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { decideRootDevice, fetchRootDevices, type RootDevice, type RootDevicesPage } from '../api/security';
import { useTranslation } from '../contexts/I18nContext';

export default function RootDeviceApprovals({ token, autoRefresh }: { token: string; autoRefresh: boolean }) {
  const { t, formatDate, formatNumber, errorMessage } = useTranslation();
  const [page, setPage] = useState<RootDevicesPage | null>(null);
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(true);
  const pending = useRef(false);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await fetchRootDevices(token, { status: status || undefined, search: search.trim(), offset, limit: 25 });
      if (mounted.current && request === sequence.current) { setPage(result); setLoadError(null); }
    } catch (cause) { if (mounted.current && request === sequence.current) setLoadError(cause); }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [token, status, search, offset]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = autoRefresh ? window.setInterval(() => { void load(); }, 30000) : null;
    return () => { mounted.current = false; ++sequence.current; if (timer !== null) window.clearInterval(timer); };
  }, [load, autoRefresh]);

  const decide = async (device: RootDevice, next: 'approved' | 'denied') => {
    if (pending.current || !window.confirm(t(`operations.security.root.${next === 'approved' ? 'approveConfirm' : 'denyConfirm'}`,
      { device: device.deviceModel || device.keyId.slice(0, 12) }))) return;
    pending.current = true;
    setBusy(device.keyId); setActionError(null); setNotice('');
    try {
      await decideRootDevice(token, device, next);
      if (!mounted.current) return;
      setNotice(t(`operations.security.root.${next === 'approved' ? 'approvedNotice' : 'deniedNotice'}`));
      await load();
    } catch (cause) { if (mounted.current) setActionError(cause); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  };

  return <section id="security-root-devices" className="min-w-0 rounded-xl border border-[#263149] bg-[#0a0d14] p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-white">{t('operations.security.root.title')}</h2>
        <p className="mt-2 max-w-[72ch] text-sm leading-6 text-slate-300">{t('operations.security.root.hint')}</p>
        <p className="mt-1 max-w-[72ch] text-sm leading-6 text-slate-300">
          {t('operations.security.root.offline', { hours: page?.offlineHours ?? 24 })}
        </p>
      </div>
      <button type="button" onClick={() => { void load(); }} disabled={loading || busy !== null}
        className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#263149] px-3 py-2 text-sm text-slate-200 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50">
        <RefreshCw className="h-4 w-4" aria-hidden="true" />{t('operations.security.root.refresh')}
      </button>
    </div>
    <div className="mt-4 flex flex-wrap gap-3">
      <label className="grid min-w-0 flex-1 gap-1 text-sm text-slate-200">
        {t('operations.security.root.search')}
        <input type="search" maxLength={100} disabled={busy !== null} value={search} onChange={event => { setOffset(0); setSearch(event.target.value); }}
          className="min-h-10 w-full rounded-xl border border-[#263149] bg-[#07090e] px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400" />
      </label>
      <label className="grid gap-1 text-sm text-slate-200">
        {t('operations.security.root.statusLabel')}
        <select value={status} disabled={busy !== null} onChange={event => { setOffset(0); setStatus(event.target.value); }}
          className="min-h-10 rounded-xl border border-[#263149] bg-[#07090e] px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
          {['pending', 'approved', 'denied', ''].map(value =>
            <option key={value} value={value}>{t(`operations.security.root.status_${value || 'all'}`)}</option>)}
        </select>
      </label>
    </div>
    {(actionError ?? loadError) != null && <p role="alert" className="mt-4 text-sm leading-6 text-rose-200">
      {errorMessage(actionError ?? loadError, 'operations.security.root.failed')}
    </p>}
    {notice && <p role="status" className="mt-4 text-sm leading-6 text-cyan-200">{notice}</p>}
    <div className="mt-4" aria-busy={loading}>
      {!page && loading ? <div className="space-y-3" aria-label={t('operations.security.root.loading')}>
        {[0, 1, 2].map(index => <div key={index} className="h-12 rounded bg-white/5" />)}
      </div> : page?.devices.length === 0 ? <p className="py-4 text-sm leading-6 text-slate-300">{t('operations.security.root.empty')}</p>
        : <ul className="divide-y divide-[#263149]">
          {page?.devices.map(device => <li key={device.keyId} className="grid min-w-0 gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <strong className="break-words text-white">{device.deviceModel || t('operations.security.root.unknownModel')}</strong>
                <span className={device.status === 'approved' ? 'text-emerald-200' : device.status === 'pending' ? 'text-amber-200' : 'text-rose-200'}>
                  {t(`operations.security.root.status_${device.status}`)}
                </span>
              </div>
              <p className="mt-1 break-words text-sm text-slate-300">{device.client?.user.name || t('operations.security.root.unassigned')}</p>
              <p className="mt-1 break-all font-mono text-sm text-slate-300">{device.keyId}</p>
              <p className="mt-1 text-sm text-slate-300">{t('operations.security.root.lastSeen', { date: formatDate(device.lastSeenAt) })}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy !== null || device.status === 'approved' || (!device.client && !page.canApproveUnassigned)}
                onClick={() => { void decide(device, 'approved'); }}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-cyan-400/30 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />{t('operations.security.root.approve')}
              </button>
              <button type="button" disabled={busy !== null || device.status === 'denied'} onClick={() => { void decide(device, 'denied'); }}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-rose-400/30 px-3 py-2 text-sm text-rose-200 hover:bg-rose-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-300 disabled:opacity-50">
                <ShieldOff className="h-4 w-4" aria-hidden="true" />{t(`operations.security.root.${device.status === 'approved' ? 'revoke' : 'deny'}`)}
              </button>
            </div>
          </li>)}
        </ul>}
    </div>
    {page && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#263149] pt-3 text-sm text-slate-300">
      <span>{t('operations.security.root.count', { count: formatNumber(page.total) })}</span>
      <div className="flex gap-2">
        <button type="button" disabled={offset === 0 || loading || busy !== null} onClick={() => setOffset(Math.max(0, offset - 25))}
          className="min-h-10 rounded-xl border border-[#263149] px-3 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50">{t('operations.security.root.previous')}</button>
        <button type="button" disabled={offset + page.limit >= page.total || loading || busy !== null} onClick={() => setOffset(offset + 25)}
          className="min-h-10 rounded-xl border border-[#263149] px-3 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50">{t('operations.security.root.next')}</button>
      </div>
    </div>}
  </section>;
}
