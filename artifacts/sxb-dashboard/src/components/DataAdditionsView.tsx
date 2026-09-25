import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Database, Layers, RefreshCw } from "lucide-react";
import { useTranslation } from "../contexts/I18nContext";
import {
  fetchDataAdditions, fetchDataAdditionServer, fetchDataAdditionServers,
  type DataAddition, type DataAdditionCursor, type DataAdditionServer,
} from "../api/data-additions";
import DataAdditionRow from "./DataAdditionRow";

interface DataAdditionsViewProps {
  /** Serveur à ouvrir d'emblée — depuis une entrée du tableau de bord. */
  initialServerId?: string | null;
  onNavigate?: (route: string) => void;
}

const TOUS = "__all__";
const POLL_MS = 30_000;
/** Aucun ajout : un tiret, jamais « +0 o », qui ressemble à un ajout. */
const NEANT = "—";

type Historique = { additions: DataAddition[]; next: DataAdditionCursor | null };

/**
 * « Données ajoutées » : chaque Go ajouté, serveur par serveur.
 *
 * À gauche, tous les serveurs avec ce qui leur a été ajouté ; à droite, le
 * serveur choisi — ou tous — avec son total ajouté, son consommé, son restant
 * et l'historique complet de ses ajouts. Rien ne se remplace : un ajout de plus
 * est une ligne de plus.
 */
export default function DataAdditionsView({ initialServerId = null, onNavigate }: DataAdditionsViewProps) {
  const { t, formatBytes, formatDate, formatNumber, errorMessage } = useTranslation();
  const [servers, setServers] = useState<DataAdditionServer[]>([]);
  const [totals, setTotals] = useState({ count: 0, addedBytes: "0" });
  const [selected, setSelected] = useState<string>(initialServerId || TOUS);
  const [history, setHistory] = useState<Historique>({ additions: [], next: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (serverId: string) => {
    const request = ++requestRef.current;
    try {
      const [serverList, global] = await Promise.all([fetchDataAdditionServers(), fetchDataAdditions({ limit: 50 })]);
      const detail = serverId === TOUS ? null : await fetchDataAdditionServer(serverId).catch(() => null);
      if (request !== requestRef.current) return;
      setServers(serverList);
      setTotals(global.totals);
      setHistory(detail ? { additions: detail.additions, next: detail.next } : { additions: global.additions, next: global.next });
      // Un serveur disparu de la portée ramène à la vue d'ensemble plutôt que
      // de laisser un détail vide sans explication.
      if (serverId !== TOUS && !detail) setSelected(TOUS);
      setFailure(null);
    } catch (error) {
      if (request === requestRef.current) setFailure(error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load(selected).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected, load]);

  // Un ajout fait ailleurs — autre onglet, autre exploitant — apparaît de
  // lui-même, sans avoir à recharger la page.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !loadingMore) void load(selected);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [selected, load, loadingMore]);

  // Arrivée depuis une entrée du tableau de bord : sur un écran étroit, le
  // détail est SOUS la liste — on y amène directement, une seule fois.
  const arriveeRef = useRef(initialServerId);
  useEffect(() => {
    if (loading || !arriveeRef.current || selected !== arriveeRef.current) return;
    arriveeRef.current = null;
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
    }
  }, [loading, selected]);

  const refresh = async () => {
    setRefreshing(true);
    await load(selected);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (!history.next || loadingMore) return;
    setLoadingMore(true);
    const request = requestRef.current;
    try {
      const page = selected === TOUS
        ? await fetchDataAdditions({ limit: 50, cursor: history.next })
        : await fetchDataAdditionServer(selected, history.next);
      if (request !== requestRef.current) return;
      setHistory(previous => ({ additions: [...previous.additions, ...page.additions], next: page.next }));
    } catch (error) {
      setFailure(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const choose = (serverId: string) => {
    setSelected(serverId);
    // Sur un écran étroit, le détail est sous la liste : on l'amène à l'œil.
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  const current = servers.find(server => server.profileId === selected) ?? null;
  const overall = useMemo(() => servers.reduce((sum, server) => ({
    used: sum.used + BigInt(server.usedBytes || "0"),
    remaining: sum.remaining + BigInt(server.remainingBytes || "0"),
    unlimited: sum.unlimited || server.unlimited,
  }), { used: BigInt(0), remaining: BigInt(0), unlimited: false }), [servers]);
  const serversWithAdditions = servers.filter(server => server.additions > 0).length;

  const figures = selected === TOUS
    ? { added: totals.addedBytes, used: overall.used.toString(), remaining: overall.remaining.toString(), unlimited: overall.unlimited }
    : current
      ? { added: current.addedBytes, used: current.usedBytes, remaining: current.remainingBytes, unlimited: current.unlimited }
      : null;

  if (loading && servers.length === 0 && history.additions.length === 0 && failure === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
        <RefreshCw className="h-6 w-6 animate-spin text-cyan-400" aria-hidden="true" />
        <p className="text-xs">{t("operations.dataAdded.loading")}</p>
      </div>
    );
  }

  const empty = servers.length === 0 && totals.count === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="max-w-2xl">
          <h1 className="text-xl font-bold tracking-tight text-white">{t("operations.dataAdded.title")}</h1>
          <p className="mt-1 text-sm text-gray-400">{t("operations.dataAdded.description")}</p>
          {!empty && (
            <p className="mt-2 text-sm font-medium text-gray-200 tabular-nums">
              {t("operations.dataAdded.summary", {
                amount: formatBytes(totals.addedBytes),
                count: formatNumber(totals.count),
                servers: formatNumber(serversWithAdditions),
              })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="flex shrink-0 cursor-pointer items-center gap-2 self-start rounded-lg border border-[#1a1f2e] bg-[#0f1218] px-3 py-1.5 text-xs font-semibold text-gray-300 transition-all hover:border-cyan-500/40 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          {t("operations.dataAdded.refresh")}
        </button>
      </div>

      {failure !== null && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 sm:flex-row sm:items-center sm:justify-between">
          <span>{errorMessage(failure, "operations.dataAdded.loadError")}</span>
          <button type="button" onClick={refresh} className="cursor-pointer self-start rounded-md border border-rose-400/40 px-2.5 py-1 text-xs font-semibold text-rose-100 hover:bg-rose-500/20 sm:self-auto">
            {t("operations.dataAdded.retry")}
          </button>
        </div>
      )}

      {empty ? (
        <div className="rounded-xl border border-[#1a1f2e] bg-[#0a0d14] px-6 py-12 text-center">
          <Database className="mx-auto h-8 w-8 text-cyan-400/70" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-white">{t("operations.dataAdded.none")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-400">{t("operations.dataAdded.noneHint")}</p>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate("subscriptions")}
              className="mt-4 cursor-pointer rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-black transition-colors hover:bg-cyan-400"
            >
              {t("operations.dataAdded.openPlans")}
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <nav aria-label={t("operations.dataAdded.allServers")} className="self-start rounded-xl border border-[#1a1f2e] bg-[#0a0d14] p-1.5">
            <ul className="space-y-0.5">
              <li>
                <ServerButton
                  active={selected === TOUS}
                  onClick={() => choose(TOUS)}
                  icon={<Layers className="h-4 w-4 text-cyan-300" aria-hidden="true" />}
                  name={t("operations.dataAdded.allServers")}
                  added={formatBytes(totals.addedBytes)}
                  line={t("operations.dataAdded.allServersLine", {
                    count: formatNumber(totals.count),
                    servers: formatNumber(serversWithAdditions),
                  })}
                />
              </li>
              {servers.map(server => (
                <li key={server.profileId}>
                  <ServerButton
                    active={selected === server.profileId}
                    onClick={() => choose(server.profileId)}
                    name={server.profileName || t("operations.dataAdded.unknownServer")}
                    added={server.additions > 0 ? `+${formatBytes(server.addedBytes)}` : NEANT}
                    muted={server.additions === 0}
                    line={server.additions > 0 && server.lastAddedAt
                      ? t("operations.dataAdded.serverLine", {
                        count: formatNumber(server.additions),
                        when: formatDate(server.lastAddedAt, { dateStyle: "medium", timeStyle: "short" }),
                      })
                      : t("operations.dataAdded.serverNoAddition", { count: formatNumber(server.subscriptions) })}
                  />
                </li>
              ))}
            </ul>
          </nav>

          <section
            ref={detailRef}
            aria-labelledby="data-added-detail"
            className="scroll-mt-4 rounded-xl border border-[#1a1f2e] bg-[#0a0d14] p-4 sm:p-5"
          >
            {selected !== TOUS && (
              <button
                type="button"
                onClick={() => choose(TOUS)}
                className="mb-2 cursor-pointer text-xs font-semibold text-cyan-300 hover:text-cyan-200 lg:hidden"
              >
                {t("operations.dataAdded.backToServers")}
              </button>
            )}
            <h2 id="data-added-detail" className="break-words text-lg font-semibold text-white">
              {selected === TOUS
                ? t("operations.dataAdded.allServers")
                : current?.profileName || t("operations.dataAdded.unknownServer")}
            </h2>

            {figures ? (
              <dl className="mt-4 grid grid-cols-3 gap-3 border-y border-[#1a1f2e] py-4">
                <Figure label={t("operations.dataAdded.totalAdded")} value={formatBytes(figures.added)} tone="text-emerald-300" />
                <Figure label={t("operations.dataAdded.totalUsed")} value={formatBytes(figures.used)} tone="text-white" />
                <Figure
                  label={t("operations.dataAdded.remaining")}
                  value={figures.unlimited ? t("operations.dataAdded.unlimited") : formatBytes(figures.remaining)}
                  tone="text-cyan-200"
                />
              </dl>
            ) : (
              <p className="mt-4 text-sm text-gray-400">{t("operations.dataAdded.serverGone")}</p>
            )}
            <p className="mt-2 text-xs text-gray-400">
              {selected === TOUS
                ? t("operations.dataAdded.liveScopeAll")
                : t("operations.dataAdded.liveScope", { count: formatNumber(current?.subscriptions ?? 0) })}
              {" "}
              {t("operations.dataAdded.trialsExcluded")}
            </p>

            <h3 className="mt-5 text-sm font-semibold text-gray-200">{t("operations.dataAdded.historyTitle")}</h3>
            {history.additions.length === 0 ? (
              <p className="mt-2 text-sm text-gray-400">{t("operations.dataAdded.serverEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-[#1a1f2e]">
                {history.additions.map(addition => (
                  <li key={addition.id}>
                    <DataAdditionRow
                      addition={addition}
                      showServer={selected === TOUS}
                      onOpen={selected === TOUS ? profileId => choose(profileId) : undefined}
                    />
                  </li>
                ))}
              </ul>
            )}
            {history.next && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-[#1a1f2e] px-3 py-2 text-xs font-semibold text-gray-300 transition-colors hover:border-cyan-500/40 hover:text-white disabled:opacity-50"
              >
                {loadingMore && <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t("operations.dataAdded.loadMore")}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ServerButton({ active, onClick, icon, name, added, line, muted = false }: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  name: string;
  added: string;
  line: string;
  /** Serveur sans aucun ajout consigné : pas de montant vert qui laisserait croire le contraire. */
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${
        active ? "bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/30" : "hover:bg-white/[0.04]"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className={`min-w-0 truncate text-sm font-semibold ${active ? "text-white" : "text-gray-200"}`}>{name}</span>
          <span className={`shrink-0 text-sm font-bold tabular-nums ${muted ? "text-gray-500" : "text-emerald-300"}`}>{added}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-gray-400">{line}</span>
      </span>
    </button>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className={`mt-1 truncate text-lg font-bold tabular-nums sm:text-xl ${tone}`}>{value}</dd>
    </div>
  );
}
