import { isAdmin as isAdminRole } from '../lib/roles';
import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import { useTranslation } from "../contexts/I18nContext";
import { LockPasswordField, LockedAccountNotice, validateLockPassword } from "./technical/ConfigurationLock";
import {
  fetchXrayAccounts, createXrayAccount, updateXrayAccount,
  deleteXrayAccount, suspendXrayAccount, fetchXrayStats,
  fetchXrayProtocols, XrayAccount, XrayStats,
} from "../api/xray";
import {
  Zap, Plus, Trash2, RefreshCw, Edit3, Power, Copy, Check,
  X, AlertTriangle, Activity, Link, FileJson, ArrowRight,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

const PROTO_COLORS: Record<string, string> = {
  vless: "text-cyan-400 bg-cyan-500/10",
  vmess: "text-blue-400 bg-blue-500/10",
  trojan: "text-amber-400 bg-amber-500/10",
  shadowsocks: "text-purple-400 bg-purple-500/10",
};

const DEFAULT_FORM = {
  name: "", protocol: "vless", host: "", port: "", path: "/",
  tls: false, sni: "", network: "ws",
  quotaGB: "", expireAt: "", maxDevices: 1,
  password: "", method: "aes-256-gcm", lockPassword: "",
};

// ─── Parseur V2Ray URI / JSON ─────────────────────────────────────────────────
function parseV2RayInput(raw: string): Partial<typeof DEFAULT_FORM> | null {
  const s = raw.trim();
  if (!s) return null;

  try {
    // vless://uuid@host:port?type=ws&security=tls&sni=...&path=...#name
    if (s.startsWith("vless://")) {
      const noProto = s.slice(8);
      const hashIdx = noProto.indexOf("#");
      const name = hashIdx !== -1 ? decodeURIComponent(noProto.slice(hashIdx + 1)) : "";
      const main = hashIdx !== -1 ? noProto.slice(0, hashIdx) : noProto;
      const [userinfo, rest] = main.split("@");
      const qIdx = rest.indexOf("?");
      const hostPort = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
      const qs = qIdx !== -1 ? new URLSearchParams(rest.slice(qIdx + 1)) : new URLSearchParams();
      const lastColon = hostPort.lastIndexOf(":");
      const host = hostPort.slice(0, lastColon);
      const port = hostPort.slice(lastColon + 1);
      return {
        name, protocol: "vless", host, port,
        path: qs.get("path") || "/",
        tls: qs.get("security") === "tls",
        sni: qs.get("sni") || "",
        network: qs.get("type") || "ws",
      };
    }

    // vmess://base64encodedJSON
    if (s.startsWith("vmess://")) {
      const decoded = atob(s.slice(8));
      const obj = JSON.parse(decoded);
      return {
        name: obj.ps || obj.add || "",
        protocol: "vmess",
        host: obj.add || "",
        port: String(obj.port || ""),
        path: obj.path || "/",
        tls: obj.tls === "tls",
        sni: obj.sni || "",
        network: obj.net || "ws",
      };
    }

    // trojan://password@host:port?security=tls&sni=...#name
    if (s.startsWith("trojan://")) {
      const noProto = s.slice(9);
      const hashIdx = noProto.indexOf("#");
      const name = hashIdx !== -1 ? decodeURIComponent(noProto.slice(hashIdx + 1)) : "";
      const main = hashIdx !== -1 ? noProto.slice(0, hashIdx) : noProto;
      const [pw, rest] = main.split("@");
      const qIdx = rest.indexOf("?");
      const hostPort = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
      const qs = qIdx !== -1 ? new URLSearchParams(rest.slice(qIdx + 1)) : new URLSearchParams();
      const lastColon = hostPort.lastIndexOf(":");
      const host = hostPort.slice(0, lastColon);
      const port = hostPort.slice(lastColon + 1);
      return {
        name, protocol: "trojan", host, port,
        password: pw,
        path: qs.get("path") || "/",
        tls: true,
        sni: qs.get("sni") || "",
        network: qs.get("type") || "ws",
      };
    }

    // ss://base64(method:password)@host:port#name
    if (s.startsWith("ss://")) {
      const noProto = s.slice(5);
      const hashIdx = noProto.indexOf("#");
      const name = hashIdx !== -1 ? decodeURIComponent(noProto.slice(hashIdx + 1)) : "";
      const main = hashIdx !== -1 ? noProto.slice(0, hashIdx) : noProto;
      const atIdx = main.lastIndexOf("@");
      const b64 = main.slice(0, atIdx);
      const hostPort = main.slice(atIdx + 1);
      const lastColon = hostPort.lastIndexOf(":");
      const host = hostPort.slice(0, lastColon);
      const port = hostPort.slice(lastColon + 1);
      let method = "aes-256-gcm", password = "";
      try {
        const decoded = atob(b64);
        const colonIdx = decoded.indexOf(":");
        method = decoded.slice(0, colonIdx);
        password = decoded.slice(colonIdx + 1);
      } catch { /* ignore */ }
      return { name, protocol: "shadowsocks", host, port, password, method, network: "tcp", tls: false };
    }

    // JSON object / config
    if (s.startsWith("{")) {
      const obj = JSON.parse(s);
      // Generic JSON mapping
      return {
        name: obj.ps || obj.name || obj.tag || "",
        protocol: obj.protocol || obj.type || "vless",
        host: obj.server || obj.add || obj.host || "",
        port: String(obj.server_port || obj.port || ""),
        path: obj.path || "/",
        tls: !!(obj.tls || (obj.security === "tls")),
        sni: obj.sni || obj.server_name || "",
        network: obj.net || obj.network || obj.transport?.type || "ws",
        password: obj.password || "",
        method: obj.method || "aes-256-gcm",
      };
    }
  } catch { /* ignore */ }
  return null;
}

export default function XrayManagerView({ currentUserRole }: Props) {
  const { t, locale, formatBytes, formatDate, formatNumber, message, errorText } = useTranslation();
  const fmtBytes = (value: string | null) => value === null ? t("technical.common.unlimited") : formatBytes(value);
  const isAdmin = isAdminRole(currentUserRole);
  const [accounts, setAccounts] = useState<XrayAccount[]>([]);
  const [stats, setStats] = useState<XrayStats>({ total: 0, active: 0, byProtocol: [] });
  const [protocols, setProtocols] = useState<string[]>(['vless', 'vmess', 'trojan', 'shadowsocks']);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<React.ReactNode>(null);
  const [filterProto, setFilterProto] = useState("all");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  // JSON / URI V2Ray import
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState<React.ReactNode>(null);

  const closeForm = () => {
    setShowForm(false); setForm({ ...DEFAULT_FORM }); setJsonInput(""); setShowJsonImport(false); setJsonError(null);
  };

  const handleJsonImport = () => {
    setJsonError("");
    const parsed = parseV2RayInput(jsonInput);
    if (!parsed) {
      setJsonError(message("technical.xray.importError"));
      return;
    }
    setForm(f => ({
      ...f,
      ...(parsed.name     !== undefined && parsed.name     !== "" ? { name:     parsed.name }     : {}),
      ...(parsed.protocol !== undefined ? { protocol: parsed.protocol } : {}),
      ...(parsed.host     !== undefined ? { host:     parsed.host }     : {}),
      ...(parsed.port     !== undefined ? { port:     String(parsed.port) } : {}),
      ...(parsed.path     !== undefined ? { path:     parsed.path }     : {}),
      ...(parsed.tls      !== undefined ? { tls:      parsed.tls }      : {}),
      ...(parsed.sni      !== undefined ? { sni:      parsed.sni }      : {}),
      ...(parsed.network  !== undefined ? { network:  parsed.network }  : {}),
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      ...(parsed.method   !== undefined ? { method:   parsed.method }   : {}),
    }));
    setJsonInput("");
    setShowJsonImport(false);
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [accs, st, proto] = await Promise.all([
        fetchXrayAccounts(),
        fetchXrayStats(),
        fetchXrayProtocols(),
      ]);
      setAccounts(accs);
      setStats(st);
      setProtocols(proto.protocols);
    } catch (err) { setError(errorText(err, "technical.errors.load")); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm({ ...DEFAULT_FORM }); setError(""); setShowForm(true); };

  const openEdit = (acc: XrayAccount) => {
    if (acc.isLocked) { setError(message("technical.lock.actionBlocked")); return; }
    setEditId(acc.id);
    setForm({
      name: acc.name, protocol: acc.protocol, host: acc.host,
      port: String(acc.port), path: acc.path || "/",
      tls: acc.tls, sni: acc.sni || "", network: acc.network,
      quotaGB: acc.quotaTotal ? String(Number(acc.quotaTotal) / 1024 ** 3) : "",
      expireAt: acc.expireAt ? acc.expireAt.slice(0, 10) : "",
      maxDevices: acc.maxDevices,
      password: acc.password || "", method: acc.method || "aes-256-gcm", lockPassword: "",
    });
    setError(""); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host || !form.port) { setError(message("technical.common.requiredFields")); return; }
    const lockError = !editId && validateLockPassword(form.lockPassword, form.password);
    if (lockError) { setError(message(lockError)); return; }
    if (editId && accounts.find(acc => acc.id === editId)?.isLocked) { setError(message("technical.lock.actionBlocked")); return; }
    setSaving(true); setError("");
    try {
      const { lockPassword, ...fields } = form;
      const data = {
        ...fields, port: Number(form.port), maxDevices: Number(form.maxDevices),
        quotaGB: form.quotaGB ? Number(form.quotaGB) : undefined,
        expireAt: form.expireAt || undefined,
      };
      if (editId) await updateXrayAccount(editId, data);
      else await createXrayAccount({ ...data, lockPassword });
      closeForm(); load();
    } catch (err) { setError(errorText(err, "technical.errors.save")); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (accounts.find(acc => acc.id === id)?.isLocked) { setError(message("technical.lock.actionBlocked")); return; }
    if (!window.confirm(t("technical.xray.confirmDelete", { name }))) return;
    try { await deleteXrayAccount(id); load(); } catch (err) { setError(errorText(err, "technical.errors.delete")); }
  };

  const handleSuspend = async (id: string) => {
    if (accounts.find(acc => acc.id === id)?.isLocked) { setError(message("technical.lock.actionBlocked")); return; }
    try { await suspendXrayAccount(id); load(); } catch (err) { setError(errorText(err, "technical.errors.update")); }
  };

  const copyLink = async (id: string, link: string) => {
    if (accounts.find(acc => acc.id === id)?.isLocked) { setError(message("technical.lock.actionBlocked")); return; }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id); setTimeout(() => setCopied(null), 1500);
    } catch (err) { setError(errorText(err, "technical.errors.copy")); }
  };

  const filtered = accounts.filter(a =>
    (filterProto === "all" || a.isLocked || a.protocol === filterProto) &&
    (a.name.toLowerCase().includes(search.toLowerCase()) || (!a.isLocked && a.host.includes(search)))
  );

  return (
    <div className="space-y-6" lang={locale}>
      {error && !showForm && <div role="alert" className="text-sm text-rose-400">{error}</div>}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 rounded-xl">
            <Zap className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">{t("technical.xray.title")}</h1>
            <p className="text-sm text-gray-500">{t("technical.xray.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} aria-label={t("technical.common.refresh")} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-xl text-sm font-medium border border-blue-500/20 transition-colors">
              <Plus className="w-4 h-4" /> {t("technical.common.newAccount")}
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">{t("technical.stats.total")}</p>
          <p className="text-2xl font-bold text-white">{formatNumber(stats.total)}</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">{t("technical.stats.active")}</p>
          <p className="text-2xl font-bold text-emerald-400">{formatNumber(stats.active)}</p>
        </div>
        {stats.byProtocol.map(bp => (
          <div key={bp.protocol} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1 capitalize">{bp.protocol}</p>
            <p className={`text-2xl font-bold ${(PROTO_COLORS[bp.protocol] || "text-gray-400").split(" ")[0]}`}>{formatNumber(bp._count.id)}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 flex-wrap">
          {["all", ...protocols].map(p => (
            <button key={p} onClick={() => setFilterProto(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                filterProto === p
                  ? (p === "all" ? "bg-white/10 text-white" : `${PROTO_COLORS[p]} border border-current/20`)
                  : "text-gray-500 hover:text-gray-300"
              }`}>
              {p === "all" ? t("technical.common.all") : p}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={t("technical.common.search")} aria-label={t("technical.common.search")} className="px-3 py-1.5 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors sm:ml-auto" />
      </div>

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-500">{t("technical.common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Zap className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>{t("technical.xray.empty")}</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-blue-400 hover:text-blue-300 text-sm">{t("technical.common.createAccount")}</button>}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1a1f2e]">
                {["name", "protocol", "server", "quota", "expiration", "status", "actions"].map(h => (
                  <th key={h} className="text-left text-xs text-gray-500 font-medium px-4 py-3">{t(`technical.fields.${h}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1f2e]">
              {filtered.map(acc => acc.isLocked ? (
                <tr key={acc.id}><td colSpan={7} className="p-3"><LockedAccountNotice account={acc} /></td></tr>
              ) : (
                <tr key={acc.id} className="hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-white text-sm font-medium">{acc.name}</span>
                    {acc.client && <p className="text-xs text-gray-600">{acc.client?.user?.name ?? "—"}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${PROTO_COLORS[acc.protocol] || "text-gray-400 bg-gray-500/10"}`}>
                      {acc.protocol}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400 font-mono">{acc.host}:{acc.port}</span>
                    <p className="text-xs text-gray-600">{acc.network}{acc.tls ? ` + ${t("technical.fields.tls")}` : ""}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400">
                      {fmtBytes(acc.quotaUsed)} / {fmtBytes(acc.quotaTotal)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400">
                      {acc.expireAt ? formatDate(acc.expireAt) : t("technical.common.unlimited")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      acc.status === "active" ? "text-emerald-400 bg-emerald-500/10"
                        : acc.status === "suspended" ? "text-amber-400 bg-amber-500/10"
                        : "text-rose-400 bg-rose-500/10"
                    }`}>{t(`technical.status.${acc.status}`)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {acc.link && (
                        <button onClick={() => copyLink(acc.id, acc.link!)} title={t("technical.common.copyLink")}
                          className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors">
                          {copied === acc.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {isAdmin && <>
                        <button onClick={() => openEdit(acc)} aria-label={t("technical.common.edit")} className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleSuspend(acc.id)}
                          aria-label={t(acc.status === "suspended" ? "technical.common.reactivate" : "technical.common.suspend")}
                          className={`p-1.5 rounded-lg transition-colors ${acc.status === "suspended" ? "text-emerald-400 hover:bg-emerald-500/10" : "text-amber-400 hover:bg-amber-500/10"}`}>
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDelete(acc.id, acc.name)} aria-label={t("technical.common.delete")} className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">{t(editId ? "technical.xray.editTitle" : "technical.xray.createTitle")}</h2>
              <div className="flex items-center gap-2">
                {!editId && (
                  <button type="button" onClick={() => { setShowJsonImport(v => !v); setJsonError(""); }}
                    title={t("technical.xray.importTitle")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${showJsonImport ? "bg-blue-500/20 border-blue-500/30 text-blue-400" : "bg-[#0a0d14] border-[#1a1f2e] text-gray-400 hover:text-gray-200"}`}>
                    <FileJson className="w-3.5 h-3.5" />
                    {t("technical.xray.importButton")}
                  </button>
                )}
                <button onClick={closeForm} aria-label={t("technical.common.close")} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              {!editId && <LockPasswordField value={form.lockPassword} onChange={lockPassword => setForm(f => ({ ...f, lockPassword }))} />}

              {/* JSON / URI V2Ray import section */}
              {showJsonImport && !editId && (
                <div className="p-4 bg-[#0a0d14] border border-blue-500/20 rounded-xl space-y-3">
                  <div className="flex items-center gap-2">
                    <FileJson className="w-4 h-4 text-blue-400" />
                    <p className="text-sm font-medium text-blue-400">{t("technical.xray.importHeading")}</p>
                  </div>
                  <p className="text-xs text-gray-500">{t("technical.xray.importHelp")}</p>
                  <textarea
                    value={jsonInput}
                    onChange={e => { setJsonInput(e.target.value); setJsonError(""); }}
                    placeholder={t("technical.xray.importExample")} aria-label={t("technical.xray.importHeading")}
                    rows={4}
                    className="w-full px-3 py-2 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-xs font-mono placeholder-gray-700 focus:outline-none focus:border-blue-500 resize-none"
                  />
                  {jsonError && <p className="text-xs text-rose-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{jsonError}</p>}
                  <button type="button" onClick={handleJsonImport} disabled={!jsonInput.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-400 text-sm font-medium rounded-xl transition-colors disabled:opacity-40">
                    <ArrowRight className="w-4 h-4" />
                    {t("technical.xray.fillForm")}
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.nameRequired")}</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.protocolRequired")}</label>
                  <select value={form.protocol} onChange={e => setForm(f => ({ ...f, protocol: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                    {protocols.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.network")}</label>
                  <select value={form.network} onChange={e => setForm(f => ({ ...f, network: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                    {['ws', 'grpc', 'tcp', 'h2'].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.hostRequired")}</label>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} required
                    placeholder={t("technical.examples.vpnHost")} className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.portRequired")}</label>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} required
                    placeholder="443" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.path")}</label>
                  <input value={form.path} onChange={e => setForm(f => ({ ...f, path: e.target.value }))}
                    placeholder="/" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.sni")}</label>
                  <input value={form.sni} onChange={e => setForm(f => ({ ...f, sni: e.target.value }))}
                    placeholder={t("technical.examples.host")} className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                {(form.protocol === "trojan" || form.protocol === "shadowsocks") && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.vpnPassword")}</label>
                    <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                )}
                {form.protocol === "shadowsocks" && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.method")}</label>
                    <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                      {['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.quotaGB")}</label>
                  <input type="number" step="0.1" value={form.quotaGB} onChange={e => setForm(f => ({ ...f, quotaGB: e.target.value }))}
                    placeholder={t("technical.common.unlimited")} className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.expiration")}</label>
                  <input type="date" value={form.expireAt} onChange={e => setForm(f => ({ ...f, expireAt: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">{t("technical.fields.maxDevices")}</label>
                  <input type="number" value={form.maxDevices} onChange={e => setForm(f => ({ ...f, maxDevices: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setForm(f => ({ ...f, tls: !f.tls }))}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${form.tls ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-400" : "bg-transparent border-[#1a1f2e] text-gray-500"}`}>
                  {form.tls ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                  {t("technical.fields.tls")}
                </button>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closeForm}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">{t("technical.common.cancel")}</button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 text-sm font-medium rounded-xl border border-blue-500/20 disabled:opacity-50">
                  {t(saving ? "technical.common.saving" : editId ? "technical.common.update" : "technical.common.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
