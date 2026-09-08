import { isAdmin as isAdminRole } from '../lib/roles';
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from '../contexts/I18nContext';
import type { Translate } from '../lib/i18n';
import ProfileLockDialog, { validProfilePassword } from './ProfileLockDialog';
import { UserRole } from "../types";
import {
  fetchVpnProfiles, createVpnProfile, updateVpnProfile, deleteVpnProfile,
  fetchVpnProfileStats, testImportedConfig, testProfileConfig, importVpnProfiles,
  setProfileResellers, unlockVpnProfile, setVpnProfileLock,
  VpnProfile, ConfigTestResult,
} from "../api/vpn-profiles";
import { fetchResellers } from "../api/resellers";
import { fetchPayloads, SshPayload } from "../api/payload";
import {
  ShieldCheck, Plus, Trash2, RefreshCw, Edit3, X, AlertTriangle,
  Check, Wifi, Activity, Lock, Globe, UploadCloud, FlaskConical,
  FileKey2, RotateCcw, Info, Users,
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

const PROTOCOLS = ['ssh', 'ssh+payload', 'vless', 'vmess', 'trojan', 'shadowsocks', 'singbox', 'wireguard', 'hysteria2', 'tuic'];
const NETWORKS  = ['ws', 'grpc', 'tcp', 'h2'];

/** Formulaire administratif — champs NON techniques uniquement (mission §6.1) */
const DEFAULT_ADMIN_FORM = {
  name: '', description: '', displayProtocol: '',
  offlineValidDays: 7, status: 'active', dns: '',
};
/** Formulaire legacy (colonnes) — maintenu pour compat, déconseillé */
const DEFAULT_LEGACY_FORM = {
  protocol: 'ssh', host: '', port: '', username: '', password: '',
  uuid: '', path: '/', network: 'ws', tls: false, sni: '', wsHost: '',
  insecure: false,
  method: 'aes-256-gcm', payloadId: '' as string, payload: '',
  sshTransport: 'direct', proxyEnabled: false, proxyHost: '', proxyPort: '',
  slowDns: false, dns: '8.8.8.8', nameServer: '', slowDnsPublicKey: '', localPort: 2222,
  udpMode: 'none', udpGatewayHost: '127.0.0.1', udpGatewayPort: 7300,
  timeoutMs: 30000,
};

const sshImportTemplates = (t: Translate) => [
  {
    id: 'direct',
    label: t('configurations.ui.sshDirect'),
    value: {
      protocol: 'ssh', sshTransport: 'direct',
      host: 'ssh.example.com', port: 22, username: 'user', password: 'REMPLACEZ-MOI',
    },
  },
  {
    id: 'tls',
    label: t('configurations.ui.sshTls'),
    value: {
      protocol: 'ssh', sshTransport: 'tls',
      host: 'ssh.example.com', port: 443, username: 'user', password: 'REMPLACEZ-MOI',
      tls: true, sni: 'cdn.example.com',
    },
  },
  {
    id: 'connect',
    label: t('configurations.ui.sshConnect'),
    value: {
      protocol: 'ssh+payload', sshTransport: 'http-connect',
      host: 'ssh.example.com', port: 443, username: 'user', password: 'REMPLACEZ-MOI',
      tls: true, sni: 'www.example.com',
      payload: 'CONNECT [host_port] HTTP/1.1[crlf]Host: www.example.com[crlf]Proxy-Connection: Keep-Alive[crlf]User-Agent: [ua][crlf][crlf]',
    },
  },
  {
    id: 'slowdns',
    label: t('configurations.ui.sshSlowDns'),
    value: {
      protocol: 'ssh', sshTransport: 'slowdns',
      host: 'ssh.example.com', port: 22, username: 'user', password: 'REMPLACEZ-MOI',
      slowDns: true, dns: '8.8.8.8', nameServer: 't.example.com',
      slowDnsPublicKey: 'REMPLACEZ-PAR-64-CARACTERES-HEX', localPort: 2222,
    },
  },
  {
    id: 'udp',
    label: t('configurations.ui.sshUdp'),
    value: {
      protocol: 'ssh', sshTransport: 'direct',
      host: 'ssh.example.com', port: 22, username: 'user', password: 'REMPLACEZ-MOI',
      udpMode: 'udpgw', udpGatewayHost: '127.0.0.1', udpGatewayPort: 7300,
    },
  },
] as const;

// ── Verdicts du préflight (taxonomie mission §7) ──────────────────────────────
const verdictStyles = (t: Translate): Record<string, { label: string; cls: string }> => ({
  transport_ok:           { label: t('configurations.ui.transportOk'),              cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  unreachable_from_probe: { label: t('configurations.ui.probeUnreachable'), cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
  invalid:                { label: t('configurations.ui.invalidConfig'),    cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30' },
  unsupported:            { label: t('configurations.ui.syntaxOnly'), cls: 'text-gray-300 bg-gray-500/10 border-gray-500/30' },
  valid:                  { label: t('configurations.ui.transportOk'),              cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  unknown:                { label: t('configurations.ui.neverTested'),              cls: 'text-gray-400 bg-gray-500/10 border-gray-500/30' },
});

function VerdictBadge({ status, className = '' }: { status?: string | null; className?: string }) {
  const { t } = useTranslation();
  const VERDICT_STYLE = verdictStyles(t);
  const v = VERDICT_STYLE[status || 'unknown'] || VERDICT_STYLE.unknown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${v.cls} ${className}`}>
      {v.label}
    </span>
  );
}

type JsonEditorInfo = {
  valid: boolean;
  label: string;
  detail: string;
  lineCount: number;
  /** true pour une URI de partage : le formatage JSON ne s'y applique pas. */
  isUri?: boolean;
  profileCount?: number;
};

/**
 * Schémas d'URI de partage acceptés par parseImportedConfig() côté serveur.
 * L'éditeur les refusait auparavant (JSON.parse échouait), ce qui affichait
 * « JSON invalide » et désactivait le bouton de préflight : une URI restait
 * donc impossible à valider depuis le dashboard alors que le backend la gère.
 */
const SHARE_URI_SCHEMES: Array<{ re: RegExp; label: string }> = [
  { re: /^vless:\/\//i,           label: 'VLESS' },
  { re: /^vmess:\/\//i,           label: 'VMess' },
  { re: /^trojan:\/\//i,          label: 'Trojan' },
  { re: /^ss:\/\//i,              label: 'Shadowsocks' },
  { re: /^(hysteria2|hy2):\/\//i, label: 'Hysteria2' },
  { re: /^tuic:\/\//i,            label: 'TUIC' },
];

/**
 * Décrit une URI de partage sans la parser strictement (le backend reste seul
 * juge). Le but est de montrer à l'opérateur les trois noms d'hôte distincts
 * d'un lien VLESS WebSocket, qui sont la première cause d'erreur d'import :
 *   - l'autorité après « @ » = adresse TCP réellement contactée,
 *   - le paramètre « host » = en-tête Host WebSocket,
 *   - le paramètre « sni »  = nom présenté pendant le handshake TLS.
 */
function inspectShareUri(raw: string, protoLabel: string, lineCount: number, t: Translate): JsonEditorInfo {
  const text = raw.trim();
  const authority = text.match(/^[a-z0-9+]+:\/\/(?:[^@/?#]*@)?([^:/?#]+)(?::(\d+))?/i);
  const address = authority?.[1] ?? '';
  const port = authority?.[2] ?? '';
  const queryStart = text.indexOf('?');
  const hashStart = text.lastIndexOf('#');
  const query = queryStart === -1 ? '' : text.slice(queryStart + 1, hashStart > queryStart ? hashStart : undefined);
  const q = new URLSearchParams(query);
  const network = q.get('type') || q.get('network') || '';
  const security = q.get('security') || '';
  const wsHost = q.get('host') || '';
  const sni = q.get('sni') || '';
  const name = hashStart === -1 ? '' : decodeURIComponent(text.slice(hashStart + 1));

  if (!address) {
    return {
      valid: false, isUri: true, lineCount,
      label: t('configurations.editor.uriIncomplete', { protocol: protoLabel }),
      detail: t('configurations.ui.expectedUri'),
    };
  }

  const bits = [t('configurations.editor.server', { address: `${address}${port ? `:${port}` : ''}` })];
  if (network) bits.push(t('configurations.editor.transport', { network }));
  if (security) bits.push(security.toLowerCase() === 'reality' ? 'Reality' : security.toUpperCase());
  if (wsHost) bits.push(t('configurations.editor.wsHost', { host: wsHost }));
  if (sni) bits.push(sni === wsHost ? t('configurations.ui.sameSni') : t('configurations.editor.sni', { sni }));
  if (name) bits.push(t('configurations.editor.label', { name }));

  const detail = wsHost && wsHost !== address
    ? t('configurations.editor.authority', { details: bits.join(' · ') })
    : `${bits.join(' · ')}.`;

  return { valid: true, isUri: true, lineCount, label: t('configurations.editor.uriDetected', { protocol: protoLabel }), detail };
}

function inspectJsonEditor(raw: string, t: Translate): JsonEditorInfo {
  const lineCount = Math.max(1, raw.split(/\r?\n/).length);
  if (!raw.trim()) {
    return { valid: false, label: t('configurations.ui.waitingConfig'), detail: t('configurations.ui.pasteFullConfig'), lineCount };
  }
  const uriLines = raw.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => SHARE_URI_SCHEMES.some(scheme => scheme.re.test(line)));
  if (uriLines.length > 1) {
    return {
      valid: true,
      isUri: true,
      lineCount,
      profileCount: uriLines.length,
      label: t('configurations.editor.uriList', { count: uriLines.length }),
      detail: t('configurations.ui.atomicUri'),
    };
  }
  // Les abonnements V2Ray sont souvent un texte URI multi-ligne encodé en
  // base64. Détecter leur cardinalité ici permet de choisir l'endpoint batch
  // au lieu d'importer silencieusement la première ligne seulement.
  if (!/^(?:\{|\[|[a-z0-9+]+:\/\/)/i.test(raw.trim())) {
    try {
      const normalized = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      const decoded = atob(padded);
      const decodedUris = decoded.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => SHARE_URI_SCHEMES.some(scheme => scheme.re.test(line)));
      if (decodedUris.length > 1) {
        return {
          valid: true,
          isUri: true,
          lineCount,
          profileCount: decodedUris.length,
          label: t('configurations.editor.encoded', { count: decodedUris.length }),
          detail: t('configurations.ui.atomicDecode'),
        };
      }
    } catch { /* pas une souscription base64 : poursuivre la détection JSON */ }
  }
  const scheme = SHARE_URI_SCHEMES.find(s => s.re.test(raw.trim()));
  if (scheme) return inspectShareUri(raw, scheme.label, lineCount, t);
  if (/^\s*\[Interface\]/im.test(raw)) {
    return { valid: true, isUri: true, lineCount, label: t('configurations.ui.wireguardDetected'), detail: t('configurations.ui.wireguardHint') };
  }
  try {
    const obj = JSON.parse(raw);
    const configArray = !Array.isArray(obj) && obj && typeof obj === 'object'
      ? Object.entries(obj).find(([key, value]) =>
          key.toUpperCase().replace(/[^A-Z0-9]/g, '') === 'CONFIGS' && Array.isArray(value),
        )?.[1]
      : obj;
    const candidates = Array.isArray(configArray) ? configArray : [];
    const isHttpCustom = (entry: any) => {
      if (!entry || typeof entry !== 'object') return false;
      const keys = new Set(Object.keys(entry).map(key => key.toUpperCase().replace(/[^A-Z0-9]/g, '')));
      return keys.has('ADDRESS') && (keys.has('USERNAME') || keys.has('USER'))
        && ['TYPE', 'PAYLOADENABLED', 'PROXYENABLED', 'NSSERVER', 'LOCALPORT'].some(key => keys.has(key));
    };
    const httpCustomConfigs = candidates.filter(isHttpCustom);
    if (httpCustomConfigs.length > 0 && httpCustomConfigs.length === candidates.length) {
      return {
        valid: true,
        lineCount,
        profileCount: httpCustomConfigs.length,
        label: t('configurations.editor.httpCustom', { count: httpCustomConfigs.length }),
        detail: t('configurations.ui.httpCustomHint'),
      };
    }
    if (!obj || Array.isArray(obj) || typeof obj !== 'object') {
      return { valid: false, label: t('configurations.ui.objectExpected'), detail: t('configurations.ui.objectHint'), lineCount };
    }
    const outbounds = Array.isArray(obj.outbounds) ? obj.outbounds : [];
    const isXray = outbounds.some((o: any) => o && (
      typeof o.protocol === 'string' || o.settings?.vnext !== undefined || o.streamSettings !== undefined
    ));
    const isSingBox = outbounds.length > 0 && outbounds.every((o: any) => o && typeof o.type === 'string') && !isXray;
    const explicit = typeof obj.protocol === 'string' ? obj.protocol.toUpperCase() : '';
    const label = isXray ? t('configurations.ui.xrayDetected') : isSingBox ? t('configurations.ui.singboxDetected') : explicit ? t('configurations.editor.protocolDetected', { protocol: explicit }) : t('configurations.ui.jsonValid');
    const detail = isXray
      ? t('configurations.editor.xrayOutbounds', { count: outbounds.length })
      : isSingBox
        ? t('configurations.editor.singboxOutbounds', { count: outbounds.length })
        : t('configurations.ui.syntaxHint');
    return { valid: true, label, detail, lineCount };
  } catch (err: any) {
    return {
      valid: false,
      label: t('configurations.ui.unrecognized'),
      detail: t('configurations.editor.invalidFormat'),
      lineCount,
    };
  }
}

function JsonConfigEditor({
  value, onChange, onTest, testing, result,
}: {
  value: string;
  onChange: (value: string) => void;
  onTest: () => void;
  testing: boolean;
  result: ConfigTestResult | null;
}) {
  const { t, locale } = useTranslation();
  const info = inspectJsonEditor(value, t);
  const format = (minify: boolean) => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, minify ? 0 : 2));
    } catch {
      // Le diagnostic affiché sous l'éditeur indique déjà la position de l'erreur.
    }
  };
  const lineNumbers = Array.from({ length: info.lineCount }, (_, i) => i + 1).join('\n');
  return (
    <div className="space-y-3">
      <div className="p-3 bg-indigo-500/5 border border-indigo-500/20 rounded-xl text-xs text-indigo-200 space-y-1.5">
        <p className="font-medium flex items-center gap-1.5"><FileKey2 className="w-3.5 h-3.5" /> {t('configurations.ui.editorTitle')} </p>
        <p className="text-indigo-300/80"> {t('configurations.ui.editorHint')} </p>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className={`text-xs ${info.valid ? 'text-emerald-400' : 'text-amber-400'}`}>
          <span className="font-medium">{info.label}</span><span className="text-gray-500"> · {info.detail}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => format(false)} disabled={!value.trim() || info.isUri} className="px-2.5 py-1.5 rounded-lg border border-indigo-500/30 text-indigo-300 text-xs hover:bg-indigo-500/10 disabled:opacity-40"> {t('configurations.ui.format')} </button>
          <button type="button" onClick={() => format(true)} disabled={!value.trim() || info.isUri} className="px-2.5 py-1.5 rounded-lg border border-[#1a1f2e] text-gray-400 text-xs hover:bg-white/5 disabled:opacity-40"> {t('configurations.ui.minify')} </button>
          <button type="button" onClick={() => onChange('')} disabled={!value} className="px-2.5 py-1.5 rounded-lg border border-[#1a1f2e] text-gray-400 text-xs hover:bg-white/5 disabled:opacity-40"> {t('configurations.ui.clear')} </button>
        </div>
      </div>
      <div className="flex min-h-[260px] max-h-[520px] overflow-hidden rounded-xl border border-indigo-500/25 bg-[#07090e] focus-within:border-indigo-400/60">
        <pre aria-hidden="true" className="select-none overflow-hidden py-3 px-3 text-right text-[11px] leading-5 text-gray-600 bg-black/20 border-r border-white/5 font-mono whitespace-pre">{lineNumbers}</pre>
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={12}
          spellCheck={false}
          wrap="off"
          aria-label={t('configurations.ui.editorLabel')}
          placeholder={t('configurations.editor.placeholder')}
          className="flex-1 min-w-0 resize-y bg-transparent p-3 text-[12px] leading-5 text-emerald-300 font-mono outline-none whitespace-pre"
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-600">
        <span>{t('configurations.editor.size', { characters: value.length.toLocaleString(locale), lines: info.lineCount })}</span>
        <span> {t('configurations.ui.transportOnly')} </span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTest} disabled={testing || !value.trim() || !info.valid}
          className="flex items-center gap-2 px-3 py-2 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-medium rounded-xl border border-sky-500/30 disabled:opacity-50">
          <FlaskConical className="w-3.5 h-3.5" /> {
            testing
              ? t('configurations.ui.testing')
              : (info.profileCount || 0) > 1
                ? t('configurations.ui.testFirst')
                : t('configurations.ui.testTransport')
          }
        </button>
        <span className="text-[11px] text-gray-600">
          {(info.profileCount || 0) > 1
            ? t('configurations.ui.batchValidation')
            : t('configurations.ui.encryptedImport')}
        </span>
      </div>
      {result && <ProbeResultPanel result={result} />}
    </div>
  );
}

/** Panneau de résultat d'un préflight /api/config-test */
function ProbeResultPanel({ result }: { result: ConfigTestResult }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <VerdictBadge status={result.validationStatus} />
        {result.probe?.latencyMs != null && (
          <span className="text-xs text-gray-400"> {t('configurations.ui.latency')} {Math.round(result.probe.latencyMs)} {t('configurations.ui.milliseconds')} </span>
        )}
        {result.probe?.durationMs != null && (
          <span className="text-xs text-gray-600"> {t('configurations.ui.duration')} {result.probe.durationMs} {t('configurations.ui.milliseconds')} </span>
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
              {s.latencyMs != null && <span className="text-gray-600"> ({Math.round(s.latencyMs)} {t('configurations.ui.millisecondsEnd')} </span>}
            </li>
          ))}
        </ol>
      ) : null}
      {result.probe?.hint && (
        <p className="text-xs text-sky-400 flex items-start gap-1"><Info className="w-3 h-3 mt-0.5 shrink-0" />{result.probe.hint}</p>
      )}
      {result.validationStatus === 'unreachable_from_probe' && (
        <p className="text-xs text-gray-500"> {t('configurations.ui.probeHint')} </p>
      )}
    </div>
  );
}

export default function VpnProfilesView({ currentUserRole }: Props) {
  const { t, locale, errorMessage, message, errorText } = useTranslation();
  const SSH_IMPORT_TEMPLATES = sshImportTemplates(t);
  const isAdmin = isAdminRole(currentUserRole);
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
  const [error, setError]       = useState<React.ReactNode>('');
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [filterProto, setFilterProto] = useState('all');
  const [search, setSearch]     = useState('');
  const [payloads, setPayloads] = useState<SshPayload[]>([]);
  const [lockPassword, setLockPassword] = useState('');
  const [lockConfirmation, setLockConfirmation] = useState('');
  const [lockDialog, setLockDialog] = useState<{ profile: VpnProfile; mode: 'unlock' | 'set' } | null>(null);
  const grants = useRef(new Map<string, { token: string; expiresAt: number }>());
  const generation = useRef(0);
  const [lockRevision, setLockRevision] = useState(0);
  const lockProfile = (p: VpnProfile): VpnProfile => p.hasLock ? {
    id: p.id, name: p.name, description: p.description, displayProtocol: p.displayProtocol,
    status: p.status, offlineValidDays: p.offlineValidDays, createdAt: p.createdAt, updatedAt: p.updatedAt,
    _count: p._count, resellers: p.resellers, unrestricted: p.unrestricted, hasLock: true, isLocked: true,
  } : p;
  const clearTechnicalState = () => {
    generation.current++;
    setShowForm(false); setEditingProfile(null); setEditId(null);
    setImportConfig(''); setReimportConfig(''); setLegacyForm({ ...DEFAULT_LEGACY_FORM });
    setAdminForm({ ...DEFAULT_ADMIN_FORM }); setTestResult(null); setFieldErrors([]); setError('');
    setLockPassword(''); setLockConfirmation(''); setLockDialog(null);
    setTesting(false); setSaving(false);
    setPayloads([]);
  };
  const relock = (id?: string) => {
    if (id) grants.current.delete(id); else grants.current.clear();
    setProfiles(previous => previous.map(p => !id || p.id === id ? lockProfile(p) : p));
    clearTechnicalState();
    setLockRevision(revision => revision + 1);
  };
  const tokenFor = (id: string) => {
    const grant = grants.current.get(id);
    return grant && grant.expiresAt > Date.now() ? grant.token : undefined;
  };
  useEffect(() => {
    const expiry = Math.min(...[...grants.current.values()].map(grant => grant.expiresAt));
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => relock(), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [lockRevision]);
  useEffect(() => {
    const hide = () => { if (document.hidden) relock(); };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); grants.current.clear(); generation.current++; };
  }, []);
  const submitLock = async (password: string) => {
    if (!lockDialog) return;
    const epoch = generation.current;
    const { profile, mode } = lockDialog;
    if (mode === 'unlock') {
      const result = await unlockVpnProfile(profile.id, password);
      if (epoch !== generation.current) return;
      const expiresAt = Date.parse(result.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { relock(profile.id); return; }
      grants.current.set(profile.id, { token: result.unlockToken, expiresAt });
      setProfiles(previous => previous.map(p => p.id === profile.id ? {
        ...result.profile, resellers: p.resellers, unrestricted: p.unrestricted, _count: p._count,
      } : p));
      setLockRevision(revision => revision + 1);
      setLockDialog(null);
    } else {
      const updated = await setVpnProfileLock(profile.id, password, tokenFor(profile.id));
      if (epoch !== generation.current) return;
      relock(profile.id);
      setProfiles(previous => previous.map(p => p.id === profile.id ? { ...updated, resellers: p.resellers, unrestricted: p.unrestricted, _count: p._count } : p));
    }
  };

  // Attribution aux revendeurs
  const [resellersList, setResellersList] = useState<any[]>([]);
  const [assignProfile, setAssignProfile] = useState<VpnProfile | null>(null);
  const [assignSelected, setAssignSelected] = useState<Set<string>>(new Set());
  const [assignSaving, setAssignSaving] = useState(false);

  const load = async () => {
    relock();
    const epoch = generation.current;
    setLoading(true);
    try {
      const [profs, st, pays, rs] = await Promise.all([
        fetchVpnProfiles(),
        fetchVpnProfileStats(),
        fetchPayloads().catch(() => [] as SshPayload[]),
        // La liste des revendeurs n'est pas critique : son échec ne doit pas
        // empêcher l'affichage des configurations.
        fetchResellers().catch(() => [] as any[]),
      ]);
      if (epoch !== generation.current) return;
      setProfiles(profs.map(profile => profile.isLocked ? lockProfile(profile) : profile));
      setStats(st);
      setPayloads(pays);
      setResellersList(Array.isArray(rs) ? rs : []);
    } catch (failure) { setError(errorText(failure)); } finally { setLoading(false); }
  };

  const openAssign = (p: VpnProfile) => {
    setAssignProfile(lockProfile(p));
    setAssignSelected(new Set((p.resellers || []).map(r => r.resellerId)));
  };

  const saveAssign = async () => {
    if (!assignProfile) return;
    setAssignSaving(true);
    try {
      await setProfileResellers(assignProfile.id, Array.from(assignSelected));
      setAssignProfile(null);
      await load();
    } catch (err: any) {
      alert(errorMessage(err, 'configurations.ui.assignmentFailed'));
    } finally { setAssignSaving(false); }
  };

  useEffect(() => { load(); }, []);

  const resetModalState = () => {
    generation.current++;
    setLockPassword(''); setLockConfirmation('');
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
    if (p.hasLock && !tokenFor(p.id)) { relock(p.id); return; }
    setEditId(p.id); setEditingProfile(p);
    setAdminForm({
      name: p.name, description: p.description || '',
      displayProtocol: p.displayProtocol || '',
      offlineValidDays: p.offlineValidDays, status: p.status,
      dns: p.dns || '',
    });
    setLegacyForm({
      ...DEFAULT_LEGACY_FORM,
      protocol: p.protocol || 'ssh', host: p.host || '', port: String(p.port || ''),
      username: p.username || '', password: '', uuid: p.uuid || '',
      path: p.path || '/', network: p.network || 'ws', tls: !!p.tls, sni: p.sni || '', wsHost: '',
      method: p.method || 'aes-256-gcm', payloadId: (p as any).payloadId || '', payload: '',
    });
    resetModalState(); setShowForm(true);
  };

  /** Extrait les erreurs détaillées d'un 422 backend (IMPORT_INVALID). */
  const extractErrors = (err: any): React.ReactNode => {
    const lockCodes = ['PROFILE_LOCKED', 'PROFILE_UNLOCK_FAILED', 'PROFILE_LOCK_PASSWORD_INVALID',
      'PROFILE_UNLOCK_RATE_LIMITED', 'PROFILE_ENGINE_LINK_AMBIGUOUS', 'PROFILE_ENGINE_LINKED'];
    if (lockCodes.includes(err?.code)) return message(`configurations.lock.errors.${err.code}`);
    if (err?.status === 422) {
      const details = err?.responseData?.details;
      const list: string[] = Array.isArray(details)
        ? details.flatMap((entry: any) => [
            ...(entry?.errors || []).map((message: string) =>
              `#${Number(entry?.index ?? 0) + 1}${entry?.name ? ` « ${entry.name} »` : ''} : ${message}`,
            ),
            ...(entry?.warnings || []).map((message: string) =>
              `⚠ #${Number(entry?.index ?? 0) + 1} : ${message}`,
            ),
          ])
        : [
            ...(details?.errors || []),
            ...(details?.warnings || []).map((w: string) => `⚠ ${w}`),
          ];
      setFieldErrors(list);
      return message('configurations.ui.importInvalid');
    }
    if (err?.status === 409) {
      return errorText(err, 'configurations.ui.immutable');
    }
    return errorText(err, 'configurations.ui.error');
  };

  // ── Préflight : tester le texte d'import AVANT persistance ─────────────────
  const handleTestImport = async (raw: string) => {
    const epoch = generation.current;
    if (!raw.trim()) { setError(message('configurations.ui.pasteFirst')); return; }
    setTesting(true); setError(''); setFieldErrors([]); setTestResult(null);
    try {
      const result = await testImportedConfig(raw);
      if (epoch !== generation.current) return;
      setTestResult(result);
    } catch (err: any) {
      if (epoch !== generation.current) return;
      setError(extractErrors(err));
    } finally { if (epoch === generation.current) setTesting(false); }
  };

  // ── Préflight : tester la config stockée d'un profil ───────────────────────
  const handleTestProfile = async (id: string) => {
    const epoch = generation.current;
    const token = tokenFor(id);
    setTesting(true); setError(''); setTestResult(null);
    try {
      const result = await testProfileConfig(id, token);
      if (epoch !== generation.current || (token && token !== tokenFor(id))) return;
      setTestResult(result);
    } catch (err: any) {
      if (epoch !== generation.current) return;
      if (err?.status === 423) relock(id);
      setError(extractErrors(err));
    } finally { if (epoch === generation.current) setTesting(false); }
  };

  // ── Soumission ──────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const epoch = generation.current;
    setSaving(true); setError(''); setFieldErrors([]);
    try {
      if (!editId && (!validProfilePassword(lockPassword) || lockPassword !== lockConfirmation)) {
        setError(message('configurations.lock.invalid')); return;
      }
      let savedProfile: VpnProfile | null = null;
      if (editId) {
        const isImported = !!editingProfile?.hasCanonicalConfig;
        if (reimportConfig.trim()) {
          // Réimport EXPLICITE — seule voie de modification technique (§6.1)
          savedProfile = await updateVpnProfile(editId, {
            importConfig: reimportConfig,
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
          }, tokenFor(editId));
        } else if (isImported) {
          // Profil importé : UNIQUEMENT les champs administratifs (jamais de technique)
          savedProfile = await updateVpnProfile(editId, {
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
          }, tokenFor(editId));
        } else {
          // Profil legacy : champs techniques immuables côté backend (PUT rejette tout champ technique avec 409)
          // → on n'envoie QUE les champs administratifs autorisés
          if (!adminForm.name) { setError(message('configurations.ui.nameRequired')); setSaving(false); return; }
          savedProfile = await updateVpnProfile(editId, {
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
          }, tokenFor(editId));
        }
      } else if (createTab === 'import') {
        if (!adminForm.name) { setError(message('configurations.ui.nameRequired')); setSaving(false); return; }
        if (!importConfig.trim()) { setError(message('configurations.ui.pasteProvider')); setSaving(false); return; }
        const editorInfo = inspectJsonEditor(importConfig, t);
        if ((editorInfo.profileCount || 0) > 1) {
          const batch = await importVpnProfiles({
            importConfig,
            lockPassword,
            namePrefix: adminForm.name,
            description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
          });
          savedProfile = batch.profiles[0] || null;
          if (epoch !== generation.current) return;
          if (batch.warnings.length) {
            alert(t('configurations.notices.batchWarning', { count: batch.imported, warnings: batch.warnings.join('\n') }));
          } else {
            alert(t('configurations.notices.batchCreated', { count: batch.imported }));
          }
        } else {
          savedProfile = await createVpnProfile({
            name: adminForm.name, description: adminForm.description,
            displayProtocol: adminForm.displayProtocol,
            status: adminForm.status,
            offlineValidDays: Number(adminForm.offlineValidDays),
            dns: adminForm.dns || undefined,
            importConfig,
            lockPassword,
          });
        }
      } else {
        if (lockPassword === legacyForm.password) {
          setError(message('configurations.lock.mustDiffer')); return;
        }
        if (!adminForm.name || !legacyForm.host || !legacyForm.port) {
          setError(message('configurations.ui.requiredFields')); setSaving(false); return;
        }
        const candidatePayload = payloads.find(p => p.id === legacyForm.payloadId);
        const selectedPayload = candidatePayload && 'content' in candidatePayload ? candidatePayload : undefined;
        const payload = legacyForm.payload.trim() || selectedPayload?.content?.trim() || '';
        if (legacyForm.protocol === 'ssh+payload' && !payload) {
          setError(message('configurations.ui.payloadRequired')); setSaving(false); return;
        }
        if (legacyForm.slowDns && (!legacyForm.dns.trim() || !legacyForm.nameServer.trim() || !/^[0-9a-f]{64}$/i.test(legacyForm.slowDnsPublicKey.trim()))) {
          setError(message('configurations.ui.slowDnsRequired'));
          setSaving(false);
          return;
        }
        if (legacyForm.udpMode === 'udpgw' && (!legacyForm.udpGatewayHost.trim() || !Number(legacyForm.udpGatewayPort))) {
          setError(message('configurations.ui.udpRequired'));
          setSaving(false);
          return;
        }
        const manualConfig: Record<string, any> = {
          protocol: legacyForm.protocol,
          host: legacyForm.host.trim(),
          port: Number(legacyForm.port),
          username: legacyForm.username.trim() || undefined,
          password: legacyForm.password || undefined,
          uuid: legacyForm.uuid.trim() || undefined,
          path: legacyForm.path.trim() || undefined,
          network: legacyForm.network || undefined,
          tls: legacyForm.tls,
          insecure: legacyForm.insecure,
          sni: legacyForm.sni.trim() || selectedPayload?.sni || undefined,
          // En-tête Host WebSocket — distinct de l'adresse TCP et du SNI. Sans
          // lui, un fournisseur qui route par le Host renvoie une 404 alors que
          // le handshake TLS a réussi, panne indiscernable d'un serveur mort.
          wsHost: legacyForm.wsHost.trim() || undefined,
          method: legacyForm.method || undefined,
          payload: payload || undefined,
          sshTransport: legacyForm.sshTransport,
          proxyEnabled: legacyForm.proxyEnabled,
          proxyHost: legacyForm.proxyHost.trim() || undefined,
          proxyPort: legacyForm.proxyPort ? Number(legacyForm.proxyPort) : undefined,
          slowDns: legacyForm.slowDns,
          dns: legacyForm.dns.trim() || undefined,
          nameServer: legacyForm.nameServer.trim() || undefined,
          slowDnsPublicKey: legacyForm.slowDnsPublicKey.trim() || undefined,
          localPort: Number(legacyForm.localPort || 2222),
          udpMode: legacyForm.udpMode,
          udpGatewayHost: legacyForm.udpGatewayHost.trim() || undefined,
          udpGatewayPort: legacyForm.udpMode === 'udpgw'
            ? Number(legacyForm.udpGatewayPort || 7300)
            : undefined,
          timeoutMs: Number(legacyForm.timeoutMs || 30000),
        };
        savedProfile = await createVpnProfile({
          name: adminForm.name, description: adminForm.description,
          displayProtocol: adminForm.displayProtocol,
          status: adminForm.status,
          offlineValidDays: Number(adminForm.offlineValidDays),
          dns: adminForm.dns || undefined,
          importConfig: JSON.stringify(manualConfig),
          lockPassword,
        });
      }
      if (epoch !== generation.current) return;
      setShowForm(false);
      await load();
      // Les avertissements du serveur (doublon de configuration notamment)
      // doivent remonter à l'opérateur : ils étaient jusqu'ici perdus, donc un
      // profil techniquement identique à un autre s'ajoutait sans un mot.
      const warnings = (savedProfile as any)?._warnings as string[] | undefined;
      if (warnings?.length) {
        alert(t('configurations.notices.savedWarnings', { warnings: warnings.join('\n') }));
      }
    } catch (err: any) {
      if (epoch !== generation.current) return;
      if (err?.status === 423) relock(editId || undefined);
      setError(extractErrors(err));
    }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string, count: number) => {
    if (count > 0) { alert(t('configurations.notices.inUse', { count })); return; }
    if (!confirm(t('configurations.notices.confirmDelete', { name }))) return;
    try { await deleteVpnProfile(id, tokenFor(id)); await load(); }
    catch (failure) { relock(id); setError(extractErrors(failure)); }
  };

  const filtered = profiles.map(p => p.isLocked ? lockProfile(p) : p).filter(p =>
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
            <h1 className="text-xl font-bold text-white"> {t('configurations.ui.title')} </h1>
            <p className="text-sm text-gray-500"> {t('configurations.ui.subtitle')} </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button aria-label={t('configurations.ui.refresh')} onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl text-sm font-medium border border-emerald-500/20 transition-colors">
              <Plus className="w-4 h-4" /> {t('configurations.ui.import')} </button>
          )}
        </div>
      </div>

      {/* Stats */}
      {error && !showForm && <p role="alert" className="text-rose-400 text-sm">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('configurations.ui.total'), value: stats.total,  color: 'text-white' },
          { label: t('configurations.ui.active'),        value: stats.active, color: 'text-emerald-400' },
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
              }`}>{p === 'all' ? t('configurations.ui.all') : p}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('configurations.ui.search')}
          className="px-3 py-1.5 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 sm:ml-auto" />
      </div>

      {/* Profile Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-3 text-center py-12 text-gray-500"> {t('configurations.ui.loading')} </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-3 text-center py-12 text-gray-500">
            <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p> {t('configurations.ui.empty')} </p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-emerald-400 hover:text-emerald-300 text-sm"> {t('configurations.ui.firstImport')} </button>}
          </div>
        ) : filtered.map(p => (
          <div key={p.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="text-white font-semibold truncate">{p.name}</h3>
                {p.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{p.description}</p>}
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${PROTO_COLORS[p.protocol || ''] || 'text-gray-400 bg-gray-500/10'}`}>
                    {p.protocol}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${p.status === 'active' ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-400 bg-gray-500/10'}`}>
                    {['active', 'inactive', 'archived', 'suspended'].includes(p.status) ? t(`configurations.status.${p.status}`) : p.status}
                  </span>
                  {p.tls && <span className="text-xs px-2 py-0.5 rounded-full text-cyan-400 bg-cyan-500/10"> {t('configurations.ui.tls')} </span>}
                  {p.hasCanonicalConfig && (
                    <span className="text-xs px-2 py-0.5 rounded-full text-sky-400 bg-sky-500/10" title={p.canonicalConfigHash || ''}>
                      <FileKey2 className="w-3 h-3 inline mr-0.5" /> {t('configurations.ui.importedVersion')} {p.configVersion ?? 1}
                      {p.sourceFormat ? ` · ${p.sourceFormat}` : ''}
                    </span>
                  )}
                  {p.validationStatus && p.validationStatus !== 'unknown' && (
                    <VerdictBadge status={p.validationStatus} />
                  )}
                  {p._count && p._count.subscriptions > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full text-amber-400 bg-amber-500/10">
                      {p._count.subscriptions} {t('configurations.ui.subscriptions')} </span>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div className="flex gap-1 ml-2 shrink-0">
                  <button aria-label={t('configurations.ui.edit')} disabled={p.isLocked} onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors disabled:opacity-30">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button aria-label={t('configurations.ui.delete')} disabled={p.isLocked} onClick={() => handleDelete(p.id, p.name, p._count?.subscriptions || 0)}
                    className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="text-gray-400">{t(p.isLocked ? 'configurations.lock.locked' : p.hasLock ? 'configurations.lock.unlocked' : 'configurations.lock.legacy')}</span>
              {p.hasLock && <button className="text-emerald-400" onClick={() => {
                if (p.isLocked) { generation.current++; setLockDialog({ profile: p, mode: 'unlock' }); }
                else relock(p.id);
              }}>{t(p.isLocked ? 'configurations.lock.open' : 'configurations.lock.close')}</button>}
              {isAdmin && !p.isLocked && <button className="text-amber-400" onClick={() => {
                generation.current++; setLockDialog({ profile: p, mode: 'set' });
              }}>{t(p.hasLock ? 'configurations.lock.rotate' : 'configurations.lock.add')}</button>}
              {p.unlockExpiresAt && !p.isLocked && <span className="text-gray-500">
                {t('configurations.lock.expires', { time: new Date(p.unlockExpiresAt).toLocaleTimeString(locale) })}
              </span>}
            </div>
            {!p.isLocked && <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Globe className="w-3 h-3" /> {t('configurations.ui.server')} </p>
                <p className="text-white font-mono truncate">{p.host}:{p.port}</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Wifi className="w-3 h-3" /> {t('configurations.ui.network')} </p>
                <p className="text-white">{p.network || '—'}{p.path ? ` ${p.path}` : ''}</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Activity className="w-3 h-3" /> {t('configurations.ui.offline')} </p>
                <p className="text-white">{p.offlineValidDays} {t('configurations.ui.validDays')} </p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Lock className="w-3 h-3" /> {t('configurations.ui.storage')} </p>
                <p className="text-emerald-400">{p.hasCanonicalConfig ? t('configurations.ui.canonicalStorage') : t('configurations.ui.legacyStorage')}</p>
              </div>
            </div>}
            {p.validationMessage && p.validationStatus !== 'transport_ok' && (
              <p className="text-xs text-gray-500 truncate" title={p.validationMessage}>↳ {p.validationMessage}</p>
            )}

            {/* Attribution aux revendeurs — une configuration sans attribution
                reste disponible pour tous, c'est le cas des profils historiques. */}
            <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-[#1a1f2e]">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <Users className="w-3 h-3 text-gray-500 shrink-0" />
                {p.unrestricted !== false && (!p.resellers || p.resellers.length === 0) ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400 border border-gray-500/20">
                    {t('configurations.notices.noResellers')}
                  </span>
                ) : (
                  (p.resellers || []).slice(0, 3).map(r => (
                    <span key={r.resellerId} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20 truncate max-w-[110px]">
                      {r.name || r.email || r.resellerId}
                    </span>
                  ))
                )}
                {(p.resellers?.length || 0) > 3 && (
                  <span className="text-[10px] text-gray-500">+{(p.resellers!.length - 3)}</span>
                )}
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => openAssign(p)}
                  className="shrink-0 text-[11px] px-2 py-1 rounded-lg border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 cursor-pointer"
                > {t('configurations.ui.assign')} </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Modale d'attribution aux revendeurs */}
      {assignProfile && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold text-sm">{t('configurations.notices.assignTitle', { name: assignProfile.name })}</h2>
              <button onClick={() => setAssignProfile(null)} className="p-1.5 text-gray-400 hover:text-white rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-gray-400"> {t('configurations.ui.assignHint')} <span className="block mt-1 text-gray-500">
                  {t('configurations.notices.assignmentHint')}
                </span>
              </p>
              {resellersList.length === 0 ? (
                <p className="text-xs text-gray-500"> {t('configurations.ui.noResellers')} </p>
              ) : (
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {resellersList.map(r => (
                    <label key={r.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[#07090e] border border-[#1a1f2e] cursor-pointer hover:border-violet-500/30">
                      <input
                        type="checkbox"
                        checked={assignSelected.has(r.id)}
                        onChange={() => setAssignSelected(prev => {
                          const next = new Set(prev);
                          next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                          return next;
                        })}
                        className="rounded border-[#1a1f2e] bg-[#07090e] accent-violet-500 cursor-pointer"
                      />
                      {/* `/api/resellers` aplatit le nom et l'e-mail à la racine
                          (il n'y a pas d'objet `user` imbriqué) : lire `r.user.name`
                          renvoyait undefined et l'interface retombait sur l'UUID,
                          affichant des identifiants illisibles à la place des noms. */}
                      <span className="text-xs text-gray-200 truncate">{r.name || r.email || r.user?.name || r.user?.email || r.id}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex gap-2 justify-end pt-1">
                <button type="button" onClick={() => setAssignSelected(new Set())}
                  className="px-3 py-2 text-xs rounded-lg border border-[#1a1f2e] text-gray-400 hover:bg-white/5 cursor-pointer"> {t('configurations.ui.removeAll')} </button>
                <button type="button" onClick={saveAssign} disabled={assignSaving}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-violet-500 hover:bg-violet-400 text-white disabled:opacity-50 cursor-pointer">
                  {assignSaving ? t('configurations.ui.saving') : t('configurations.ui.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">
                {editId ? (isEditingImported ? t('configurations.ui.importedProfile') : t('configurations.ui.editLegacy')) : t('configurations.ui.importTitle')}
              </h2>
              <button onClick={clearTechnicalState} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
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
                  <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.profileName')} </label>
                  <input value={adminForm.name} onChange={e => fa('name', e.target.value)} required
                    placeholder={t('configurations.ui.namePlaceholder')} className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.mobileName')} <span className="ml-2 text-xs text-emerald-400/70"> {t('configurations.ui.displayName')} </span>
                  </label>
                  <input value={adminForm.displayProtocol} onChange={e => fa('displayProtocol', e.target.value)}
                    placeholder={t('configurations.ui.displayPlaceholder')}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-emerald-500/30 rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.description')} </label>
                  <input value={adminForm.description} onChange={e => fa('description', e.target.value)}
                    placeholder={t('configurations.ui.descriptionPlaceholder')} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.status')} </label>
                  <select value={adminForm.status} onChange={e => fa('status', e.target.value)} className={inputCls}>
                    <option value="active"> {t('configurations.ui.activeOption')} </option>
                    <option value="inactive"> {t('configurations.ui.inactiveOption')} </option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.offlineDays')} </label>
                  <input type="number" value={adminForm.offlineValidDays} onChange={e => fa('offlineValidDays', Number(e.target.value))}
                    min={1} max={30} className={inputCls} />
                </div>
              </div>

              {/* ═══ CRÉATION : onglets Import / Manuel ═══ */}
              {!editId && (
                <div>
                  <div className="p-3 mb-4 border border-amber-500/30 rounded-xl space-y-3">
                    <p className="text-xs text-amber-300">{t('configurations.lock.help')}</p>
                    <label className="block text-sm text-gray-400">{t('configurations.lock.password')}
                      <input name="lockPassword" required type="password" autoComplete="new-password" value={lockPassword}
                        onChange={e => setLockPassword(e.target.value)} maxLength={72} className={inputCls} />
                    </label>
                    <label className="block text-sm text-gray-400">{t('configurations.lock.confirm')}
                      <input name="lockConfirmation" required type="password" autoComplete="new-password" value={lockConfirmation}
                        onChange={e => setLockConfirmation(e.target.value)} maxLength={72} className={inputCls} />
                    </label>
                  </div>
                  <div className="flex gap-2 mb-4">
                    <button type="button" onClick={() => setCreateTab('import')}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${createTab === 'import' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'border-[#1a1f2e] text-gray-500'}`}>
                      <UploadCloud className="w-3.5 h-3.5" /> {t('configurations.ui.importRecommended')} </button>
                    <button type="button" onClick={() => setCreateTab('manual')}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${createTab === 'manual' ? 'bg-white/5 border-white/20 text-gray-300' : 'border-[#1a1f2e] text-gray-500'}`}> {t('configurations.ui.manual')} </button>
                  </div>

                  {createTab === 'import' && (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold text-cyan-300"> {t('configurations.ui.sshTemplates')} </p>
                            <p className="text-[11px] text-gray-500 mt-0.5"> {t('configurations.ui.sshTemplatesHint')} </p>
                          </div>
                          <span className="text-[10px] text-gray-600"> {t('configurations.ui.encryptedSecrets')} </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {SSH_IMPORT_TEMPLATES.map(template => (
                            <button
                              key={template.id}
                              type="button"
                              onClick={() => {
                                setImportConfig(JSON.stringify(template.value, null, 2));
                                setTestResult(null);
                                if (!adminForm.name) fa('name', template.label);
                              }}
                              className="px-2.5 py-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/10 text-cyan-300 text-[11px] hover:bg-cyan-500/20"
                            >
                              {template.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <JsonConfigEditor
                        value={importConfig}
                        onChange={setImportConfig}
                        onTest={() => handleTestImport(importConfig)}
                        testing={testing}
                        result={testResult}
                      />
                    </div>
                  )}

                  {createTab === 'manual' && (
                    <div className="space-y-3">
                      <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-xs text-emerald-300"> {t('configurations.ui.manualHint')} </div>
                          <ManualForm form={legacyForm} f={fl} payloads={payloads} inputCls={inputCls} networks={NETWORKS} protocols={PROTOCOLS} />
                      {legacyForm.protocol === 'ssh+payload' && (
                        <p className="text-[11px] text-gray-500"> {t('configurations.ui.fullPayload')} </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ═══ ÉDITION ═══ */}
              {editId && isEditingImported && editingProfile && (
                <div className="space-y-4">
                  {/* Bandeau immuabilité */}
                  <div className="p-3 bg-sky-500/5 border border-sky-500/20 rounded-xl text-xs text-sky-300 space-y-1.5">
                    <p className="font-medium flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" /> {t('configurations.ui.importedConfigVersion')} {editingProfile.configVersion ?? 1}
                      {editingProfile.sourceFormat ? ` (${editingProfile.sourceFormat})` : ''} {t('configurations.ui.immutableSuffix')} </p>
                    <p className="text-sky-400/80"> {t('configurations.ui.immutableHint')} <strong> {t('configurations.ui.explicitReimport')} </strong> {t('configurations.ui.reimportVersion')} </p>
                    {editingProfile.canonicalConfigHash && (
                      <p className="font-mono text-[10px] text-sky-500/70 break-all">
                        sha256: {editingProfile.canonicalConfigHash}
                      </p>
                    )}
                    <div className="flex items-center gap-2 pt-1 flex-wrap">
                      <VerdictBadge status={editingProfile.validationStatus} />
                      {editingProfile.validatedAt && (
                        <span className="text-[11px] text-gray-500">{t('configurations.notices.testedAt', { date: new Date(editingProfile.validatedAt).toLocaleString(locale) })}</span>
                      )}
                      {editingProfile.importedAt && (
                        <span className="text-[11px] text-gray-500">{t('configurations.notices.importedAt', { date: new Date(editingProfile.importedAt).toLocaleString(locale) })}</span>
                      )}
                    </div>
                  </div>

                  {/* Champs techniques EN LECTURE SEULE */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5"> {t('configurations.ui.lockedProtocol')} </label>
                      <input value={editingProfile.protocol} readOnly disabled className={readonlyCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5"> {t('configurations.ui.lockedHostPort')} </label>
                      <input value={`${editingProfile.host}:${editingProfile.port}`} readOnly disabled className={readonlyCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5"> {t('configurations.ui.lockedTls')} </label>
                      <input value={`${editingProfile.tls ? t('configurations.ui.tlsEnabled') : t('configurations.ui.noTls')}${editingProfile.sni ? ` · ${editingProfile.sni}` : ''}`} readOnly disabled className={readonlyCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1.5"> {t('configurations.ui.lockedTransport')} </label>
                      <input value={`${editingProfile.network || '—'}${editingProfile.path ? ` · ${editingProfile.path}` : ''}`} readOnly disabled className={readonlyCls} />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm text-gray-500 mb-1.5"> {t('configurations.ui.lockedCredentials')} </label>
                      <input value={t('configurations.ui.encryptedCredentials')} readOnly disabled className={readonlyCls} />
                    </div>
                  </div>

                  <button type="button" onClick={() => handleTestProfile(editId!)} disabled={testing}
                    className="flex items-center gap-2 px-3 py-2 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-medium rounded-xl border border-sky-500/30 disabled:opacity-50">
                    <FlaskConical className="w-3.5 h-3.5" /> {testing ? t('configurations.ui.testing') : t('configurations.ui.testImported')}
                  </button>
                  {testResult && <ProbeResultPanel result={testResult} />}

                  {/* Réimport explicite */}
                  <div className="border border-[#1a1f2e] rounded-xl p-4 space-y-3">
                    <button type="button" onClick={() => setShowReimport(v => !v)}
                      className="flex items-center gap-2 text-sm text-amber-400 hover:text-amber-300">
                      <RotateCcw className="w-4 h-4" /> {showReimport ? t('configurations.ui.cancelReimport') : t('configurations.ui.reimport')}
                    </button>
                    {showReimport && (
                      <>
                        <textarea
                          value={reimportConfig}
                          onChange={e => setReimportConfig(e.target.value)}
                          rows={5}
                          placeholder={t('configurations.ui.reimportPlaceholder')}
                          className="w-full px-3 py-2.5 bg-[#07090e] border border-amber-500/30 rounded-xl text-amber-300 text-xs font-mono focus:outline-none focus:border-amber-500/60 resize-y"
                        />
                        {reimportConfig.trim() && (
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => handleTestImport(reimportConfig)} disabled={testing}
                              className="flex items-center gap-2 px-3 py-2 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-medium rounded-xl border border-sky-500/30 disabled:opacity-50">
                              <FlaskConical className="w-3.5 h-3.5" /> {t('configurations.ui.testBeforeReplacing')} </button>
                          </div>
                        )}
                        <p className="text-[11px] text-amber-500/80"> {t('configurations.ui.reimportWarning')} </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              {editId && !isEditingImported && (
                <>
                  <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl text-xs text-amber-300"> {t('configurations.ui.legacyPrefix')} <strong> {t('configurations.ui.legacy')} </strong> {t('configurations.ui.legacyHint')} </div>
                  <ManualForm form={legacyForm} f={fl} payloads={payloads} inputCls={inputCls} networks={NETWORKS} protocols={PROTOCOLS} editId={editId} />
                </>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={clearTechnicalState}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5"> {t('configurations.ui.cancel')} </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-sm font-medium rounded-xl border border-emerald-500/20 disabled:opacity-50">
                  {saving ? '...' : editId ? (reimportConfig.trim() ? t('configurations.ui.reimportSave') : t('configurations.ui.update')) : t('configurations.ui.saveEncrypt')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {lockDialog && <ProfileLockDialog name={lockDialog.profile.name} mode={lockDialog.mode}
        onSubmit={submitLock} onClose={() => { generation.current++; setLockDialog(null); }} />}
    </div>
  );
}

// ── Sous-formulaire legacy (colonnes) — INCHANGÉ, pour compatibilité ──────────
function ManualForm({ form, f, payloads, inputCls, networks, protocols, editId }: {
  form: any; f: (k: any, v: any) => void; payloads: SshPayload[];
  inputCls: string; networks: string[]; protocols: string[]; editId?: string | null;
}) {
  const { t } = useTranslation();
  // Quand on édite un profil existant, tous les champs techniques sont immuables
  // (le backend renvoie 409 si on en envoie). On les affiche en lecture seule.
  const locked = !!editId;
  const lockedCls = locked
    ? `${inputCls} opacity-60 cursor-not-allowed pointer-events-none select-none`
    : inputCls;
  const sshFamily = ['ssh', 'ssh+payload'].includes(form.protocol);
  const setSshTransport = (transport: string) => {
    f('sshTransport', transport);
    f('protocol', ['payload', 'payload-tls', 'http-connect'].includes(transport) ? 'ssh+payload' : 'ssh');
    f('tls', ['tls', 'payload-tls'].includes(transport));
    f('proxyEnabled', transport === 'http-connect');
    f('slowDns', transport === 'slowdns');
  };
  return (
    <div className="grid grid-cols-2 gap-4">
      {locked && (
        <div className="col-span-2 flex items-center gap-2 px-3 py-2 bg-zinc-800/60 border border-zinc-700/50 rounded-xl text-xs text-zinc-400">
          <Lock className="w-3.5 h-3.5 shrink-0" /> {t('configurations.ui.technicalFields')} <strong className="text-zinc-300"> {t('configurations.ui.lockedFields')} </strong> {t('configurations.ui.newImportHint')} </div>
      )}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.protocol')} {!locked && '*'}</label>
        <select value={form.protocol} onChange={e => f('protocol', e.target.value)} className={lockedCls} disabled={locked}>
          {protocols.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.host')} {!locked && '*'}</label>
        <input value={form.host} onChange={e => f('host', e.target.value)}
          placeholder="141.95.112.93" className={lockedCls} disabled={locked} readOnly={locked} />
      </div>
      <div>
        <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.port')} {!locked && '*'}</label>
        <input type="number" value={form.port} onChange={e => f('port', e.target.value)}
          placeholder="22" className={lockedCls} disabled={locked} readOnly={locked} />
      </div>

      {['ssh', 'ssh+payload'].includes(form.protocol) && <>
        <div className="col-span-2">
          <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.sshTransport')} </label>
          <select value={form.sshTransport} onChange={e => setSshTransport(e.target.value)}
            className={lockedCls} disabled={locked}>
            <option value="direct"> {t('configurations.ui.directTcp')} </option>
            <option value="tls"> {t('configurations.ui.sshOverTls')} </option>
            <option value="payload"> {t('configurations.ui.sshPayload')} </option>
            <option value="payload-tls"> {t('configurations.ui.sshPayloadTls')} </option>
            <option value="http-connect"> {t('configurations.ui.sshProxy')} </option>
            <option value="slowdns"> {t('configurations.ui.sshDnstt')} </option>
          </select>
          <p className="text-[11px] text-gray-500 mt-1"> {t('configurations.ui.transportOrder')} </p>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.sshUsername')} </label>
          <input value={form.username} onChange={e => f('username', e.target.value)}
            placeholder="ubuntu" className={lockedCls} disabled={locked} readOnly={locked} />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.sshPassword')} </label>
          <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
            placeholder={locked ? '••••••••' : '••••••••'} className={lockedCls} disabled={locked} readOnly={locked} />
        </div>
        {form.protocol === 'ssh+payload' && (
          <div className="col-span-2">
            <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.httpPayload')} <span className="text-emerald-400">*</span>
              <span className="ml-2 text-xs text-gray-500"> {t('configurations.ui.payloadBeforeSsh')} </span>
            </label>
            <select value={form.payloadId} onChange={e => f('payloadId', e.target.value)}
              className={inputCls}>
              <option value=""> {t('configurations.ui.selectPayload')} </option>
              {payloads.filter(p => p.status === 'active' && 'content' in p).map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{'host' in p && p.host ? ` (${p.host})` : ''}
                </option>
              ))}
            </select>
            {payloads.length === 0 && (
              <p className="text-xs text-amber-400 mt-1.5"> {t('configurations.ui.noPayload')} </p>
            )}
            <textarea value={form.payload || ''} onChange={e => f('payload', e.target.value)}
              rows={6} placeholder={'CONNECT exemple.com HTTP/1.1[crlf]Host: exemple.com[crlf]User-Agent: Mozilla/5.0[crlf][crlf]'}
              className={`${inputCls} mt-2 font-mono text-xs resize-y`} disabled={locked} readOnly={locked} />
            <p className="text-[11px] text-gray-500 mt-1"> {t('configurations.ui.payloadHint')} </p>
          </div>
        )}
        {form.proxyEnabled && (
          <>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.proxyHost')} </label>
              <input value={form.proxyHost} onChange={e => f('proxyHost', e.target.value)}
                placeholder={t('configurations.ui.proxyPlaceholder')} className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.proxyPort')} </label>
              <input type="number" value={form.proxyPort} onChange={e => f('proxyPort', e.target.value)}
                placeholder="8080" className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
          </>
        )}
        {form.slowDns && (
          <div className="col-span-2 grid grid-cols-2 gap-4 p-4 rounded-xl bg-violet-500/5 border border-violet-500/20">
            <div className="col-span-2 text-xs text-violet-300">
              <strong> {t('configurations.ui.realSlowDns')} </strong> {t('configurations.ui.dnsttHint')} </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.dnsResolver')} </label>
              <input value={form.dns} onChange={e => f('dns', e.target.value)}
                placeholder={t('configurations.ui.dnsPlaceholder')} className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.nameServer')} </label>
              <input value={form.nameServer} onChange={e => f('nameServer', e.target.value)}
                placeholder="t.example.com" className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.dnsttKey')} </label>
              <input value={form.slowDnsPublicKey} onChange={e => f('slowDnsPublicKey', e.target.value)}
                placeholder="9dbbfb7374360504…" className={`${lockedCls} font-mono`} disabled={locked} readOnly={locked} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.localPort')} </label>
              <input type="number" value={form.localPort} onChange={e => f('localPort', e.target.value)}
                min={1024} max={65535} className={lockedCls} disabled={locked} readOnly={locked} />
              {Number(form.localPort) === 1080 && (
                <p className="text-[11px] text-rose-400 mt-1"> {t('configurations.ui.reservedPort')} </p>
              )}
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.timeout')} </label>
              <input type="number" value={form.timeoutMs} onChange={e => f('timeoutMs', e.target.value)}
                min={5000} max={120000} className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
          </div>
        )}
        <div className="col-span-2 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.udpSsh')} </label>
            <select value={form.udpMode} onChange={e => f('udpMode', e.target.value)}
              className={lockedCls} disabled={locked}>
              <option value="none"> {t('configurations.ui.disabledTcp')} </option>
              <option value="udpgw"> {t('configurations.ui.udpGw')} </option>
            </select>
          </div>
          {form.udpMode === 'udpgw' && (
            <div className="text-[11px] text-amber-300 self-end pb-2"> {t('configurations.ui.sshMustRun')} <code>badvpn-udpgw</code>.
            </div>
          )}
          {form.udpMode === 'udpgw' && <>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.udpHost')} </label>
              <input value={form.udpGatewayHost} onChange={e => f('udpGatewayHost', e.target.value)}
                placeholder="127.0.0.1" className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.udpPort')} </label>
              <input type="number" value={form.udpGatewayPort} onChange={e => f('udpGatewayPort', e.target.value)}
                min={1} max={65535} className={lockedCls} disabled={locked} readOnly={locked} />
            </div>
          </>}
        </div>
        {form.protocol === 'ssh' && form.tls && (
          <div className="col-span-2 p-3 bg-cyan-500/10 border border-cyan-500/20 rounded-xl text-xs text-cyan-300">
            🔒 <strong> {t('configurations.ui.tlsTunnel')} </strong> {t('configurations.ui.tlsTunnelHint')} <strong>SNI</strong> {t('configurations.ui.sniHint')} </div>
        )}
      </>}

      {['vless', 'vmess', 'tuic'].includes(form.protocol) && (
        <div className="col-span-2">
          <label className="block text-sm text-gray-400 mb-1.5">UUID</label>
          <input value={form.uuid} onChange={e => f('uuid', e.target.value)}
            placeholder={t('configurations.ui.generateUuid')}
            className={`${lockedCls} font-mono`} disabled={locked} readOnly={locked} />
        </div>
      )}

      {['trojan', 'shadowsocks', 'hysteria2', 'tuic'].includes(form.protocol) && (
        <div>
          <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.password')} </label>
          <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
            className={lockedCls} disabled={locked} readOnly={locked} />
        </div>
      )}

      {!sshFamily && (
        <div>
          <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.network')} </label>
          <select value={form.network} onChange={e => f('network', e.target.value)} className={lockedCls} disabled={locked}>
            {networks.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm text-gray-400 mb-1.5">SNI</label>
        <input value={form.sni} onChange={e => f('sni', e.target.value)}
          placeholder="example.com" className={lockedCls} disabled={locked} readOnly={locked} />
      </div>
      {!sshFamily && (
        <div>
          <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.wsHost')} <span className="ml-1.5 text-[11px] text-gray-600"> {t('configurations.ui.wsHostHint')} </span>
          </label>
          <input value={form.wsHost} onChange={e => f('wsHost', e.target.value)}
            placeholder={t('configurations.ui.reuseSni')} className={lockedCls} disabled={locked} readOnly={locked} />
        </div>
      )}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5"> {t('configurations.ui.path')} </label>
        <input value={form.path} onChange={e => f('path', e.target.value)}
          placeholder="/" className={lockedCls} disabled={locked} readOnly={locked} />
      </div>
      <div>
        <button type="button" onClick={() => !locked && f('tls', !form.tls)}
          disabled={locked}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${locked ? 'opacity-60 cursor-not-allowed' : ''} ${form.tls ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400' : 'bg-transparent border-[#1a1f2e] text-gray-500'}`}>
          {form.tls ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />} TLS/SSL
        </button>
      </div>
      {sshFamily && form.tls && (
        <div>
          <button type="button" onClick={() => !locked && f('insecure', !form.insecure)}
            disabled={locked}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${locked ? 'opacity-60 cursor-not-allowed' : ''} ${form.insecure ? 'bg-rose-500/15 border-rose-500/30 text-rose-300' : 'bg-transparent border-[#1a1f2e] text-gray-500'}`}>
            {form.insecure ? <AlertTriangle className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            {form.insecure ? t('configurations.ui.tlsUnchecked') : t('configurations.ui.tlsCheck')}
          </button>
        </div>
      )}
    </div>
  );
}
