import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchVpnProfiles, createVpnProfile, updateVpnProfile, deleteVpnProfile,
  fetchVpnProfileStats, testImportedConfig, testProfileConfig,
  VpnProfile, ConfigTestResult,
} from "../api/vpnProfiles";
import { fetchPayloads, SshPayload } from "../api/payload";
import {
  ShieldCheck, Plus, Trash2, RefreshCw, Edit3, X, AlertTriangle,
  Check, Wifi, Activity, Lock, Globe, UploadCloud, FlaskConical,
  FileKey2, RotateCcw, Info,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

const PROTO_COLORS: Record<string, string> = {
  ssh:          "text-cyan-400 bg-cyan-500/10",
  "ssh+payload":"text-teal-400 bg-teal-500/10",
  vless:        "text-blue-400 bg-blue-500/10",
  vmess:        "text-indigo-400 bg-indigo-500/10",
  trojan:       "text-amber-400 bg-amber-500/10",
  shadowsocks:  "text-purple-400 bg-purple-500/10",
  singbox:      "text-pink-400 bg-pink-500/10",
  wireguard:    "text-green-400 bg-green-500/10",
  hysteria2:    "text-orange-400 bg-orange-500/10",
  tuic:         "text-lime-400 bg-lime-500/10",
};

const PROTOCOLS = ['ssh', 'ssh+payload', 'vless', 'vmess', 'trojan', 'shadowsocks', 'singbox', 'wireguard'];
const NETWORKS  = ['ws', 'grpc', 'tcp', 'h2'];

/** Formulaire administratif — champs NON techniques uniquement (mission §6.1) */
const DEFAULT_ADMIN_FORM = {
  name: '', description: '', displayProtocol: '',
  offlineValidDays: 7, status: 'active', dns: '',
};
/** Formulaire legacy (colonnes) — maintenu pour compat, déconseillé */
const DEFAULT_LEGACY_FORM = {
  protocol: 'ssh', host: '', port: '', username: '', password: '',
  uuid: '', path: '/', network: 'ws', tls: false, sni: '',
  method: 'aes-256-gcm', payloadId: '' as string,
};

// ── Verdicts du préflight (taxonomie mission §7) ──────────────────────────────
const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  transport_ok:           { label: 'Transport OK',              cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  unreachable_from_probe: { label: 'Injoignable depuis le sondeur', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
  invalid:                { label: 'Configuration invalide',    cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30' },
  unsupported:            { label: 'Format non testable',       cls: 'text-gray-300 bg-gray-500/10 border-gray-500/30' },
  unknown:                { label: 'Jamais testé',              cls: 'text-gray-400 bg-gray-500/10 border-gray-500/30' },
};

function VerdictBadge({ status, className = '' }: { status?: string | null; className?: string }) {
  const v = VERDICT_STYLE[status || 'unknown'] || VERDICT_STYLE.unknown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${v.cls} ${className}`}>
      {v.label}
    </span>
  );
}

/** Panneau de résultat d'un préflight /api/config-test */
function ProbeResultPanel({ result }: { result: ConfigTestResult }) {
  return (
    <div className="mt-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <VerdictBadge status={result.validationStatus} />
        {result.probe?.latencyMs != null && (
          <span className="text-xs text-gray-400">latence {Math.round(result.probe.latencyMs)} ms</span>
        )}
        {result.probe?.durationMs != null && (
          <span className="text-xs text-gray-600">durée {result.probe.durationMs} ms</span>
        )}
      </div>
      {result.parse?.errors?.length ? (
        <ul className="text-xs text-rose-400 space-y-0.5">
          {result.parse.errors.map((e, i) => <li key={i}>• {e}</li>)}
        </ul>
      ) : null}
      {result.parse?.warnings?.length ? (
        <ul className="text-xs text-amber-400 space-y-0.5">
          {result.parse.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
        </ul>
      ) : null}
      {result.probe?.steps?.length ? (
        <ol className="text-xs space-y-0.5">
          {result.probe.steps.map((s, i) => (
            <li key={i} className={s.ok ? 'text-emerald-400' : 'text-rose-400'}>
              {s.ok ? '✓' : '✗'} <span className="text-gray-400">{s.step}</span> — {s.detail}
              {s.latencyMs != null && <span className="text-gray-600"> ({Math.round(s.latencyMs)} ms)</span>}
            </li>
          ))}
        </ol>
      ) : null}
      {result.probe?.hint && (
        <p className="text-xs text-sky-400 flex items-start gap-1"><Info className="w-3 h-3 mt-0.5 shrink-0" />{result.probe.hint}</p>
      )}
      {result.validationStatus === 'unreachable_from_probe' && (
        <p className="text-xs text-gray-500">
          ⚠ Injoignable depuis ce serveur ≠ forcément invalide : la cible peut être
          géo-restreinte ou réservée à certains opérateurs. La config est conservée telle quelle.
        </p>
      )}
    </div>
  );
}

export default function VpnProfilesView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [stats, setStats]       = useState({ total: 0, active: 0, byProtocol: [] as any[] });
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<VpnProfile | null>(null);
  const [createTab, setCreateTab] = useState<'import' | 'manual'>('import');
  const [adminForm, setAdminForm] = useState({ ...DEFAULT_ADMIN_FORM });
  const [legacyForm, setLegacyForm] = useState({ ...DEFAULT_LEGACY_FORM });
  const [importConfig, setImportConfig]   = useState('');
  const [reimportConfig, setReimportConfig] = useState('');
  const [showReimport, setShowReimport]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [error, setError]       = useState('');
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [filterProto, setFilterProto] = useState('all');
  const [search, setSearch]     = useState('');
  const [payloads, setPayloads] = useState<SshPayload[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const [profs, st, pays] = await Promise.all([
        fetchVpnProfiles(),
        fetchVpnProfileStats(),
        fetchPayloads().catch(() => [] as SshPayload[]),
      ]);
      setProfiles(profs);
      setStats(st);
      setPayloads(pays);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const resetModalState = () => {
    setError(''); setFieldErrors([]); setTestResult(null);
    setImportConfig(''); setReimportConfig(''); setShowReimport(false);
  };

  const openCreate = () => {
    setEditId(null); setEditingProfile(null);
    setAdminForm({ ...DEFAULT_ADMIN_FORM });
    setLegacyForm({ ...DEFAULT_LEGACY_FORM });
    setCreateTab('import');
    resetModalState(); setShowForm(true);
  };

  const openEdit = (p: VpnProfile) => {
    setEditId(p.id); setEditingProfile(p);
    setAdminForm({
      name: p.name, description: p.description || '',
      displayProtocol: p.displayProtocol || '',
      offlineValidDays: p.offlineValidDays, status: p.status,
      dns: p.dns || '',
    });
    setLegacyForm({
      protocol: p.protocol, host: p.host, port: String(p.port),
      username: p.username || '', password: '', uuid: p.uuid || '',
      path: p.path || '/', network: p.network, tls: p.tls, sni: p.sni || '',
      method: p.method || 'aes-256-gcm', payloadId: (p as any).payloadId || '',
    });
    resetModalState(); setShowForm(true);
  };

  /** Extrait les erreurs détaillées d'un 422 backend (IMPORT_INVALID). */
  const extractErrors = (err: any): string => {
    if (err?.status === 422) {
      const details = err?.responseData?.details;
      const list: string[] = [
        ...(details?.errors || []),
        ...(details?.warnings || []).map((w: string) => `⚠ ${w}`),
      ];
      setFieldErrors(list);
      return err?.responseData?.error || 'Configuration importée invalide';
    }
    if (err?.status === 409) {
      return err?.responseData?.error || 'Champs techniques immuables';
    }
    return err?.message || 'Erreur';
  };

  // ── Préflight : tester le texte d'import AVANT persistance ─────────────────
  const handleTestImport = async (raw: string) => {
    if (!raw.trim()) { setError('Collez d\'abord une configuration (URI ou JSON)'); return; }
    setTesting(true); setError(''); setFieldErrors([]); setTestResult(null);
    try {
      const result = await testImportedConfig(raw);
      setTestResult(result);
    } catch (err: any) {
      setError(err?.message || 'Préflight indisponible');
    } finally { setTesting(false); }
  };

  // ── Préflight : tester la config stockée d'un profil ───────────────────────
  const handleTestProfile = async (id: string) => {
    setTesting(true); setError(''); setTestResult(null);
    try {
      const result = await testProfileConfig(id);
      setTestResult(result);
      load(); // validatedAt/validationStatus mis à jour côté backend
    } catch (err: any) {
      setError(err?.message || 'Préflight indisponible');
    } finally { setTesting(false); }
  };

  // ── Soumission ──────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(''); setFieldErrors([]);
    try {
      if (editId) {
        const isImported = !!editingProfile?.hasCanonicalConfig;
        if (reimportConfig.trim()) {
          // Réimport EXPLICITE — seule voie de modification technique (§6.1)
          await updateVpnProfile(editId, {
            importConfig: reimportConfig,
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
          } as any);
        } else if (isImported) {
          // Profil importé : UNIQUEMENT les champs administratifs (jamais de technique)
          await updateVpnProfile(editId, {
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
          });
        } else {
          // Profil legacy : formulaire technique complet (comportement historique)
          if (!adminForm.name || !legacyForm.host || !legacyForm.port) {
            setError('Nom, hôte et port sont requis'); setSaving(false); return;
          }
          await updateVpnProfile(editId, {
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
            protocol: legacyForm.protocol,
            host: legacyForm.host, port: Number(legacyForm.port),
            username: legacyForm.username || undefined,
            password: legacyForm.password || undefined,
            uuid: legacyForm.uuid || undefined,
            path: legacyForm.path || undefined,
            network: legacyForm.network,
            tls: legacyForm.tls,
            sni: legacyForm.sni || undefined,
            method: legacyForm.method,
            payloadId: legacyForm.payloadId || undefined,
          } as any);
        }
      } else if (createTab === 'import') {
        if (!adminForm.name) { setError('Le nom du profil est requis'); setSaving(false); return; }
        if (!importConfig.trim()) { setError('Collez la configuration fournisseur (URI ou JSON)'); setSaving(false); return; }
        await createVpnProfile({
          name: adminForm.name, description: adminForm.description,
          displayProtocol: adminForm.displayProtocol,
          status: adminForm.status,
          offlineValidDays: Number(adminForm.offlineValidDays),
          dns: adminForm.dns || undefined,
          importConfig,
        } as any);
      } else {
        if (!adminForm.name || !legacyForm.host || !legacyForm.port) {
          setError('Nom, hôte et port sont requis'); setSaving(false); return;
        }
        await createVpnProfile({
          name: adminForm.name, description: adminForm.description,
          displayProtocol: adminForm.displayProtocol,
          status: adminForm.status,
          offlineValidDays: Number(adminForm.offlineValidDays),
          dns: adminForm.dns || undefined,
          protocol: legacyForm.protocol,
          host: legacyForm.host, port: Number(legacyForm.port),
          username: legacyForm.username || undefined,
          password: legacyForm.password || undefined,
          uuid: legacyForm.uuid || undefined,
          path: legacyForm.path || undefined,
          network: legacyForm.network,
          tls: legacyForm.tls,
          sni: legacyForm.sni || undefined,
          method: legacyForm.method,
          payloadId: legacyForm.payloadId || undefined,
        } as any);
      }
      setShowForm(false); load();
    } catch (err: any) { setError(extractErrors(err)); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string, count: number) => {
    if (count > 0) { alert(`Impossible — ${count} abonnement(s) actif(s)`); return; }
    if (!confirm(`Supprimer le profil "${name}" ?`)) return;
    await deleteVpnProfile(id); load();
  };

  const filtered = profiles.filter(p =>
    (filterProto === 'all' || p.protocol === filterProto) &&
    (p.name.toLowerCase().includes(search.toLowerCase()) || (p.host || '').includes(search))
  );

  const fa = (k: keyof typeof adminForm, v: any) => setAdminForm(prev => ({ ...prev, [k]: v }));
  const fl = (k: keyof typeof legacyForm, v: any) => setLegacyForm(prev => ({ ...prev, [k]: v }));

  const inputCls = "w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500";
  const readonlyCls = "w-full px-3 py-2.5 bg-[#0a0d13] border border-[#131722] rounded-xl text-gray-500 text-sm cursor-not-allowed select-all";

  const isEditingImported = !!editId && !!editingProfile?.hasCanonicalConfig;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 rounded-xl">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Profils VPN</h1>
            <p className="text-sm text-gray-500">Configurations importées — chiffrées, provisionnées à l'identique</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl text-sm font-medium border border-emerald-500/20 transition-colors">
              <Plus className="w-4 h-4" /> Importer une configuration
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total profils', value: stats.total,  color: 'text-white' },
          { label: 'Actifs',        value: stats.active, color: 'text-emerald-400' },
          ...stats.byProtocol.slice(0, 2).map((b: any) => ({
            label: b.protocol.toUpperCase(), value: b._count.id,
            color: (PROTO_COLORS[b.protocol] || 'text-gray-400').split(' ')[0],
          })),
        ].map(s => (
          <div key={s.label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 flex-wrap">
          {['all', ...PROTOCOLS].map(p => (
            <button key={p} onClick={() => setFilterProto(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                filterProto === p
                  ? (p === 'all' ? 'bg-white/10 text-white' : `${PROTO_COLORS[p]} border border-current/20`)
                  : 'text-gray-500 hover:text-gray-300'
              }`}>{p === 'all' ? 'Tous' : p}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher..."
          className="px-3 py-1.5 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 sm:ml-auto" />
      </div>

      {/* Profile Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-3 text-center py-12 text-gray-500">Chargement...</div>
        ) : filtered.length === 0 ? (
          <div className="col-span-3 text-center py-12 text-gray-500">
            <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Aucun profil VPN configuré</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-emerald-400 hover:text-emerald-300 text-sm">+ Importer une configuration</button>}
          </div>
        ) : filtered.map(p => (
          <div key={p.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="text-white font-semibold truncate">{p.name}</h3>
                {p.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{p.description}</p>}
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${PROTO_COLORS[p.protocol] || 'text-gray-400 bg-gray-500/10'}`}>
                    {p.protocol}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${p.status === 'active' ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-400 bg-gray-500/10'}`}>
                    {p.status}
                  </span>
                  {p.tls && <span className="text-xs px-2 py-0.5 rounded-full text-cyan-400 bg-cyan-500/10">TLS</span>}
                  {p.hasCanonicalConfig && (
                    <span className="text-xs px-2 py-0.5 rounded-full text-sky-400 bg-sky-500/10" title={p.canonicalConfigHash || ''}>
                      <FileKey2 className="w-3 h-3 inline mr-0.5" />Importé v{p.configVersion ?? 1}
                      {p.sourceFormat ? ` · ${p.sourceFormat}` : ''}
                    </span>
                  )}
                  {p.validationStatus && p.validationStatus !== 'unknown' && (
                    <VerdictBadge status={p.validationStatus} />
                  )}
                  {p._count && p._count.subscriptions > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full text-amber-400 bg-amber-500/10">
                      {p._count.subscriptions} abonnement(s)
                    </span>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div className="flex gap-1 ml-2 shrink-0">
                  <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(p.id, p.name, p._count?.subscriptions || 0)}
                    className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Globe className="w-3 h-3" />Serveur</p>
                <p className="text-white font-mono truncate">{p.host}:{p.port}</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Wifi className="w-3 h-3" />Network</p>
                <p className="text-white">{p.network || '—'}{p.path ? ` ${p.path}` : ''}</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Activity className="w-3 h-3" />Offline</p>
                <p className="text-white">{p.offlineValidDays}j valide</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Lock className="w-3 h-3" />Stockage</p>
                <p className="text-emerald-400">{p.hasCanonicalConfig ? 'Canonique AES-256-GCM' : 'Legacy AES-256-GCM'}</p>
              </div>
            </div>
            {p.validationMessage && p.validationStatus !== 'transport_ok' && (
              <p className="text-xs text-gray-500 truncate" title={p.validationMessage}>↳ {p.validationMessage}</p>
            )}
          </div>
        ))}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">
                {editId ? (isEditingImported ? 'Profil importé (technique immuable)' : 'Modifier le profil legacy') : 'Importer une configuration VPN'}
              </h2>
              <button onClick={() => setShowForm(false)} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {error && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm space-y-1">
                  <p className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />{error}</p>
                  {fieldErrors.length > 0 && (
                    <ul className="pl-6 text-xs space-y-0.5">
                      {fieldErrors.map((fe, i) => <li key={i}>• {fe}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {/* ═══ CHAMPS ADMINISTRATIFS (toujours éditables, §6.1) ═══ */}
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Nom du profil *</label>
                  <input value={adminForm.name} onChange={e => fa('name', e.target.value)} required
                    placeholder="MTN SSH Premium" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Nom affiché sur mobile
                    <span className="ml-2 text-xs text-emerald-400/70">(Display Name)</span>
                  </label>
                  <input value={adminForm.displayProtocol} onChange={e => fa('displayProtocol', e.target.value)}
                    placeholder="MTN Protocol, Orange Protocol, SXB Premium…"
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-emerald-500/30 rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Description</label>
                  <input value={adminForm.description} onChange={e => fa('description', e.target.value)}
                    placeholder="Profil premium pour réseaux MTN" className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Statut</label>
                  <select value={adminForm.status} onChange={e => fa('status', e.target.value)} className={inputCls}>
                    <option value="active">Actif</option>
                    <option value="inactive">Inactif</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Validité offline (jours)</label>
                  <input type="number" value={adminForm.offlineValidDays} onChange={e => fa('offlineValidDays', Number(e.target.value))}
                    min={1} max={30} className={inputCls} />
                </div>
              </div>

              {/* ═══ CRÉATION : onglets Import / Manuel ═══ */}
              {!editId && (
                <div>
                  <div className="flex gap-2 mb-4">
                    <button type="button" onClick={() => setCreateTab('import')}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${createTab === 'import' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'border-[#1a1f2e] text-gray-500'}`}>
                      <UploadCloud className="w-3.5 h-3.5" /> Importer une configuration (recommandé)
                    </button>
                    <button type="button" onClick={() => setCreateTab('manual')}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${createTab === 'manual' ? 'bg-white/5 border-white/20 text-gray-300' : 'border-[#1a1f2e] text-gray-500'}`}>
                      Saisie manuelle (legacy)
                    </button>
                  </div>

                  {createTab === 'import' && (
                    <div className="space-y-3">
                      <div className="p-3 bg-sky-500/5 border border-sky-500/20 rounded-xl text-xs text-sky-300 space-y-1">
                        <p className="font-medium flex items-center gap-1.5"><FileKey2 className="w-3.5 h-3.5" /> Modèle « intermédiaire »</p>
                        <p className="text-sky-400/80">
                          Collez la configuration obtenue auprès de votre fournisseur. Elle sera stockée
                          <strong> chiffrée (AES-256-GCM)</strong> et provisionnée à l'application mobile
                          <strong> techniquement identique</strong> — aucune modification technique n'est possible ensuite
                          (hors réimport explicite). Formats acceptés : vless://, vmess://, trojan://, ss://,
                          hysteria2://, tuic://, conf WireGuard, JSON sing-box, JSON SSH/SSH+Payload, canonique SXB.
                        </p>
                      </div>
                      <textarea
                        value={importConfig}
                        onChange={e => setImportConfig(e.target.value)}
                        rows={7}
                        placeholder={'vless://uuid@host:443?security=tls&sni=cdn.example.com#MonProfil\n\n— ou —\n\n{ "protocol": "ssh+payload", "host": "…", "port": 443, "username": "…", "password": "…", "payload": "GET / HTTP/1.1[crlf]Host: [host][crlf]…" }'}
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-emerald-400 text-xs font-mono focus:outline-none focus:border-emerald-500/50 resize-y"
                      />
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => handleTestImport(importConfig)} disabled={testing}
                          className="flex items-center gap-2 px-3 py-2 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-medium rounded-xl border border-sky-500/30 disabled:opacity-50">
                          <FlaskConical className="w-3.5 h-3.5" /> {testing ? 'Test en cours…' : 'Tester la configuration importée'}
                        </button>
                        <span className="text-[11px] text-gray-600">Transport uniquement — aucune authentification, aucun serveur créé</span>
                      </div>
                      {testResult && <ProbeResultPanel result={testResult} />}
                    </div>
                  )}

                  {createTab === 'manual' && (
                    <ManualForm form={legacyForm} f={fl} payloads={payloads} inputCls={inputCls} networks={NETWORKS} protocols={PROTOCOLS} />
                  )}
                </div>
              )}

              {/* ═══ ÉDITION ═══ */}
              {editId && isEditingImported && editingProfile && (
                <div className="space-y-4">
                  {/* Bandeau immuabilité */}
                  <div className="p-3 bg-sky-500/5 border border-sky-500/20 rounded-xl text-xs text-sky-300 space-y-1.5">
                    <p className="font-medium flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      Configuration importée v{editingProfile.configVersion ?? 1}
                      {editingProfile.sourceFormat ? ` (${editingProfile.sourceFormat})` : ''} — technique immuable
                    </p>
                    <p className="text-sky-400/80">
                      Les champs techniques (protocole, hôte, port, credentials, TLS/SNI, transport, payload…)
                      ne sont modifiables que par <strong>réimport explicite</strong> ci-dessous, ce qui incrémente
                      la version et invalide automatiquement le cache des applications.
                    </p>
                    {editingProfile.canonicalConfigHash && (
                      <p className="font-mono text-[10px] text-sky-500/70 break-all">
                        sha256: {editingProfile.canonicalConfigHash}
                      </p>
                    )}
                    <div className="flex items-center gap-2 pt-1 flex-wrap">
                      <VerdictBadge status={editingProfile.validationStatus} />
                      {editingProfile.validatedAt && (
                        <span className="text-[11px] text-gray-500">testé le {new Date(editingProfile.validatedAt).toLocaleString('fr-FR')}</span>
                      )}
                      {editingProfile.importedAt && (
                        <span className="text-[11px] text-gray-500">importé le {new Date(editingProfile.importedAt).toLocaleString('fr-FR')}</span>
                      )}
                    </div>
                  </div>

                  {/* Champs techniques EN LECTURE SEULE */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5">Protocole 🔒</label>
                      <input value={editingProfile.protocol} readOnly disabled className={readonlyCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5">Hôte : Port 🔒</label>
                      <input value={`${editingProfile.host}:${editingProfile.port}`} readOnly disabled className={readonlyCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5">TLS / SNI 🔒</label>
                      <input value={`${editingProfile.tls ? 'TLS activé' : 'sans TLS'}${editingProfile.sni ? ` · ${editingProfile.sni}` : ''}`} readOnly disabled className={readonlyCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5">Transport 🔒</label>
                      <input value={`${editingProfile.network || '—'}${editingProfile.path ? ` · ${editingProfile.path}` : ''}`} readOnly disabled className={readonlyCls} />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm text-gray-500 mb-1.5">Credentials 🔒</label>
                      <input value="(stockés chiffrés dans la configuration canonique — jamais affichés)" readOnly disabled className={readonlyCls} />
                    </div>
                  </div>

                  <button type="button" onClick={() => handleTestProfile(editId!)} disabled={testing}
                    className="flex items-center gap-2 px-3 py-2 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-medium rounded-xl border border-sky-500/30 disabled:opacity-50">
                    <FlaskConical className="w-3.5 h-3.5" /> {testing ? 'Test en cours…' : 'Tester la configuration importée'}
                  </button>
                  {testResult && <ProbeResultPanel result={testResult} />}

                  {/* Réimport explicite */}
                  <div className="border border-[#1a1f2e] rounded-xl p-4 space-y-3">
                    <button type="button" onClick={() => setShowReimport(v => !v)}
                      className="flex items-center gap-2 text-sm text-amber-400 hover:text-amber-300">
                      <RotateCcw className="w-4 h-4" /> {showReimport ? 'Annuler le réimport' : 'Réimporter une nouvelle configuration…'}
                    </button>
                    {showReimport && (
                      <>
                        <textarea
                          value={reimportConfig}
                          onChange={e => setReimportConfig(e.target.value)}
                          rows={5}
                          placeholder="Collez la NOUVELLE configuration fournisseur (remplace l'ancienne, version +1, cache mobile invalidé)"
                          className="w-full px-3 py-2.5 bg-[#07090e] border border-amber-500/30 rounded-xl text-amber-300 text-xs font-mono focus:outline-none focus:border-amber-500/60 resize-y"
                        />
                        {reimportConfig.trim() && (
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => handleTestImport(reimportConfig)} disabled={testing}
                              className="flex items-center gap-2 px-3 py-2 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-medium rounded-xl border border-sky-500/30 disabled:opacity-50">
                              <FlaskConical className="w-3.5 h-3.5" /> Tester avant de remplacer
                            </button>
                          </div>
                        )}
                        <p className="text-[11px] text-amber-500/80">
                          ⚠ Le réimport remplace intégralement la configuration technique (hash recalculé,
                          configVersion incrémentée). Les applications re-provisionneront automatiquement
                          au prochain démarrage.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              {editId && !isEditingImported && (
                <>
                  <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl text-xs text-amber-300">
                    ⚠ Profil <strong>legacy</strong> (saisie par colonnes). Pour passer au modèle importé
                    (config chiffrée, provisionnée à l'identique), créez un nouveau profil via
                    « Importer une configuration ».
                  </div>
                  <ManualForm form={legacyForm} f={fl} payloads={payloads} inputCls={inputCls} networks={NETWORKS} protocols={PROTOCOLS} editId={editId} />
                </>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">Annuler</button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-sm font-medium rounded-xl border border-emerald-500/20 disabled:opacity-50">
                  {saving ? '...' : editId ? (reimportConfig.trim() ? 'Réimporter (v+1)' : 'Mettre à jour') : createTab === 'import' ? 'Importer (chiffré)' : 'Créer (legacy)'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sous-formulaire legacy (colonnes) — INCHANGÉ, pour compatibilité ──────────
function ManualForm({ form, f, payloads, inputCls, networks, protocols, editId }: {
  form: any; f: (k: any, v: any) => void; payloads: SshPayload[];
  inputCls: string; networks: string[]; protocols: string[]; editId?: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">Protocole *</label>
        <select value={form.protocol} onChange={e => f('protocol', e.target.value)} className={inputCls}>
          {protocols.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">Hôte *</label>
        <input value={form.host} onChange={e => f('host', e.target.value)}
          placeholder="141.95.112.93" className={inputCls} />
      </div>
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">Port *</label>
        <input type="number" value={form.port} onChange={e => f('port', e.target.value)}
          placeholder="22" className={inputCls} />
      </div>

      {['ssh', 'ssh+payload'].includes(form.protocol) && <>
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Utilisateur SSH</label>
          <input value={form.username} onChange={e => f('username', e.target.value)}
            placeholder="ubuntu" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Mot de passe SSH</label>
          <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
            placeholder={editId ? 'Laisser vide pour conserver' : '••••••••'} className={inputCls} />
        </div>
        {form.protocol === 'ssh+payload' && (
          <div className="col-span-2">
            <label className="block text-sm text-gray-400 mb-1.5">
              Payload HTTP <span className="text-emerald-400">*</span>
              <span className="ml-2 text-xs text-gray-500">(injecté avant le handshake SSH)</span>
            </label>
            <select value={form.payloadId} onChange={e => f('payloadId', e.target.value)} required={form.protocol === 'ssh+payload'}
              className={inputCls}>
              <option value="">— Sélectionner un payload —</option>
              {payloads.filter(p => p.status === 'active').map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.host ? ` (${p.host})` : ''}
                </option>
              ))}
            </select>
            {payloads.length === 0 && (
              <p className="text-xs text-amber-400 mt-1.5">⚠️ Aucun payload actif — créez-en un dans l'onglet SSH Payloads</p>
            )}
          </div>
        )}
        {form.protocol === 'ssh' && form.tls && (
          <div className="col-span-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400">
            ⛔ <strong>SSH direct + TLS est impossible</strong> : le tunnel SSH direct n'applique pas TLS
            (cause du SSH_TIMEOUT). Choisissez « ssh+payload » si le serveur exige TLS/WebSocket,
            ou désactivez TLS. Cette combinaison est <strong>rejetée à l'import</strong> par le backend.
          </div>
        )}
      </>}

      {['vless', 'vmess'].includes(form.protocol) && (
        <div className="col-span-2">
          <label className="block text-sm text-gray-400 mb-1.5">UUID</label>
          <input value={form.uuid} onChange={e => f('uuid', e.target.value)}
            placeholder="Laissez vide pour générer automatiquement"
            className={`${inputCls} font-mono`} />
        </div>
      )}

      {['trojan', 'shadowsocks'].includes(form.protocol) && (
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Mot de passe</label>
          <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
            className={inputCls} />
        </div>
      )}

      {form.protocol !== 'ssh' && (
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Network</label>
          <select value={form.network} onChange={e => f('network', e.target.value)} className={inputCls}>
            {networks.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm text-gray-400 mb-1.5">SNI</label>
        <input value={form.sni} onChange={e => f('sni', e.target.value)}
          placeholder="example.com" className={inputCls} />
      </div>
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">Path</label>
        <input value={form.path} onChange={e => f('path', e.target.value)}
          placeholder="/" className={inputCls} />
      </div>
      <div>
        <button type="button" onClick={() => f('tls', !form.tls)}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${form.tls ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400' : 'bg-transparent border-[#1a1f2e] text-gray-500'}`}>
          {form.tls ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />} TLS/SSL
        </button>
      </div>
    </div>
  );
}
