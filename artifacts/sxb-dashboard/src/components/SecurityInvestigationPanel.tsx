import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Search } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import {
  fetchSecurityAudit, fetchSecuritySessions, revokeSecuritySession,
  type SecurityAuditResponse, type SecuritySessionsResponse, type SecuritySession,
} from "../api/security";

export function exportSecurityPage(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `sxb-security-${name}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fieldClass = "min-w-0 rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-sm text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-xl border border-[#263149] px-3 py-2 text-sm text-slate-200 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-50";

interface Props {
  token: string;
  owner: boolean;
  onInspect: (sessionId: string) => void;
  onAuthorize: (clientId: string) => void;
}

export default function SecurityInvestigationPanel({ token, owner, onInspect, onAuthorize }: Props) {
  const { t, errorMessage, formatDate, formatNumber } = useTranslation();
  const [tab, setTab] = useState<"sessions" | "audit">("sessions");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [type, setType] = useState("");
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sessions, setSessions] = useState<SecuritySessionsResponse | null>(null);
  const [audit, setAudit] = useState<SecurityAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current += 1; };
  }, []);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setLoadError(null);
    try {
      if (tab === "sessions") {
        const page = await fetchSecuritySessions(token, { search, state, offset, limit: 25 });
        if (alive.current && request === sequence.current) {
          if (offset && offset >= page.total) setOffset(Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit));
          else setSessions(page);
        }
      } else {
        const page = await fetchSecurityAudit(token, { search, type, offset, limit: 25, ownerOnly: owner && ownerOnly ? "true" : "" });
        if (alive.current && request === sequence.current) {
          if (offset && offset >= page.total) setOffset(Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit));
          else setAudit(page);
        }
      }
    } catch (error) {
      if (alive.current && request === sequence.current) setLoadError(error);
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }, [offset, owner, ownerOnly, search, state, tab, token, type]);

  const reload = useRef(load);
  useEffect(() => {
    reload.current = load;
    setSessions(null); setAudit(null);
    void load();
  }, [load]);

  const revoke = async (session: SecuritySession) => {
    if (busy || !window.confirm(t("operations.security.revokeSessionConfirm"))) return;
    setBusy(true); setActionError(null); setNotice("");
    try {
      const result = await revokeSecuritySession(token, session.id, session.authGeneration);
      if (!alive.current) return;
      setNotice(t(result.revoked ? "operations.security.sessionRevoked" : "operations.security.staleSession"));
      await reload.current();
    } catch (error) {
      if (alive.current) setActionError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const page = tab === "sessions" ? sessions : audit;
  const date = (value: string | null) => value ? formatDate(value, { dateStyle: "short", timeStyle: "medium" }) : "—";
  return <section id="security-investigation" aria-busy={loading} className="min-w-0 rounded-2xl border border-[#263149] bg-[#0a0d14] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-white">{t("operations.security.investigationTitle")}</h2>
      <div className="flex gap-2">
        <button type="button" disabled={loading || busy} className={buttonClass} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" />{t("operations.common.refresh")}
        </button>
        <button type="button" disabled={!page || loading || !!loadError} className={buttonClass}
          onClick={() => exportSecurityPage(tab, { exportedAt: new Date().toISOString(), scope: owner ? "owner" : "authorized", search, state: tab === "sessions" ? state : undefined, type: tab === "audit" ? type : undefined, ...page })}>
          <Download aria-hidden="true" className="h-4 w-4" />{t("operations.security.exportPage")}
        </button>
      </div>
    </div>
    <p className="mt-2 text-sm text-slate-300">{t("operations.security.investigationHint")}</p>
    <div role="group" aria-label={t("operations.security.investigationTitle")} className="mt-4 flex gap-2">
      {(["sessions", "audit"] as const).map(value => <button key={value} type="button" aria-pressed={tab === value}
        className={`${buttonClass} ${tab === value ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-100" : ""}`}
        onClick={() => { setTab(value); setOffset(0); setSearch(""); setDraft(""); setNotice(""); setActionError(null); }}>
        {t(`operations.security.tab_${value}`)}
      </button>)}
    </div>
    <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(draft.trim()); }}>
      <label className="grid min-w-0 flex-1 gap-1 text-sm text-slate-300">
        {t("operations.security.search")}
        <input maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} className={fieldClass} />
      </label>
      {tab === "sessions" ? <label className="grid gap-1 text-sm text-slate-300">
        {t("operations.security.sessionState")}
        <select value={state} onChange={event => { setState(event.target.value); setOffset(0); }} className={fieldClass}>
          <option value="">{t("operations.security.allStates")}</option>
          {["active", "revoked", "expired", "legacy"].map(value => <option key={value} value={value}>{t(`operations.security.state_${value}`)}</option>)}
        </select>
      </label> : <>
        <label className="grid gap-1 text-sm text-slate-300">
          {t("operations.security.filterSeverity")}
          <select value={type} onChange={event => { setType(event.target.value); setOffset(0); }} className={fieldClass}>
            <option value="">{t("operations.security.allStates")}</option>
            {["info", "warning", "danger", "success"].map(value => <option key={value} value={value}>{t(`operations.common.level.${value}`)}</option>)}
          </select>
        </label>
        {owner && <label className="flex items-center gap-2 py-2 text-sm text-slate-200">
          <input type="checkbox" checked={ownerOnly} onChange={event => { setOwnerOnly(event.target.checked); setOffset(0); }} />
          {t("operations.security.ownerJournalOnly")}
        </label>}
      </>}
      <button className={buttonClass}><Search aria-hidden="true" className="h-4 w-4" />{t("operations.security.search")}</button>
    </form>
    {loadError != null && <p role="alert" className="mt-4 text-sm text-rose-200">{errorMessage(loadError, "operations.security.errors.console")}</p>}
    {actionError != null && <p role="alert" className="mt-4 text-sm text-rose-200">{errorMessage(actionError, "operations.security.revokeFailed")}</p>}
    {notice && <p role="status" className="mt-4 text-sm text-emerald-200">{notice}</p>}
    {loading && <p role="status" className="py-6 text-sm text-slate-300">{t("operations.security.loading")}</p>}
    {!loading && !loadError && page?.total === 0 && <p className="py-6 text-sm text-slate-300">{t("operations.security.noResults")}</p>}
    {tab === "sessions" && <div className="mt-4 divide-y divide-[#263149]">
      {sessions?.sessions.map(session => <article key={session.id} className="min-w-0 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words font-semibold text-white">{session.client.user.name}</h3>
            <p className="mt-1 break-all text-sm text-slate-300">{session.deviceId}</p>
          </div>
          <span className={session.state === "active" ? "text-sm text-emerald-200" : "text-sm text-slate-300"}>{t(`operations.security.state_${session.state}`)}</span>
        </div>
        <dl className="mt-3 grid gap-3 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
          {[
            [t("operations.security.filter_sessionId"), `${session.id} / ${session.authGeneration}`],
            [t("operations.security.keyGrantClient"), session.clientId],
            [t("operations.security.sessionActivated"), date(session.activationDate)],
            [t("operations.security.lastSync"), date(session.lastSync)],
            [t("operations.security.sessionExpiry"), date(session.authExpiresAt)],
            [t("operations.security.sessionRevokedAt"), date(session.authRevokedAt)],
            [t("operations.security.keyFingerprint"), session.client.deviceKeyId || t("operations.security.notEnrolled")],
            [t("operations.security.sourceIp"), session.ipAddress || "—"],
            [t("operations.security.keyGrantExpiry"), date(session.client.enrollmentGrantExpiresAt)],
          ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 break-all">{value}</dd></div>)}
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => onInspect(session.id)}>{t("operations.security.inspectSession")}</button>
          <button type="button" className={buttonClass} onClick={() => onAuthorize(session.clientId)}>{t("operations.security.prepareKeyGrant")}</button>
          <button type="button" className={`${buttonClass} border-amber-400/40 text-amber-200`} disabled={busy || loading || session.state !== "active"}
            onClick={() => void revoke(session)}>{t("operations.security.revokeSession")}</button>
        </div>
      </article>)}
    </div>}
    {tab === "audit" && <div className="mt-4 divide-y divide-[#263149]">
      {audit?.entries.map(entry => <article key={entry.id} className="min-w-0 py-4">
        <div className="flex flex-wrap justify-between gap-2 text-sm text-slate-300">
          <span>{entry.user?.name || t("operations.common.unknown")}</span>
          <time dateTime={entry.timestamp}>{date(entry.timestamp)}</time>
        </div>
        <p className="mt-2 break-words text-sm text-white">{entry.action}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
          <span>{t(`operations.common.level.${entry.type}`)}</span>
          <span className="break-all">{entry.user?.email}</span>
          <span>{entry.ipAddress}</span>
          {owner && entry.visibleOwnerOnly && <span className="text-cyan-200">{t("operations.security.privateEntry")}</span>}
        </div>
      </article>)}
    </div>}
    <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#263149] pt-4">
      <p className="text-sm text-slate-300">{page ? t("operations.security.pageRange", {
        first: formatNumber(page.total ? offset + 1 : 0), last: formatNumber(Math.min(offset + page.limit, page.total)), total: formatNumber(page.total),
      }) : "—"}</p>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t("operations.security.previous")}</button>
        <button type="button" className={buttonClass} disabled={!page || offset + page.limit >= page.total || loading} onClick={() => setOffset(value => value + 25)}>{t("operations.security.next")}</button>
      </div>
    </footer>
  </section>;
}
