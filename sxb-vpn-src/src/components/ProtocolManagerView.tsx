/**
 * ProtocolManagerView — Gestionnaire unifié des protocoles VPN SXB
 * Affiche et gère tous les protocoles : SSH, SSH+Payload, VLESS, VMess,
 * Trojan, Shadowsocks, WireGuard, Sing-box.
 * Chaque protocole peut être créé, édité et lié à une configuration VPN.
 */
import React, { useEffect, useState, useCallback } from "react";
import { UserRole } from "../types";
import {
  Network, Plus, Terminal, Zap, Box, Wifi, ChevronDown, ChevronUp,
  RefreshCw, Trash2, Edit3, X, AlertTriangle, Copy, Check,
  ShieldCheck, Globe, Lock, Server,
} from "lucide-react";

interface Props { currentUserRole: string }

// ── Protocol definitions ────────────────────────────────────────────────────

export type ProtocolType =
  | "ssh" | "ssh_payload"
  | "vless" | "vmess" | "trojan" | "shadowsocks"
  | "wireguard" | "singbox_hysteria2" | "singbox_tuic";

interface Protocol {
  type: ProtocolType;
  label: string;
  icon: React.ElementType;
  color: string;
  category: string;
  description: string;
  requiredFields: string[];
}

const PROTOCOLS: Protocol[] = [
  {
    type: "ssh",          label: "SSH",           icon: Terminal,    color: "text-emerald-400",
    category: "SSH",      description: "Tunnel SSH standard via port forwarding SOCKS5",
    requiredFields: ["host","port","username","password"],
  },
  {
    type: "ssh_payload",  label: "SSH + Payload", icon: Terminal,    color: "text-teal-400",
    category: "SSH",      description: "SSH avec HTTP Payload pour contourner le DPI",
    requiredFields: ["host","port","username","password","payload","sni"],
  },
  {
    type: "vless",        label: "VLESS",         icon: Zap,         color: "text-blue-400",
    category: "V2Ray",    description: "Protocole VLESS — léger, pas de chiffrement redondant",
    requiredFields: ["host","port","uuid","network","tls"],
  },
  {
    type: "vmess",        label: "VMess",         icon: Zap,         color: "text-indigo-400",
    category: "V2Ray",    description: "Protocole VMess avec obfuscation WebSocket",
    requiredFields: ["host","port","uuid","network","path"],
  },
  {
    type: "trojan",       label: "Trojan",        icon: ShieldCheck, color: "text-violet-400",
    category: "V2Ray",    description: "Protocole Trojan — imite HTTPS, anti-censure",
    requiredFields: ["host","port","password","sni","tls"],
  },
  {
    type: "shadowsocks",  label: "Shadowsocks",   icon: Globe,       color: "text-pink-400",
    category: "V2Ray",    description: "Shadowsocks avec chiffrement symétrique",
    requiredFields: ["host","port","password","method"],
  },
  {
    type: "wireguard",    label: "WireGuard",     icon: Lock,        color: "text-amber-400",
    category: "Autres",   description: "WireGuard — protocole moderne, ultra-rapide",
    requiredFields: ["host","port","privateKey","peerPublicKey","localAddress"],
  },
  {
    type: "singbox_hysteria2", label: "Hysteria2", icon: Box,        color: "text-rose-400",
    category: "Sing-box", description: "Hysteria2 via Sing-box — UDP, anti-QoS",
    requiredFields: ["host","port","password","sni"],
  },
  {
    type: "singbox_tuic", label: "TUIC",          icon: Box,         color: "text-orange-400",
    category: "Sing-box", description: "TUIC via Sing-box — basé sur QUIC",
    requiredFields: ["host","port","uuid","password","sni"],
  },
];

const SS_METHODS = ["aes-256-gcm","aes-128-gcm","chacha20-ietf-poly1305","2022-blake3-aes-256-gcm"];
const NETWORKS   = ["ws","grpc","tcp","http","quic"];

// ── Empty form ──────────────────────────────────────────────────────────────

const emptyForm = () => ({
  name: "", host: "", port: "", username: "", password: "",
  uuid: "", path: "", network: "ws", tls: false, sni: "",
  method: "aes-256-gcm", payload: "", dns: "",
  privateKey: "", peerPublicKey: "", localAddress: "10.0.0.2/32",
  status: "active",
});

type FormState = ReturnType<typeof emptyForm>;

// ── Unified VPN config entry ─────────────────────────────────────────────────

interface VpnEntry {
  id: string;
  name: string;
  protocol: ProtocolType | string;
  host: string;
  port: number;
  username?: string;
  uuid?: string;
  status: string;
  createdAt: string;
  subscriptionsCount?: number;
}

// ── Badge helper ────────────────────────────────────────────────────────────

function ProtoBadge({ type }: { type: string }) {
  const p = PROTOCOLS.find(p => p.type === type);
  const color = p?.color || "text-gray-400";
  const label = p?.label || type.toUpperCase();
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 border border-white/10 ${color}`}>
      {label}
    </span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function ProtocolManagerView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;

  const [entries, setEntries]       = useState<VpnEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [selectedType, setSelectedType] = useState<ProtocolType>("ssh");
  const [form, setForm]             = useState<FormState>(emptyForm());
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState("");
  const [copied, setCopied]         = useState<string|null>(null);
  const [expandedCat, setExpandedCat] = useState<Record<string,boolean>>({
    SSH: true, "V2Ray": true, Autres: false, "Sing-box": false,
  });

  // Group entries by protocol category
  const entriesByCategory = () => {
    const cats: Record<string, { protocol: Protocol; entries: VpnEntry[] }[]> = {};
    PROTOCOLS.forEach(p => {
      const cat = p.category;
      if (!cats[cat]) cats[cat] = [];
      const matching = entries.filter(e => e.protocol === p.type || e.protocol === p.label.toLowerCase() || e.protocol === p.type.replace("_","+"));
      cats[cat].push({ protocol: p, entries: matching });
    });
    return cats;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("sxb_access_token");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // Fetch from multiple sources in parallel
      const [sshRes, xrayRes, sbRes, profileRes] = await Promise.all([
        fetch("/api/ssh", { headers }).then(r => r.json()).catch(() => ({ accounts: [] })),
        fetch("/api/xray", { headers }).then(r => r.json()).catch(() => ({ accounts: [] })),
        fetch("/api/singbox", { headers }).then(r => r.json()).catch(() => ({ accounts: [] })),
        fetch("/api/vpn-profiles", { headers }).then(r => r.json()).catch(() => ({ profiles: [] })),
      ]);

      const combined: VpnEntry[] = [
        ...(sshRes.accounts || []).map((a: any) => ({ ...a, protocol: "ssh" })),
        ...(xrayRes.accounts || []).map((a: any) => ({ ...a, protocol: a.protocol || "vless" })),
        ...(sbRes.accounts  || []).map((a: any) => ({ ...a, protocol: a.protocol === "hysteria2" ? "singbox_hysteria2" : a.protocol === "tuic" ? "singbox_tuic" : a.protocol })),
        ...(profileRes.profiles || []).filter((p: any) => !['ssh','vless','vmess','trojan','shadowsocks'].includes(p.protocol))
          .map((p: any) => ({ ...p })),
      ];
      setEntries(combined);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const proto = PROTOCOLS.find(p => p.type === selectedType)!;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const token = localStorage.getItem("sxb_access_token");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // Route depending on protocol type
      let url = "/api/vpn-profiles";
      let body: any = {
        name: form.name,
        protocol: selectedType,
        host: form.host,
        port: Number(form.port),
        username: form.username || undefined,
        password: form.password || undefined,
        uuid: form.uuid || undefined,
        path: form.path || undefined,
        network: form.network,
        tls: form.tls,
        sni: form.sni || undefined,
        method: form.method || undefined,
        dns: form.dns || undefined,
        status: form.status,
      };

      if (selectedType === "ssh" || selectedType === "ssh_payload") {
        url = "/api/ssh";
        body = {
          name: form.name, host: form.host, port: Number(form.port),
          username: form.username, password: form.password,
          sni: form.sni || undefined,
          payload: selectedType === "ssh_payload" ? { content: form.payload, sni: form.sni } : undefined,
          status: "active",
        };
      } else if (["vless","vmess","trojan","shadowsocks"].includes(selectedType)) {
        url = "/api/xray";
        body = {
          name: form.name, protocol: selectedType,
          host: form.host, port: Number(form.port),
          uuid: form.uuid || undefined, path: form.path || undefined,
          network: form.network, tls: form.tls, sni: form.sni || undefined,
          password: form.password || undefined, method: form.method || undefined,
          status: "active",
        };
      } else if (selectedType.startsWith("singbox_")) {
        url = "/api/singbox";
        const proto2 = selectedType === "singbox_hysteria2" ? "hysteria2" : "tuic";
        body = {
          name: form.name, protocol: proto2,
          host: form.host, port: Number(form.port),
          uuid: form.uuid || undefined,
          password: form.password || undefined,
          sni: form.sni || undefined, tls: true,
          status: "active",
        };
      }

      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      setShowForm(false);
      setForm(emptyForm());
      load();
    } catch (err: any) {
      setError(err.message || "Erreur lors de la création");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry: VpnEntry) => {
    if (!confirm(`Supprimer "${entry.name}" ?`)) return;
    const token = localStorage.getItem("sxb_access_token");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    let url = `/api/vpn-profiles/${entry.id}`;
    if (entry.protocol === "ssh" || entry.protocol === "ssh_payload") url = `/api/ssh/${entry.id}`;
    else if (["vless","vmess","trojan","shadowsocks"].includes(entry.protocol)) url = `/api/xray/${entry.id}`;
    else if (entry.protocol.startsWith("singbox")) url = `/api/singbox/${entry.id}`;
    await fetch(url, { method: "DELETE", headers }).catch(() => {});
    load();
  };

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  const byCategory = entriesByCategory();
  const totalEntries = entries.length;
  const activeEntries = entries.filter(e => e.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Network className="w-6 h-6 text-cyan-400" /> Gestionnaire de Protocoles VPN
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Gérez tous vos protocoles : SSH, V2Ray, WireGuard, Sing-box
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button
              onClick={() => { setShowForm(true); setError(""); setForm(emptyForm()); }}
              className="flex items-center gap-2 px-4 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-sm font-medium rounded-xl border border-cyan-500/20 transition-colors"
            >
              <Plus className="w-4 h-4" /> Nouveau protocole
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total protocoles",  value: totalEntries,   color: "text-cyan-400"    },
          { label: "Actifs",            value: activeEntries,  color: "text-emerald-400" },
          { label: "Types supportés",   value: PROTOCOLS.length, color: "text-violet-400" },
          { label: "Catégories",        value: Object.keys(byCategory).length, color: "text-amber-400" },
        ].map(s => (
          <div key={s.label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Protocol catalog by category */}
      {loading ? (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-6 h-6 text-gray-500 animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(byCategory).map(([catName, protoEntries]) => {
            const catActive = protoEntries.some(pe => pe.entries.length > 0);
            const isExpanded = expandedCat[catName] ?? true;
            const catTotal = protoEntries.reduce((s, pe) => s + pe.entries.length, 0);

            return (
              <div key={catName} className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl overflow-hidden">
                {/* Category header */}
                <button
                  onClick={() => setExpandedCat(prev => ({ ...prev, [catName]: !isExpanded }))}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/3 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-white font-semibold">{catName}</span>
                    <span className="text-xs text-gray-500 bg-white/5 px-2 py-0.5 rounded-full">
                      {catTotal} entrée{catTotal !== 1 ? "s" : ""}
                    </span>
                    {catActive && (
                      <span className="w-2 h-2 rounded-full bg-emerald-400" title="Protocoles actifs" />
                    )}
                  </div>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-[#1a1f2e] divide-y divide-[#1a1f2e]">
                    {protoEntries.map(({ protocol: p, entries: pEntries }) => (
                      <div key={p.type} className="px-5 py-3">
                        {/* Protocol type header */}
                        <div className="flex items-center gap-2 mb-2">
                          <p.icon className={`w-4 h-4 ${p.color}`} />
                          <span className={`text-sm font-semibold ${p.color}`}>{p.label}</span>
                          <span className="text-xs text-gray-600">{p.description}</span>
                          <div className="ml-auto flex items-center gap-2">
                            <span className="text-xs text-gray-600">{pEntries.length} config{pEntries.length !== 1 ? "s" : ""}</span>
                            {isAdmin && (
                              <button
                                onClick={() => { setSelectedType(p.type); setShowForm(true); setError(""); setForm(emptyForm()); }}
                                className={`text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 ${p.color} transition-colors flex items-center gap-1`}
                              >
                                <Plus className="w-3 h-3" /> Ajouter
                              </button>
                            )}
                          </div>
                        </div>

                        {pEntries.length === 0 ? (
                          <p className="text-xs text-gray-700 pl-6 py-1">Aucune configuration {p.label}</p>
                        ) : (
                          <div className="space-y-1 pl-2">
                            {pEntries.map(entry => (
                              <div
                                key={entry.id}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/3 hover:bg-white/5 transition-colors group"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm font-medium text-white truncate">{entry.name}</span>
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${entry.status === "active" ? "text-emerald-400 bg-emerald-500/10" : "text-gray-500 bg-gray-500/10"}`}>
                                      {entry.status}
                                    </span>
                                  </div>
                                  <p className="text-xs text-gray-500 font-mono mt-0.5">
                                    {entry.host}:{entry.port}
                                    {entry.username && ` • user: ${entry.username}`}
                                    {entry.uuid && ` • uuid: ${entry.uuid.slice(0,8)}…`}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => copyId(entry.id)}
                                    className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/5"
                                    title="Copier l'ID"
                                  >
                                    {copied === entry.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                  </button>
                                  {isAdmin && (
                                    <button
                                      onClick={() => handleDelete(entry)}
                                      className="p-1.5 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10"
                                      title="Supprimer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Creation form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-[#1a1f2e] sticky top-0 bg-[#0f1218] z-10">
              <h2 className="font-semibold text-white flex items-center gap-2">
                <Network className="w-4 h-4 text-cyan-400" />
                Nouveau protocole VPN
              </h2>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-5">
              {error && (
                <div className="flex items-center gap-2 px-3 py-2.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
                </div>
              )}

              {/* Protocol type selector */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">Type de protocole *</label>
                <div className="grid grid-cols-3 gap-2">
                  {PROTOCOLS.map(p => (
                    <button
                      key={p.type}
                      type="button"
                      onClick={() => setSelectedType(p.type)}
                      className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border text-xs font-medium transition-colors ${
                        selectedType === p.type
                          ? `border-cyan-500/40 bg-cyan-500/10 text-white`
                          : `border-[#1a1f2e] text-gray-500 hover:border-gray-600 hover:text-gray-300`
                      }`}
                    >
                      <p.icon className={`w-4 h-4 ${selectedType === p.type ? p.color : ""}`} />
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-2 flex items-center gap-1">
                  <Server className="w-3 h-3" />
                  {proto.description}
                </p>
              </div>

              {/* Common fields */}
              <div className="grid grid-cols-1 gap-3">
                {/* Name */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Nom de la configuration *</label>
                  <input
                    value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                    placeholder={`ex: MTN ${proto.label} 150mo`}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500"
                  />
                </div>

                {/* Host + Port */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Serveur / Host *</label>
                    <input
                      value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} required
                      placeholder="node05.example.com"
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Port *</label>
                    <input
                      type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} required
                      placeholder={selectedType.includes("ssh") ? "22" : "443"}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>

                {/* SSH fields */}
                {(selectedType === "ssh" || selectedType === "ssh_payload") && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Username *</label>
                      <input
                        value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required
                        placeholder="vpnuser"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Password *</label>
                      <input
                        type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required
                        placeholder="••••••••"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  </div>
                )}

                {/* SSH Payload */}
                {selectedType === "ssh_payload" && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">HTTP Payload</label>
                    <input
                      value={form.payload} onChange={e => setForm(f => ({ ...f, payload: e.target.value }))}
                      placeholder="GET / HTTP/1.1[crlf]Host: [host][crlf][crlf]"
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-teal-500"
                    />
                  </div>
                )}

                {/* V2Ray fields */}
                {["vless","vmess","trojan"].includes(selectedType) && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">UUID *</label>
                    <input
                      value={form.uuid} onChange={e => setForm(f => ({ ...f, uuid: e.target.value }))} required
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}

                {selectedType === "shadowsocks" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Password *</label>
                      <input
                        type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required
                        placeholder="••••••••"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-pink-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Méthode</label>
                      <select
                        value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-pink-500"
                      >
                        {SS_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  </div>
                )}

                {/* WireGuard fields */}
                {selectedType === "wireguard" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Clé privée *</label>
                        <input
                          value={form.privateKey} onChange={e => setForm(f => ({ ...f, privateKey: e.target.value }))} required
                          placeholder="Base64 private key"
                          className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-amber-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Clé publique pair *</label>
                        <input
                          value={form.peerPublicKey} onChange={e => setForm(f => ({ ...f, peerPublicKey: e.target.value }))} required
                          placeholder="Base64 peer public key"
                          className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-amber-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Adresse locale</label>
                      <input
                        value={form.localAddress} onChange={e => setForm(f => ({ ...f, localAddress: e.target.value }))}
                        placeholder="10.0.0.2/32"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-amber-500"
                      />
                    </div>
                  </>
                )}

                {/* Sing-box fields */}
                {selectedType.startsWith("singbox_") && (
                  <div className="grid grid-cols-2 gap-3">
                    {selectedType === "singbox_tuic" && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">UUID *</label>
                        <input
                          value={form.uuid} onChange={e => setForm(f => ({ ...f, uuid: e.target.value }))} required
                          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                          className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-orange-500"
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Password *</label>
                      <input
                        type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required
                        placeholder="••••••••"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-rose-500"
                      />
                    </div>
                  </div>
                )}

                {/* Network + TLS (V2Ray) */}
                {["vless","vmess"].includes(selectedType) && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Transport</label>
                      <select
                        value={form.network} onChange={e => setForm(f => ({ ...f, network: e.target.value }))}
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500"
                      >
                        {NETWORKS.map(n => <option key={n} value={n}>{n.toUpperCase()}</option>)}
                      </select>
                    </div>
                    {form.network === "ws" && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Path WS</label>
                        <input
                          value={form.path} onChange={e => setForm(f => ({ ...f, path: e.target.value }))}
                          placeholder="/ws"
                          className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* SNI + TLS (pour la plupart des protocoles) */}
                {!["ssh","wireguard"].includes(selectedType) && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">SNI / Host</label>
                      <input
                        value={form.sni} onChange={e => setForm(f => ({ ...f, sni: e.target.value }))}
                        placeholder="example.com"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    {!selectedType.startsWith("singbox_") && (
                      <div className="flex items-end pb-1">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.tls}
                            onChange={e => setForm(f => ({ ...f, tls: e.target.checked }))}
                            className="w-4 h-4 rounded accent-cyan-500"
                          />
                          <span className="text-sm text-gray-400">TLS activé</span>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">
                  Annuler
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-sm font-medium rounded-xl border border-cyan-500/20 disabled:opacity-50 flex items-center gap-2">
                  {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {saving ? "Création..." : `Créer ${proto.label}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
