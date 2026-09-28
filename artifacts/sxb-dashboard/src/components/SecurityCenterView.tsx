import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, Clock3, Fingerprint, KeyRound, LockKeyhole,
  RefreshCw, ShieldAlert, ShieldCheck, Trash2, UnlockKeyhole,
} from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import { resolveTranslation } from "../lib/i18n";
import type { Language } from "../lib/language";
import type { User, UserRole } from "../types";
import {
  acknowledgeSecurityEvents,
  createSecurityPasskey,
  createSecurityPasskeyChallenge,
  deleteSecurityPasskey,
  fetchSecurityAudit,
  fetchSecurityEvents,
  fetchSecurityGate,
  fetchSecurityOverview,
  fetchSecurityPolicy, updateSecurityPolicy, revokeSecuritySession, authorizeDeviceKey, type SecurityPolicy,
  resetSecurityPasskeys,
  setSecurityGatePassword,
  unlockSecurityGate,
  unlockSecurityGateWithPasskey,
  type SecurityAuditEntry,
  type SecurityChallenge,
  type SecurityEvent,
  type SecurityEventsResponse,
  type SecurityGateState,
  type SecurityOverviewResponse,
  type SecurityUnlockPasskeyStep,
} from "../api/security";

type LocalError = { cause?: unknown; fallback: string } | null;
type AcknowledgedFilter = "" | "true" | "false";

interface Props {
  currentUser: User;
  currentUserRole: UserRole;
}

const DEFAULT_LIMIT = 25;

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function encodeBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function webAuthnAvailable() {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
}

function remainingSeconds(expiresAt: string | null) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

function severityStyle(severity: string) {
  if (severity === "critical") return "border-rose-400/35 bg-rose-500/10 text-rose-200";
  if (severity === "warning") return "border-amber-400/30 bg-amber-500/10 text-amber-200";
  return "border-cyan-400/25 bg-cyan-500/10 text-cyan-200";
}

/**
 * Traduit le vocabulaire brut du journal de sécurité.
 *
 * Chaque code venu du serveur — gravité, type d'événement, clé et valeur de
 * métadonnée — est rendu dans la langue choisie. Un code inconnu, par exemple
 * ajouté par une version plus récente du serveur, retombe sur sa forme brute
 * plutôt que de laisser une case vide.
 */
function readableVocabulary(language: Language) {
  const lookup = (namespace: string, code: string) =>
    resolveTranslation(language, `operations.security.${namespace}.${code}`);
  return {
    severity: (code: string) => lookup("severityLabels", code) ?? code,
    severityExplain: (code: string) => lookup("severityExplain", code) ?? "",
    eventType: (code: string) => lookup("eventLabels", code) ?? code,
    eventExplain: (code: string) => lookup("eventExplain", code) ?? "",
    metaKey: (code: string) => lookup("metaLabels", code) ?? code,
    metaValue: (value: string) => lookup("metaValues", value) ?? value,
    // Les signaux arrivent en liste séparée par des virgules : chacun est
    // traduit, et un signal inconnu reste affiché brut plutôt qu'escamoté.
    signalList: (value: string) => value
      .split(",")
      .map(nom => nom.trim())
      .filter(Boolean)
      .map(nom => lookup("signalLabels", nom) ?? nom)
      .join(" · "),
    action: (value: string) => lookup("actionLabels", value) ?? value,
    // Le journal de la porte partage le vocabulaire de niveau du reste du
    // panneau, qui l'écrit en minuscules.
    auditType: (code: string) =>
      resolveTranslation(language, `operations.common.level.${String(code).toLowerCase()}`) ?? code,
  };
}

function parseMetadata(metadata: string | null): Array<[string, string]> {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [["metadata", metadata]];
    // Une alerte d'intégrité porte sept champs de contexte : couper à six en
    // escamotait un, et c'était la décision prise par le serveur.
    return Object.entries(parsed).slice(0, 10).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  } catch {
    return [["metadata", metadata]];
  }
}

function ErrorNotice({ error }: { error: LocalError }) {
  const { errorMessage, t } = useTranslation();
  if (!error) return null;
  return (
    <div role="alert" className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
      {error.cause ? errorMessage(error.cause, error.fallback) : t(error.fallback)}
    </div>
  );
}

export default function SecurityCenterView({ currentUser, currentUserRole }: Props) {
  const { t, formatDate, formatNumber, language } = useTranslation();
  const vocabulary = useMemo(() => readableVocabulary(language), [language]);
  const [gate, setGate] = useState<SecurityGateState | null>(null);
  const [loadingGate, setLoadingGate] = useState(true);
  const [gateError, setGateError] = useState<LocalError>(null);
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [unlockToken, setUnlockToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [pendingChallenge, setPendingChallenge] = useState<SecurityUnlockPasskeyStep | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<LocalError>(null);
  const [consoleError, setConsoleError] = useState<LocalError>(null);
  const [overview, setOverview] = useState<SecurityOverviewResponse | null>(null);
  const [eventsPage, setEventsPage] = useState<SecurityEventsResponse | null>(null);
  const [audit, setAudit] = useState<SecurityAuditEntry[]>([]);
  const [filters, setFilters] = useState({
    severity: "", eventType: "", acknowledged: "" as AcknowledgedFilter,
    userId: "", deviceId: "", sessionId: "", from: "", to: "",
  });
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [certificateInput, setCertificateInput] = useState("");
  const [keyGrant, setKeyGrant] = useState({ clientId: "", keyId: "", replaceExisting: false });
  const [securityNotice, setSecurityNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const notifiedSecurityEvents = useRef(new Set<string>());
  const policyDirty = useRef(false);
  const unlockAuthority = useRef<string | null>(null);

  const isOwner = currentUserRole === "OWNER";
  const isUnlocked = !!unlockToken && remainingSeconds(expiresAt) > 0;

  const loadGate = useCallback(async () => {
    setLoadingGate(true);
    setGateError(null);
    try {
      setGate(await fetchSecurityGate());
    } catch (cause) {
      setGateError({ cause, fallback: "operations.security.errors.gate" });
    } finally {
      setLoadingGate(false);
    }
  }, []);

  const relock = useCallback(() => {
    unlockAuthority.current = null;
    policyDirty.current = false;
    setUnlockToken(null);
    setExpiresAt(null);
    setPendingChallenge(null);
    setOverview(null);
    setEventsPage(null);
    setAudit([]);
    setSelected([]);
    setPassword("");
    setPolicy(null);
    setCertificateInput("");
    setKeyGrant({ clientId: "", keyId: "", replaceExisting: false });
    setSecurityNotice("");
    setActionError(null);
    setConsoleError(null);
  }, []);

  const loadConsole = useCallback(async (token: string) => {
    try {
      const [nextOverview, nextEvents, nextAudit, nextPolicy] = await Promise.all([
        fetchSecurityOverview(token),
        fetchSecurityEvents(token, {
          ...filters, from: filters.from ? new Date(filters.from).toISOString() : undefined,
          to: filters.to ? new Date(filters.to).toISOString() : undefined,
          limit: DEFAULT_LIMIT, offset: eventsPage?.offset ?? 0,
        }),
        fetchSecurityAudit(token, 50),
        fetchSecurityPolicy(token),
      ]);
      if (unlockAuthority.current !== token) return;
      setOverview(nextOverview);
      setEventsPage(nextEvents);
      setAudit(nextAudit.entries);
      if (!policyDirty.current) {
        setPolicy(nextPolicy);
        setCertificateInput(nextPolicy.certificates.join("\n"));
      }
      setSelected([]);
      setConsoleError(null);
    } catch (cause) {
      if (unlockAuthority.current === token) {
        setConsoleError({ cause, fallback: "operations.security.errors.console" });
      }
    }
  }, [eventsPage?.offset, filters]);

  useEffect(() => { void loadGate(); }, [loadGate]);

  useEffect(() => {
    if (!unlockToken || !expiresAt) return;
    const tick = () => {
      const next = remainingSeconds(expiresAt);
      setSecondsLeft(next);
      if (next <= 0) relock();
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, relock, unlockToken]);

  useEffect(() => {
    if (!unlockToken || !isUnlocked) return;
    void loadConsole(unlockToken);
  }, [filters, isUnlocked, loadConsole, unlockToken]);

  const handleConfigure = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 12) {
      setActionError({ fallback: "operations.security.errors.passwordLength" });
      return;
    }
    setBusy("configure");
    setActionError(null);
    try {
      await setSecurityGatePassword({ currentPassword: gate?.configured ? currentPassword : undefined, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      await loadGate();
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.configure" });
    } finally {
      setBusy(null);
    }
  };

  const finishUnlock = useCallback(async (result: { unlockToken: string; expiresAt: string }) => {
    unlockAuthority.current = result.unlockToken;
    setUnlockToken(result.unlockToken);
    setExpiresAt(result.expiresAt);
    setPendingChallenge(null);
    setPassword("");
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    await loadGate();
    await loadConsole(result.unlockToken);
  }, [loadConsole, loadGate]);

  useEffect(() => {
    if (!isUnlocked || !eventsPage?.events || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    for (const event of eventsPage.events) {
      if (event.acknowledged || (event.severity !== "critical" && event.severity !== "warning")) continue;
      if (notifiedSecurityEvents.current.has(event.id)) continue;
      notifiedSecurityEvents.current.add(event.id);
      new Notification(
        event.severity === "critical" ? t("operations.security.notifications.critical") : t("operations.security.notifications.suspicious"),
        { body: `${vocabulary.eventType(event.eventType)} — ${t("operations.security.notifications.openCenter")}` },
      );
    }
  }, [eventsPage, isUnlocked, t, vocabulary]);

  useEffect(() => {
    if (!unlockToken || !isUnlocked) return;
    const timer = window.setInterval(() => {
      void loadConsole(unlockToken);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [isUnlocked, loadConsole, unlockToken]);

  const handlePasswordUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("unlock");
    setActionError(null);
    try {
      const result = await unlockSecurityGate(password);
      if (result.step === "passkey") {
        setPendingChallenge(result);
      } else {
        await finishUnlock(result);
      }
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.unlock" });
    } finally {
      setBusy(null);
    }
  };

  const handlePasskeyRecovery = async () => {
    // Le geste est irréversible et retire toutes les empreintes : il se confirme.
    if (!window.confirm(t("operations.security.passkeyRecoveryConfirm"))) return;
    setBusy("recovery");
    setActionError(null);
    try {
      await resetSecurityPasskeys(password);
      // La porte revient au mot de passe seul : on relit son état, et le
      // propriétaire réenrôle ensuite l'empreinte de son choix.
      setPendingChallenge(null);
      setPassword("");
      await loadGate();
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.passkeyRecovery" });
    } finally {
      setBusy(null);
    }
  };

  const authenticatePasskey = async (challenge: SecurityChallenge) => {
    if (!webAuthnAvailable()) {
      setActionError({ fallback: "operations.security.errors.webauthnUnavailable" });
      return;
    }
    setBusy("passkey");
    setActionError(null);
    try {
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: decodeBase64Url(challenge.challenge),
          rpId: challenge.rpId,
          userVerification: "required",
          timeout: challenge.timeoutMs,
          // Les empreintes enrôlées, telles que le serveur les connaît. Une clé
          // de plateforme n'est pas toujours « découvrable » : sans son
          // identifiant, l'authentificateur ne la retrouve pas et la
          // vérification échoue sans que rien ne soit cassé côté serveur.
          allowCredentials: (challenge.allowCredentials ?? []).map(id => ({
            type: "public-key" as const,
            id: decodeBase64Url(id),
          })),
        },
      });
      if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
        setActionError({ fallback: "operations.security.errors.webauthnInvalid" });
        return;
      }
      const result = await unlockSecurityGateWithPasskey({
        challengeId: challenge.challengeId,
        credentialId: credential.id,
        clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
        authenticatorData: encodeBase64Url(credential.response.authenticatorData),
        signature: encodeBase64Url(credential.response.signature),
      });
      await finishUnlock(result);
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.passkey" });
    } finally {
      setBusy(null);
    }
  };

  const registerPasskey = async () => {
    if (!unlockToken) return;
    if (!webAuthnAvailable()) {
      setActionError({ fallback: "operations.security.errors.webauthnUnavailable" });
      return;
    }
    setBusy("register");
    setActionError(null);
    try {
      const challenge = await createSecurityPasskeyChallenge(unlockToken);
      const userId = new TextEncoder().encode(currentUser.id);
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: decodeBase64Url(challenge.challenge),
          rp: { id: challenge.rpId, name: "SXB VPN" },
          user: { id: userId, name: currentUser.email, displayName: currentUser.name },
          pubKeyCredParams: challenge.algorithms.map(alg => ({ type: "public-key", alg })),
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required",
            // « required » et non « preferred » : avec « preferred », le capteur
            // reste libre de créer une clé non découvrable, et c'est ce qu'ont
            // fait Windows Hello puis plusieurs capteurs Android. La clé restait
            // alors introuvable au moment de s'en servir.
            residentKey: "required",
          },
          timeout: challenge.timeoutMs,
        },
      });
      if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
        setActionError({ fallback: "operations.security.errors.webauthnInvalid" });
        return;
      }
      const publicKey = credential.response.getPublicKey?.();
      const algorithm = credential.response.getPublicKeyAlgorithm?.();
      if (!publicKey || typeof algorithm !== "number") {
        setActionError({ fallback: "operations.security.errors.webauthnPublicKey" });
        return;
      }
      const signCount = (credential.response as AuthenticatorAttestationResponse & { signCount?: number }).signCount;
      await createSecurityPasskey(unlockToken, {
        challengeId: challenge.challengeId,
        credentialId: credential.id,
        publicKey: encodeBase64Url(publicKey),
        algorithm,
        clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
        signCount: typeof signCount === "number" ? signCount : undefined,
        label: passkeyLabel.trim() || undefined,
      });
      setPasskeyLabel("");
      await loadGate();
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.register" });
    } finally {
      setBusy(null);
    }
  };

  const removePasskey = async (id: string) => {
    if (!unlockToken) return;
    setBusy(id);
    setActionError(null);
    try {
      await deleteSecurityPasskey(unlockToken, id);
      await loadGate();
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.removePasskey" });
    } finally {
      setBusy(null);
    }
  };

  const acknowledgeSelected = async () => {
    if (!unlockToken || selected.length === 0) return;
    setBusy("ack");
    setActionError(null);
    try {
      await acknowledgeSecurityEvents(unlockToken, selected);
      await loadConsole(unlockToken);
    } catch (cause) {
      setActionError({ cause, fallback: "operations.security.errors.ack" });
    } finally {
      setBusy(null);
    }
  };

  const pageOffset = eventsPage?.offset ?? 0;
  const canPrevious = pageOffset > 0;
  const canNext = !!eventsPage && pageOffset + eventsPage.limit < eventsPage.total;
  const minuteText = useMemo(() => {
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;
    return t("operations.security.remainingValue", { minutes: formatNumber(minutes), seconds: formatNumber(seconds) });
  }, [formatNumber, secondsLeft, t]);

  if (loadingGate) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-sm text-gray-500">
          <RefreshCw className="h-7 w-7 animate-spin text-rose-300" />
          {t("operations.security.loading")}
        </div>
      </div>
    );
  }

  if (gateError) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-rose-500/25 bg-rose-500/10 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-rose-300" />
        <h1 className="mt-3 text-lg font-semibold text-white">{t("operations.security.unavailable")}</h1>
        <ErrorNotice error={gateError} />
        <button type="button" onClick={() => void loadGate()} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-rose-400 px-4 py-2 text-sm font-semibold text-[#17080d] hover:bg-rose-300">
          <RefreshCw className="h-4 w-4" />
          {t("operations.common.retry")}
        </button>
      </div>
    );
  }

  const configured = gate?.configured === true;

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="relative overflow-hidden rounded-[1.75rem] border border-rose-400/20 bg-[#0b1220] p-5 shadow-2xl shadow-rose-950/20 sm:p-7">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(244,63,94,0.22),transparent_32%),radial-gradient(circle_at_90%_20%,rgba(6,182,212,0.14),transparent_28%)]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-100">
              <ShieldAlert className="h-4 w-4" />
              {t("operations.security.identity")}
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">{t("operations.security.title")}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{t("operations.security.description")}</p>
          </div>
          <div className="grid gap-2 rounded-2xl border border-[#263149] bg-[#080d18]/85 p-4 text-sm sm:min-w-72">
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">{t("operations.security.gateStatus")}</span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${isUnlocked ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-200"}`}>
                {isUnlocked ? t("operations.security.unlocked") : configured ? t("operations.security.locked") : t("operations.security.notConfigured")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">{t("operations.security.passkeyStatus")}</span>
              <span className="text-white">{gate?.passkeys.length ? t("operations.security.passkeysCount", { count: formatNumber(gate.passkeys.length) }) : t("operations.security.passkeysNone")}</span>
            </div>
            {isUnlocked && (
              <div className="flex items-center justify-between gap-4 text-rose-100">
                <span className="inline-flex items-center gap-1.5 text-slate-400"><Clock3 className="h-3.5 w-3.5" />{t("operations.security.remaining")}</span>
                <span className="font-semibold">{minuteText}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <ErrorNotice error={actionError} />
      <ErrorNotice error={consoleError} />

      {!configured ? (
        <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[1.5rem] border border-[#263149] bg-[#0a0d14] p-6">
            <LockKeyhole className="h-10 w-10 text-rose-300" />
            <h2 className="mt-4 text-xl font-semibold text-white">{t("operations.security.setupTitle")}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{gate?.canConfigure ? t("operations.security.setupOwnerHint") : t("operations.security.setupAskOwner")}</p>
          </div>
          {gate?.canConfigure && (
            <form onSubmit={handleConfigure} className="rounded-[1.5rem] border border-rose-400/20 bg-[#0d1422] p-5">
              <label className="text-sm font-semibold text-white" htmlFor="security-new-password">{t("operations.security.newPassword")}</label>
              <input id="security-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder={t("operations.security.newPasswordPlaceholder")} className="mt-2 w-full rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:border-rose-400/60 focus:outline-none" />
              <p className="mt-2 text-xs text-slate-500">{t("operations.security.passwordHelp")}</p>
              <button type="submit" disabled={busy === "configure"} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-bold text-[#17080d] transition-colors hover:bg-rose-300 disabled:opacity-60">
                {busy === "configure" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {t("operations.security.configure")}
              </button>
            </form>
          )}
        </section>
      ) : !isUnlocked ? (
        <section className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <form onSubmit={handlePasswordUnlock} className="relative overflow-hidden rounded-[1.75rem] border border-rose-400/25 bg-[#0a0d14] p-6">
            <div className="absolute right-0 top-0 h-32 w-32 rounded-bl-full bg-rose-500/10 blur-2xl" />
            <UnlockKeyhole className="relative h-10 w-10 text-rose-300" />
            <h2 className="relative mt-4 text-xl font-semibold text-white">{t("operations.security.unlockTitle")}</h2>
            <p className="relative mt-2 text-sm leading-6 text-slate-400">{t("operations.security.unlockHint")}</p>
            <label htmlFor="security-password" className="relative mt-5 block text-sm font-semibold text-slate-200">{t("operations.common.password")}</label>
            <input id="security-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={t("operations.security.passwordPlaceholder")} className="relative mt-2 w-full rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:border-rose-400/60 focus:outline-none" />
            <button type="submit" disabled={busy === "unlock" || !password} className="relative mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-bold text-[#17080d] transition-colors hover:bg-rose-300 disabled:opacity-60">
              {busy === "unlock" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {t("operations.security.unlock")}
            </button>
          </form>
          <div className="rounded-[1.75rem] border border-cyan-400/20 bg-[#0d1422] p-6">
            <Fingerprint className="h-10 w-10 text-cyan-300" />
            <h2 className="mt-4 text-xl font-semibold text-white">{t("operations.security.fingerprintTitle")}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{pendingChallenge ? t("operations.security.fingerprintReady") : t("operations.security.fingerprintWaiting")}</p>
            <button type="button" onClick={() => pendingChallenge && void authenticatePasskey(pendingChallenge)} disabled={!pendingChallenge || busy === "passkey"} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-2.5 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:opacity-50">
              {busy === "passkey" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
              {t("operations.security.verifyFingerprint")}
            </button>

            {/* Voie de secours. Une empreinte devenue inutilisable — capteur
                remplacé, machine perdue — enfermait le propriétaire dehors
                définitivement, puisque la retirer exigeait la console que seule
                cette empreinte ouvrait. Elle exige le mot de passe, n'ouvre
                rien, et laisse une trace critique. */}
            {gate?.canConfigure && (gate?.passkeys?.length ?? 0) > 0 && (
              <div className="mt-5 border-t border-[#1a1f2e] pt-5">
                <p className="text-xs leading-5 text-slate-500">{t("operations.security.passkeyRecoveryHint")}</p>
                <button
                  type="button"
                  onClick={() => void handlePasskeyRecovery()}
                  disabled={busy === "recovery" || !password}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                >
                  {busy === "recovery" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {t("operations.security.passkeyRecovery")}
                </button>
              </div>
            )}
          </div>
        </section>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["critical", overview?.overview.critical ?? 0, "operations.security.metrics.critical"],
              ["warning", overview?.overview.warning ?? 0, "operations.security.metrics.warning"],
              ["unacknowledged", overview?.overview.unacknowledged ?? 0, "operations.security.metrics.unacknowledged"],
              ["last24h", overview?.overview.last24h ?? 0, "operations.security.metrics.last24h"],
            ].map(([key, value, label]) => (
              <div key={key} className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4">
                <div className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-500">
                  <span>{t(String(label))}</span>
                  <Activity className={`h-4 w-4 ${key === "critical" ? "text-rose-300" : key === "warning" ? "text-amber-300" : "text-cyan-300"}`} />
                </div>
                <div className={`mt-3 text-3xl font-bold ${key === "critical" ? "text-rose-200" : "text-white"}`}>{formatNumber(Number(value))}</div>
              </div>
            ))}
          </section>

          {policy && <section className="rounded-xl border border-[#263149] bg-[#0a0d14] p-4">
            <h2 className="text-lg font-semibold text-white">{t("operations.security.policyTitle", { version: policy.version })}</h2>
            <p className="mt-1 text-sm text-slate-300">{t("operations.security.policySafety")}</p>
            <form className="mt-4 grid grid-cols-2 items-end gap-4 lg:grid-cols-[7rem_7rem_minmax(0,1fr)_auto]" onSubmit={async event => {
              event.preventDefault();
              if (!unlockToken || busy) return;
              setBusy("policy"); setSecurityNotice(""); setActionError(null);
              try {
                const saved = await updateSecurityPolicy(unlockToken, {
                  ...policy, certificates: certificateInput.split(/\s+/).filter(Boolean), version: policy.version + 1,
                });
                if (unlockAuthority.current !== unlockToken) return;
                policyDirty.current = false;
                setPolicy(saved);
                setCertificateInput(saved.certificates.join("\n"));
                setSecurityNotice(t("operations.security.policySaved"));
              } catch (cause) { setActionError({ cause, fallback: "operations.security.policyFailed" }); }
              finally { setBusy(null); }
            }}>
              {(["medium", "high"] as const).map(level => <label key={level} className="grid gap-1 text-sm text-slate-200">
                {t(`operations.security.threshold_${level}`)}
                <input type="number" required disabled={busy !== null} min={level === "medium" ? 11 : 65} max={level === "medium" ? 64 : 89}
                  value={policy[level]} onChange={event => { policyDirty.current = true; setPolicy({ ...policy, [level]: Number(event.target.value) }); }}
                  className="w-full rounded-xl border border-[#263149] bg-[#07090e] p-2 text-white" />
              </label>)}
              <label className="col-span-2 grid min-w-0 gap-1 text-sm text-slate-200 lg:col-span-1">
                {t("operations.security.certificates")}
                <textarea required disabled={busy !== null} rows={2} value={certificateInput}
                  onChange={event => { policyDirty.current = true; setCertificateInput(event.target.value); }}
                  className="min-w-0 rounded-xl border border-[#263149] bg-[#07090e] p-2 text-xs text-white" />
              </label>
              <div className="col-span-2 flex flex-wrap gap-2 lg:col-span-1">
              <button disabled={busy !== null} className="rounded-xl border border-[#263149] px-3 py-2 text-sm text-white disabled:opacity-50">
                {t("operations.security.savePolicy")}
              </button>
              <button type="button" disabled={busy !== null}
                className="rounded-xl border border-[#263149] px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
                onClick={async () => {
                  if (!unlockToken || busy || (policyDirty.current && !window.confirm(t("operations.security.reloadPolicyConfirm")))) return;
                  setBusy("policy-load"); setActionError(null);
                  try {
                    const fresh = await fetchSecurityPolicy(unlockToken);
                    if (unlockAuthority.current !== unlockToken) return;
                    policyDirty.current = false;
                    setPolicy(fresh); setCertificateInput(fresh.certificates.join("\n"));
                  } catch (cause) { setActionError({ cause, fallback: "operations.security.policyFailed" }); }
                  finally { setBusy(null); }
                }}>
                {t("operations.security.reloadPolicy")}
              </button>
              </div>
            </form>
            <form className="mt-5 space-y-3 border-t border-[#263149] pt-4" onSubmit={async event => {
              event.preventDefault();
              if (!unlockToken || busy) return;
              if (keyGrant.replaceExisting && !window.confirm(t("operations.security.keyReplaceConfirm"))) return;
              setBusy("keyGrant"); setSecurityNotice(""); setActionError(null);
              try {
                await authorizeDeviceKey(unlockToken, keyGrant.clientId.trim(), keyGrant.keyId.trim().toLowerCase(), keyGrant.replaceExisting);
                setSecurityNotice(t("operations.security.keyGrantSaved"));
              } catch (cause) { setActionError({ cause, fallback: "operations.security.keyGrantFailed" }); }
              finally { setBusy(null); }
            }}>
              <h3 className="text-sm font-semibold text-white">{t("operations.security.keyGrantTitle")}</h3>
              <p className="text-xs text-slate-300">{t("operations.security.keyGrantHint")}</p>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-sm text-slate-200">{t("operations.security.keyGrantClient")}
                  <input required maxLength={200} value={keyGrant.clientId}
                    onChange={event => setKeyGrant({ ...keyGrant, clientId: event.target.value })}
                    className="min-w-0 rounded-xl border border-[#263149] bg-[#07090e] p-2" />
                </label>
                <label className="grid gap-1 text-sm text-slate-200">{t("operations.security.keyFingerprint")}
                  <input required pattern="[a-fA-F0-9]{64}" value={keyGrant.keyId}
                    onChange={event => setKeyGrant({ ...keyGrant, keyId: event.target.value })}
                    className="min-w-0 rounded-xl border border-[#263149] bg-[#07090e] p-2 font-mono text-xs" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" checked={keyGrant.replaceExisting}
                  onChange={event => setKeyGrant({ ...keyGrant, replaceExisting: event.target.checked })} />
                {t("operations.security.keyReplace")}
              </label>
              <button disabled={busy !== null} className="rounded-xl border border-[#263149] px-3 py-2 text-sm text-white disabled:opacity-50">
                {t("operations.security.keyGrantAction")}
              </button>
            </form>
            {securityNotice && <p role="status" className="mt-2 text-sm text-slate-200">{securityNotice}</p>}
          </section>}
          <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
            <div className="overflow-hidden rounded-[1.5rem] border border-[#263149] bg-[#0a0d14]">
              <div className="border-b border-[#1a1f2e] p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">{t("operations.security.eventsTitle")}</h2>
                    <p className="mt-1 text-xs text-slate-500">{t("operations.security.eventsHint")}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(["userId", "deviceId", "sessionId", "from", "to"] as const).map(field => <label key={field} className="grid gap-1 text-xs text-slate-300">
                      {t(`operations.security.filter_${field}`)}
                      <input type={field === "from" || field === "to" ? "datetime-local" : "text"} value={filters[field]}
                        maxLength={255} onChange={event => { setFilters(prev => ({ ...prev, [field]: event.target.value })); setEventsPage(null); }}
                        className="min-w-0 rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-xs text-slate-200" />
                    </label>)}
                    <select aria-label={t("operations.security.filterSeverity")} value={filters.severity} onChange={event => setFilters(prev => ({ ...prev, severity: event.target.value }))} className="rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-xs text-slate-200">
                      <option value="">{t("operations.security.filterSeverity")}</option>
                      {(overview?.severities ?? []).map(severity => <option key={severity} value={severity}>{vocabulary.severity(severity)}</option>)}
                    </select>
                    <select aria-label={t("operations.security.filterType")} value={filters.eventType} onChange={event => setFilters(prev => ({ ...prev, eventType: event.target.value }))} className="rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-xs text-slate-200">
                      <option value="">{t("operations.security.filterType")}</option>
                      {(overview?.eventTypes ?? []).map(type => <option key={type} value={type}>{vocabulary.eventType(type)}</option>)}
                    </select>
                    <select aria-label={t("operations.security.filterAcknowledged")} value={filters.acknowledged} onChange={event => setFilters(prev => ({ ...prev, acknowledged: event.target.value as AcknowledgedFilter }))} className="rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-xs text-slate-200">
                      <option value="">{t("operations.security.filterAcknowledged")}</option>
                      <option value="false">{t("operations.security.unacknowledged")}</option>
                      <option value="true">{t("operations.security.acknowledged")}</option>
                    </select>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <button type="button" onClick={() => void acknowledgeSelected()} disabled={!selected.length || busy === "ack"} className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50">
                    {busy === "ack" ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    {t("operations.security.ackSelected", { count: formatNumber(selected.length) })}
                  </button>
                  <button type="button" onClick={() => unlockToken && void loadConsole(unlockToken)} className="inline-flex items-center gap-2 rounded-xl border border-[#263149] px-3 py-2 text-xs font-semibold text-slate-300 hover:border-cyan-400/40">
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("operations.common.refresh")}
                  </button>
                </div>
              </div>
              {!eventsPage?.events.length ? (
                <div className="p-10 text-center text-sm text-slate-500">{t("operations.security.eventsEmpty")}</div>
              ) : (
                <div className="divide-y divide-[#1a1f2e]">
                  {eventsPage.events.map(event => (
                    <article key={event.id} className="grid gap-3 p-4 hover:bg-white/[0.02] md:grid-cols-[auto_minmax(0,1fr)_auto]">
                      <input type="checkbox" aria-label={t("operations.security.selectEvent", { id: event.id })} checked={selected.includes(event.id)} disabled={event.acknowledged} onChange={change => setSelected(prev => change.target.checked ? [...prev, event.id] : prev.filter(id => id !== event.id))} className="mt-1 h-4 w-4 rounded border-[#263149] bg-[#07090e]" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span title={vocabulary.severityExplain(event.severity)} className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${severityStyle(event.severity)}`}>{vocabulary.severity(event.severity)}</span>
                          <h3 className="font-semibold text-white">{vocabulary.eventType(event.eventType)}</h3>
                          {event.acknowledged && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">{t("operations.security.acknowledged")}</span>}
                        </div>
                        {vocabulary.eventExplain(event.eventType) && (
                          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{vocabulary.eventExplain(event.eventType)}</p>
                        )}
                        <div className="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
                          <span>{t("operations.security.eventUser", { value: event.userId || "—" })}</span>
                          <span>{t("operations.security.eventDevice", { value: event.deviceId || "—" })}</span>
                          <span>{t("operations.security.eventVersion", { value: event.appVersion || "—" })}</span>
                          {event.sessionId && <span className="break-all">{t("operations.security.eventSession", { value: event.sessionId, generation: event.sessionGeneration ?? 0 })}</span>}
                          {event.riskLevel && <span>{t("operations.security.eventRisk", { value: event.riskLevel, version: event.policyVersion ?? 0 })}</span>}
                          <span>{t("operations.security.eventIp", { value: event.ipHash || "—" })}</span>
                        </div>
                        {event.actionTaken && <p className="mt-2 text-xs text-slate-300">{vocabulary.action(event.actionTaken)}</p>}
                        {event.sessionId && event.sessionGeneration != null && <button type="button"
                          disabled={busy === event.id}
                          onClick={async () => {
                            if (!unlockToken || !window.confirm(t("operations.security.revokeSessionConfirm"))) return;
                            setBusy(event.id);
                            try {
                              const result = await revokeSecuritySession(unlockToken, event.sessionId!, event.sessionGeneration!);
                              setSecurityNotice(t(result.revoked ? "operations.security.sessionRevoked" : "operations.security.staleSession"));
                              await loadConsole(unlockToken);
                            } catch (cause) { setActionError({ cause, fallback: "operations.security.revokeFailed" }); }
                            finally { setBusy(null); }
                          }}
                          className="mt-2 rounded-xl border border-amber-400/40 px-3 py-2 text-xs text-amber-200 disabled:opacity-50">
                          {t("operations.security.revokeSession")}
                        </button>}
                        {parseMetadata(event.metadata).length > 0 && (
                          <dl className="mt-3 grid gap-2 rounded-xl border border-[#263149] bg-[#07090e]/60 p-3 text-[11px] sm:grid-cols-2">
                            {parseMetadata(event.metadata).map(([key, value]) => {
                              const lisible = key === "signals" ? vocabulary.signalList(value) : vocabulary.metaValue(value);
                              return (
                                <div key={key} className="min-w-0">
                                  <dt className="text-slate-500">{vocabulary.metaKey(key)}</dt>
                                  <dd className="truncate text-slate-300" title={lisible}>{lisible}</dd>
                                </div>
                              );
                            })}
                          </dl>
                        )}
                      </div>
                      <time className="text-xs text-slate-500">{formatDate(event.createdAt, { dateStyle: "short", timeStyle: "short" })}</time>
                    </article>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between border-t border-[#1a1f2e] p-4 text-xs text-slate-500">
                <span>{t("operations.security.eventCount", { total: formatNumber(eventsPage?.total ?? 0) })}</span>
                <div className="flex gap-2">
                  <button type="button" disabled={!canPrevious} onClick={() => unlockToken && fetchSecurityEvents(unlockToken, { ...filters, limit: DEFAULT_LIMIT, offset: Math.max(0, pageOffset - DEFAULT_LIMIT) }).then(setEventsPage)} className="rounded-lg border border-[#263149] px-3 py-1.5 text-slate-300 disabled:opacity-40">{t("operations.security.previous")}</button>
                  <button type="button" disabled={!canNext} onClick={() => unlockToken && fetchSecurityEvents(unlockToken, { ...filters, limit: DEFAULT_LIMIT, offset: pageOffset + DEFAULT_LIMIT }).then(setEventsPage)} className="rounded-lg border border-[#263149] px-3 py-1.5 text-slate-300 disabled:opacity-40">{t("operations.security.next")}</button>
                </div>
              </div>
            </div>

            <aside className="space-y-5">
              <section className="rounded-[1.5rem] border border-cyan-400/20 bg-[#0d1422] p-5">
                <div className="flex items-start gap-3">
                  <Fingerprint className="h-6 w-6 text-cyan-300" />
                  <div>
                    <h2 className="font-semibold text-white">{t("operations.security.passkeysTitle")}</h2>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{t("operations.security.passkeysHint")}</p>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <input value={passkeyLabel} onChange={event => setPasskeyLabel(event.target.value)} placeholder={t("operations.security.passkeyLabelPlaceholder")} className="min-w-0 flex-1 rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-cyan-400/50 focus:outline-none" />
                  <button type="button" onClick={() => void registerPasskey()} disabled={busy === "register"} className="rounded-xl bg-cyan-400 px-3 py-2 text-sm font-bold text-[#031017] hover:bg-cyan-300 disabled:opacity-60">
                    {busy === "register" ? t("operations.security.enrolling") : t("operations.security.enroll")}
                  </button>
                </div>
                <div className="mt-4 space-y-2">
                  {gate?.passkeys.length ? gate.passkeys.map(passkey => (
                    <div key={passkey.id} className="flex items-center justify-between gap-3 rounded-xl border border-[#263149] bg-[#07090e]/70 p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">{passkey.label || t("operations.security.unnamedPasskey")}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">{t("operations.security.passkeyCreated", { date: formatDate(passkey.createdAt, { dateStyle: "short" }) })}</p>
                      </div>
                      <button type="button" onClick={() => void removePasskey(passkey.id)} disabled={busy === passkey.id} aria-label={t("operations.security.removePasskey")} className="rounded-lg border border-rose-400/20 p-2 text-rose-200 hover:bg-rose-500/10 disabled:opacity-50">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )) : <div className="rounded-xl border border-dashed border-[#263149] p-4 text-center text-sm text-slate-500">{t("operations.security.noPasskeys")}</div>}
                </div>
              </section>

              <section className="rounded-[1.5rem] border border-[#263149] bg-[#0a0d14] p-5">
                <h2 className="font-semibold text-white">{t("operations.security.passwordRotateTitle")}</h2>
                <form onSubmit={handleConfigure} className="mt-4 space-y-3">
                  {isOwner ? (
                    <>
                      <input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} placeholder={t("operations.security.currentPasswordPlaceholder")} className="w-full rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-rose-400/50 focus:outline-none" />
                      <input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder={t("operations.security.newPasswordPlaceholder")} className="w-full rounded-xl border border-[#263149] bg-[#07090e] px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-rose-400/50 focus:outline-none" />
                      <button type="submit" disabled={busy === "configure"} className="w-full rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/20 disabled:opacity-60">{t("operations.security.rotatePassword")}</button>
                    </>
                  ) : (
                    <p className="text-sm leading-6 text-slate-500">{t("operations.security.ownerOnlyPassword")}</p>
                  )}
                </form>
              </section>

              <section className="rounded-[1.5rem] border border-[#263149] bg-[#0a0d14] p-5">
                <h2 className="font-semibold text-white">{t("operations.security.auditTitle")}</h2>
                <div className="mt-4 space-y-3">
                  {audit.length ? audit.map(entry => (
                    <div key={entry.id} className="rounded-xl border border-[#263149] bg-[#07090e]/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold uppercase text-cyan-200">{vocabulary.auditType(entry.type)}</span>
                        <time className="text-[11px] text-slate-500">{formatDate(entry.timestamp, { dateStyle: "short", timeStyle: "short" })}</time>
                      </div>
                      <p className="mt-2 text-sm text-slate-200">{entry.action}</p>
                      <p className="mt-1 text-[11px] text-slate-500">{entry.user?.name || entry.user?.email || t("operations.common.unknown")}</p>
                    </div>
                  )) : <div className="rounded-xl border border-dashed border-[#263149] p-4 text-center text-sm text-slate-500">{t("operations.security.auditEmpty")}</div>}
                </div>
              </section>
            </aside>
          </section>
        </>
      )}
    </div>
  );
}
