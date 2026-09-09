import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import { useActionLock } from "../hooks/useActionLock";
import { isOwner } from "../lib/roles";
import { UserRole } from "../types";
import {
  executeReset, fetchResetPreview, fetchResetStatus, resetErrorKey, RESET_CONFIRMATION, RESET_COUNT_KEYS,
  RESET_PRESERVED_KEYS, RESET_RETAINED_ROLES, type ResetCounts, type ResetPreview,
  type ResetResult, type RetainedUsers, type ResetRecovery,
} from "../api/reset";

interface ResetState {
  preview: ResetPreview | null;
  attempted: boolean;
  result: ResetResult | null;
  recovery: ResetRecovery | null;
  historical: boolean;
  pending: "preview" | "execute" | "reread" | null;
  errorKey: string | null;
  readback: { counts: ResetCounts; users: RetainedUsers } | null;
  readbackError: string | null;
}
const emptyState = (): ResetState => ({
  preview: null, attempted: false, result: null, recovery: null, historical: false, pending: null,
  errorKey: null, readback: null, readbackError: null,
});
interface ResetSession { state: ResetState; listeners: Set<(state: ResetState) => void> }
// A lost response must retain its nonce across dashboard navigation, not just
// modal closure. This memory-only receipt store never contains the password.
const sessions = new Map<string, ResetSession>();
function sessionFor(ownerId: string): ResetSession {
  let session = sessions.get(ownerId);
  if (!session) { session = { state: emptyState(), listeners: new Set() }; sessions.set(ownerId, session); }
  return session;
}
function update(session: ResetSession, changes: Partial<ResetState>) {
  session.state = { ...session.state, ...changes };
  session.listeners.forEach(listener => listener(session.state));
}
const WARNING_KEYS: Record<string, string> = {
  RESET_LOCKED_CONFIGS_INCLUDED: "operations.reset.warnings.lockedConfigs",
  RESET_ADMIN_VPN_DATA_INCLUDED: "operations.reset.warnings.adminVpnData",
  RESET_PRIVATE_BACKUP_REQUIRED: "operations.reset.warnings.privateBackup",
  RESET_STORAGE_REUSED_NOT_FREED: "operations.reset.warnings.storage",
};
const REJECTED_PREVIEWS = ["errors.reset.challengeExpired", "errors.reset.previewChanged", "errors.reset.challengeInvalid"];
const DATE_WITH_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
};

function Counts({ counts }: { counts: ResetCounts }) {
  const { t, formatNumber } = useTranslation();
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
    {RESET_COUNT_KEYS.map(key => <div key={key} className="flex justify-between gap-3">
      <dt className="text-gray-400">{t(`operations.reset.counts.${key}`)}</dt>
      <dd className="font-mono text-gray-200">{formatNumber(counts[key])}</dd>
    </div>)}
  </dl>;
}
function RetainedAccounts({ users }: { users: RetainedUsers }) {
  const { t, formatNumber } = useTranslation();
  return <dl className="flex flex-wrap gap-4 text-xs">
    {RESET_RETAINED_ROLES.map(role => <div key={role}>
      <dt className="text-gray-400">{t(`operations.reset.retainedRoles.${role}`)}</dt>
      <dd className="font-mono text-emerald-300">{formatNumber(users[role])}</dd>
    </div>)}
  </dl>;
}

interface Props {
  currentUserRole: UserRole;
  ownerId: string;
  visible: boolean;
  onBusyChange?: (busy: boolean) => void;
}
export default function OwnerResetSection(props: Props) {
  if (!isOwner(props.currentUserRole) || !props.ownerId) return null;
  return <OwnerReset key={props.ownerId} {...props} />;
}

function OwnerReset({ currentUserRole, ownerId, visible, onBusyChange }: Props) {
  const { t, formatDate, formatBytes, formatNumber } = useTranslation();
  const session = sessionFor(ownerId);
  const [state, setState] = useState(session.state);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [expired, setExpired] = useState(false);
  const fields = useRef({ confirmation: "", password: "", acknowledged: false });
  const inFlight = useRef(false);
  const active = useRef(true);
  const role = useRef(currentUserRole);
  role.current = currentUserRole;
  const { run } = useActionLock();
  const busy = !!state.pending;
  const preview = state.preview;
  const finished = !!state.result?.maintenanceRestored && !state.recovery;
  const replaceable = !state.attempted || REJECTED_PREVIEWS.includes(state.errorKey ?? "");

  useEffect(() => {
    active.current = true;
    session.listeners.add(setState);
    setState(session.state);
    return () => {
      active.current = false;
      fields.current = { confirmation: "", password: "", acknowledged: false };
      session.listeners.delete(setState);
      onBusyChange?.(false);
    };
  }, [session]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    const deadline = state.preview ? Date.parse(state.preview.expiresAt) : 0;
    setExpired(deadline <= Date.now());
    if (!deadline) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [state.preview]);
  useEffect(() => {
    if (!state.attempted || finished) return;
    const preventReload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventReload);
    return () => window.removeEventListener("beforeunload", preventReload);
  }, [state.attempted, finished]);

  const clearFields = () => {
    fields.current = { confirmation: "", password: "", acknowledged: false };
    setConfirmation(""); setPassword(""); setAcknowledged(false);
  };
  const close = () => {
    if (inFlight.current || session.state.pending) return;
    clearFields();
    setOpen(false);
  };
  useEffect(() => { if (!visible && !busy) close(); }, [visible, busy]);

  const perform = async (action: NonNullable<ResetState["pending"]>, operation: () => Promise<void>) => {
    if (!active.current || inFlight.current || session.state.pending || !isOwner(role.current)) return;
    inFlight.current = true;
    update(session, { pending: action, errorKey: null });
    try {
      await run(`reset:${action}`, operation);
    } catch (error) {
      const errorKey = resetErrorKey(error);
      if (errorKey === "errors.reset.recoveredNotExecuted") {
        clearFields();
        update(session, { ...emptyState(), pending: action, errorKey });
      } else {
        update(session, { errorKey });
      }
      fields.current.password = "";
      setPassword("");
    } finally {
      inFlight.current = false;
      update(session, { pending: null });
    }
  };

  const loadPreview = async (newOperation = false) => {
    const current = session.state;
    if (current.attempted && !newOperation && !REJECTED_PREVIEWS.includes(current.errorKey ?? "")) return;
    if (newOperation && !current.result?.maintenanceRestored) return;
    if (inFlight.current || current.pending) return;
    clearFields();
    await perform("preview", async () => {
      update(session, { ...emptyState(), pending: "preview" });
      const status = await fetchResetStatus(role.current);
      if (!active.current) return;
      if (status.status === "in_progress") {
        update(session, { errorKey: "errors.reset.inProgress" });
        return;
      }
      if (status.status === "recovery_required") {
        update(session, {
          preview: null, recovery: status, attempted: true,
          result: status.receipt ?? null, historical: false, readback: null, readbackError: null,
        });
        return;
      }
      if (status.status === "completed" && (!newOperation || current.result?.resetId !== status.resetId)) {
        update(session, {
          preview: null, recovery: null, result: status.receipt, historical: true,
          attempted: true, readback: null, readbackError: null,
        });
        return;
      }
      const preview = await fetchResetPreview(role.current);
      update(session, { preview });
    });
  };
  const show = () => {
    setOpen(true);
    if (!session.state.preview && !session.state.recovery && !session.state.result && !session.state.pending
      && session.state.errorKey !== "errors.reset.recoveredNotExecuted") void loadPreview();
  };
  const readAfterCompletion = async () => {
    if (!active.current) return;
    try {
      const fresh = await fetchResetPreview(role.current);
      // Do not replace the executed challenge with this read-only inventory.
      update(session, { readback: { counts: fresh.counts, users: fresh.preserved.usersByRole }, readbackError: null });
    } catch (error) {
      update(session, { readbackError: resetErrorKey(error) });
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const current = session.state;
    const input = fields.current;
    if (!active.current || inFlight.current || current.pending || current.result?.maintenanceRestored && !current.recovery) return;
    const original = current.recovery ?? current.preview;
    if (REJECTED_PREVIEWS.includes(current.errorKey ?? "")) return;
    if (!isOwner(role.current) || !original || input.confirmation !== RESET_CONFIRMATION || !input.password.trim() || !input.acknowledged) {
      update(session, { errorKey: "errors.reset.confirmationRequired" });
      return;
    }
    if (!current.attempted && Date.parse(original.expiresAt) <= Date.now()) {
      update(session, { errorKey: "errors.reset.challengeExpired" });
      return;
    }
    await perform("execute", async () => {
      update(session, { attempted: true });
      const result = await executeReset(role.current, {
        mode: "production", challenge: original.challenge,
        confirmation: input.confirmation, password: input.password,
      });
      clearFields();
      update(session, { result, recovery: result.maintenanceRestored ? null : current.recovery, historical: false });
      await readAfterCompletion();
    });
  };
  const canSubmit = !!(state.preview || state.recovery) && confirmation === RESET_CONFIRMATION && !!password.trim()
    && acknowledged && !busy && !finished && !REJECTED_PREVIEWS.includes(state.errorKey ?? "") && (state.attempted || !expired);

  return <section hidden={!visible} className="space-y-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-5">
    <h2 className="flex items-center gap-2 text-base font-semibold text-rose-300">
      <AlertTriangle className="h-5 w-5" />{t("operations.reset.title")}
    </h2>
    <p className="text-sm text-gray-300">{t("operations.reset.description")}</p>
    <p className="text-xs text-amber-300">{t("operations.reset.preservedSummary")}</p>
    <button type="button" onClick={show} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-300">
      {t(state.attempted ? "operations.reset.reopen" : "operations.reset.open")}
    </button>

    {open && visible && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="owner-reset-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-rose-500/40 bg-[#0a0d14] p-5 space-y-5">
        <h2 id="owner-reset-title" className="text-lg font-semibold text-rose-300">{t("operations.reset.title")}</h2>
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-cyan-300">
          <RefreshCw className="h-4 w-4 animate-spin" />{t("operations.reset.pending")}
        </p>}
        {state.errorKey && <p role="alert" className="text-sm text-rose-300">{t(state.errorKey)}</p>}
        {state.recovery && <div className="space-y-2 rounded-lg border border-amber-500/30 p-4">
          <h3 className="text-sm font-semibold text-amber-300">{t("operations.reset.recoveryTitle")}</h3>
          <p className="text-sm text-gray-300">{t("operations.reset.recoveryDescription", { id: state.recovery.resetId })}</p>
          <p className="text-xs text-gray-400">{t("operations.reset.preservedSummary")}</p>
        </div>}

        {state.result ? <div className="space-y-4">
          <h3 className="text-base font-semibold text-gray-200">{t(state.recovery ? "operations.reset.recoveryReceipt"
            : state.historical ? "operations.reset.historicalReceipt" : "operations.reset.completed")}</h3>
          {state.historical && <p className="text-sm text-amber-300">{t("operations.reset.historicalHint")}</p>}
          <p className="text-xs text-gray-400">{t("operations.reset.receipt", {
            id: state.result.resetId, date: formatDate(state.result.completedAt, DATE_WITH_TIME),
          })}</p>
          <div className="rounded-lg border border-emerald-500/30 p-3 text-sm text-gray-300 space-y-1">
            <p>{t("operations.reset.backupReceipt", { id: state.result.backup.id, bytes: formatBytes(state.result.backup.bytes) })}</p>
            <p className="break-all font-mono text-xs">{t("operations.reset.backupDigest", { hash: state.result.backup.sha256 })}</p>
          </div>
          {!state.result.maintenanceRestored && <p role="alert" className="text-amber-300">{t("errors.reset.maintenanceRestoreFailed")}</p>}
          <h4 className="text-sm font-semibold text-white">{t("operations.reset.deletedCounts")}</h4>
          <Counts counts={state.result.deletedCounts} />
          <h4 className="text-sm font-semibold text-white">{t("operations.reset.retainedAccounts")}</h4>
          <RetainedAccounts users={state.result.retainedUsersByRole} />
          <h4 className="text-sm font-semibold text-white">{t("operations.reset.countsAfter")}</h4>
          <Counts counts={state.result.countsAfter} />
          {state.readback && <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white">{t("operations.reset.readback")}</h4>
            <Counts counts={state.readback.counts} />
            <RetainedAccounts users={state.readback.users} />
          </div>}
          {state.readbackError && <p role="alert" className="text-sm text-amber-300">
            {t("operations.reset.readbackFailed")} {t(state.readbackError)}
          </p>}
          <button type="button" disabled={busy} onClick={() => perform("reread", readAfterCompletion)}
            className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 disabled:opacity-40">
            {t("operations.reset.reread")}
          </button>
        </div> : preview && <div className="space-y-4">
          <p className="text-sm font-semibold text-rose-300">{t("operations.reset.productionScope")}</p>
          <p className="text-xs text-gray-400">{t("operations.reset.expires", { date: formatDate(preview.expiresAt, DATE_WITH_TIME) })}</p>
          <h3 className="text-sm font-semibold text-white">{t("operations.reset.previewCounts")}</h3>
          <Counts counts={preview.counts} />
          <p className="text-xs text-gray-400">{t("operations.reset.usersScope")}</p>
          <h3 className="text-sm font-semibold text-emerald-300">{t("operations.reset.retainedAccounts")}</h3>
          <RetainedAccounts users={preview.preserved.usersByRole} />
          <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {RESET_PRESERVED_KEYS.map(key => <div key={key} className="flex justify-between gap-3">
              <dt className="text-gray-400">{t(`operations.reset.preserved.${key}`)}</dt>
              <dd className="text-emerald-300">{formatNumber(preview.preserved[key])}</dd>
            </div>)}
          </dl>
          <p className="text-xs text-emerald-300">{t("operations.reset.projectFilesPreserved")}</p>
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 p-3 text-sm text-amber-300">
            <Database className="h-5 w-5 shrink-0" />{t("operations.reset.backupRequired")}
          </p>
          <p className="text-xs text-amber-300">{t("operations.reset.lockException")}</p>
          <ul className="space-y-1 text-xs text-amber-300">
            {preview.warnings.map(code => <li key={code}>
              {WARNING_KEYS[code] ? t(WARNING_KEYS[code]) : t("operations.reset.warningUnknown", { code })}
            </li>)}
          </ul>
        </div>}

        {state.attempted && !finished && <p className="rounded-lg border border-amber-500/30 p-3 text-sm text-amber-300">
          {t("operations.reset.sameChallenge")}
        </p>}
        {!finished && (state.preview || state.recovery) && <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <label className="block space-y-1 text-sm text-gray-300">
            <span>{t("operations.reset.confirmationLabel", { phrase: RESET_CONFIRMATION })}</span>
            <input name="resetConfirmation" value={confirmation} disabled={busy}
              onChange={event => { fields.current.confirmation = event.target.value; setConfirmation(event.target.value); }}
              autoComplete="off" spellCheck={false}
              className="w-full rounded-lg border border-gray-700 bg-[#07090e] px-3 py-2 font-mono text-white disabled:opacity-40" />
          </label>
          <label className="block space-y-1 text-sm text-gray-300">
            <span>{t("operations.reset.passwordLabel")}</span>
            <input name="resetOwnerPassword" type="password" value={password} disabled={busy}
              autoComplete="off"
              onChange={event => { fields.current.password = event.target.value; setPassword(event.target.value); }}
              className="w-full rounded-lg border border-gray-700 bg-[#07090e] px-3 py-2 text-white disabled:opacity-40" />
          </label>
          <label className="flex items-start gap-2 text-xs text-amber-300">
            <input name="resetAcknowledgment" type="checkbox" checked={acknowledged} disabled={busy}
              onChange={event => { fields.current.acknowledged = event.target.checked; setAcknowledged(event.target.checked); }} />
            <span>{t(state.recovery ? "operations.reset.recoveryAcknowledgment" : "operations.reset.acknowledgment")}</span>
          </label>
          {expired && !state.attempted && <p role="alert" className="text-xs text-amber-300">{t("errors.reset.challengeExpired")}</p>}
          <button type="submit" disabled={!canSubmit}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
            {t(state.attempted ? "operations.reset.retrySame" : "operations.reset.confirm")}
          </button>
        </form>}
        <div className="flex flex-wrap justify-end gap-2">
          {!finished && replaceable && <button type="button" disabled={busy} onClick={() => loadPreview()}
            className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 disabled:opacity-40">
            {t(state.errorKey === "errors.reset.inProgress" ? "operations.reset.recheckStatus" : "operations.reset.refreshPreview")}
          </button>}
          {finished && <button type="button" disabled={busy} onClick={() => loadPreview(true)}
            className="rounded-lg border border-rose-500/30 px-3 py-2 text-xs text-rose-300 disabled:opacity-40">
            {t("operations.reset.newOperation")}
          </button>}
          <button type="button" disabled={busy} onClick={close}
            className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 disabled:opacity-40">
            {t("operations.common.close")}
          </button>
        </div>
      </div>
    </div>}
  </section>;
}
