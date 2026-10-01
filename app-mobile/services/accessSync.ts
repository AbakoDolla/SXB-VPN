import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import apiClient, { API_BASE_URL } from './apiClient';
import * as configStore from './configStore';
import { MAX_IMPORTED_BACKEND_CONFIGS } from './configStore';
import { saveQuotaData } from './offlineStorage';
import { provisionAndStore, ProvisioningError } from './provisionClient';
import { isCompleteOfflineConfig } from './configValidator';
import {
  accessIssueFromError, blocksDevice, blocksProfile, deviceAccess, isRecord, managedProfile,
  profileRestriction, responseInfo, retryDelay, type AccessAuthority, type ProfileIdentity,
} from './accessPolicy';
import {
  applyAccessIssue, applyAccessSnapshot, captureAccessAuthority, getAccessState,
  subscribeAccessState, syncNativeAccessState, requireDeviceAccess, requireProfileAccess,
} from './accessState';
import { accessRequestStamp, currentAccessRequest, currentIdentityRequest, subscribeAccessFailures } from './accessEvents';
import { getPrivacyConsent, requireVpnConsent, subscribePrivacyConsent } from './privacyConsent';
import { nativeAccess, storeNativeAccessTicket } from './nativeAccess';
import type { VpnConnection } from '../types/api';

type Runtime = {
  activeProfile(): ProfileIdentity | null;
  stop(): Promise<void>;
  changed(): Promise<void>;
};
let runtime: Runtime | null = null;
let reconciliation: Promise<void> = Promise.resolve();
let refresh: Promise<VpnConnection[]> | null = null;
let controlRequest: { promise: Promise<boolean>; controller: AbortController } | null = null;
let controlSupported: boolean | null = null;
let ticketRetryAt = 0;
let ticketRequest: Promise<void> | null = null;
let nativeHandoffUntil = 0;
let lifecycle = 0;
let wakeObservation: (() => void) | null = null;
let connections: VpnConnection[] = [];
export const getRemoteConnections = () => connections;

/**
 * Pourquoi un forfait attribué n'est pas (encore) sur l'appareil.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE SILENCE QUE CE REGISTRE REMPLACE
 * ═══════════════════════════════════════════════════════════════════════════
 * Un import raté n'était écrit qu'en console : le forfait restait « À
 * télécharger » dans le sélecteur, sans un mot, et rien ne le retentait tant
 * que l'utilisateur ne rappuyait pas quelque part. Chaque échec est désormais
 * retenu ici — pour l'afficher, et pour qu'une reprise automatique s'en charge.
 */
export type ImportNote = {
  /** `cap` : quatre configurations utilisables occupent déjà toutes les places. */
  kind: 'failed' | 'cap';
  code: string;
  /** Faux pour un refus que seul l'exploitant peut lever (appareil, profil incomplet). */
  retryable: boolean;
};
let importNotes = new Map<string, ImportNote>();
export const getImportNotes = (): ReadonlyMap<string, ImportNote> => importNotes;

/**
 * Reprise automatique des imports.
 *
 * Un forfait tout juste attribué part tout de suite ; un import raté est
 * retenté à intervalles croissants — pour ne jamais marteler un serveur en
 * panne, sans jamais abandonner : un forfait attribué doit finir sur
 * l'appareil sans que personne ait à le demander.
 */
const AUTO_IMPORT_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
let autoImportTimer: ReturnType<typeof setTimeout> | null = null;
let autoImportAttempt = 0;

/**
 * Empreinte distante pour laquelle une mise à jour immédiate est déjà partie,
 * par forfait.
 *
 * Un forfait déjà sur l'appareil dont le tableau de bord change la
 * configuration est remis à jour dès que l'instantané d'accès l'annonce. Une
 * même empreinte ne déclenche qu'UNE mise à jour immédiate : si le serveur
 * rendait au provisionnement une empreinte différente de celle qu'il annonce,
 * chaque instantané relancerait sinon un aller-retour, sans fin. Les échecs
 * réseau, eux, sont repris à intervalles croissants par la reprise ordinaire.
 */
let majLancees = new Map<string, string>();

function scheduleAutoImport(immediate = false): void {
  if (!runtime) return;
  if (autoImportTimer) {
    // Une reprise lente déjà programmée ne doit pas retarder un forfait NEUF.
    if (!immediate) return;
    clearTimeout(autoImportTimer);
    autoImportTimer = null;
  }
  const epoch = lifecycle;
  const delay = immediate ? 0 : AUTO_IMPORT_RETRY_MS[Math.min(autoImportAttempt, AUTO_IMPORT_RETRY_MS.length - 1)];
  autoImportTimer = setTimeout(() => {
    autoImportTimer = null;
    if (epoch !== lifecycle || !runtime || !getAccessState().authority) return;
    // Un rafraîchissement déjà en vol traitera ces forfaits : on attend son
    // verdict, puis on regarde s'il reste réellement quelque chose à importer,
    // plutôt que d'empiler un second aller-retour.
    if (refresh) {
      void refresh.finally(() => { if (epoch === lifecycle) void reconcileAccess().catch(reportAccessSyncError); }).catch(() => {});
      return;
    }
    if (!immediate) autoImportAttempt += 1;
    void refreshMobileConfigs()
      .then(() => runtime?.changed())
      .catch(reportAccessSyncError);
  }, delay);
  // Sous Node (tests), une reprise en attente ne doit pas retenir le
  // processus ; React Native rend un simple numéro, sans `unref`.
  (autoImportTimer as { unref?: () => void }).unref?.();
}

/** Annule toute reprise d'import programmée (fin de session). */
export function stopAutoImport(): void {
  if (autoImportTimer) clearTimeout(autoImportTimer);
  autoImportTimer = null;
  autoImportAttempt = 0;
}

/** Diagnostic sans secret ni message serveur libre : un code d'une liste connue. */
function importFailure(error: unknown): ImportNote {
  if (error instanceof ProvisioningError) {
    return {
      kind: 'failed',
      code: error.serverCode === 'SUBSCRIPTION_DEVICE_BOUND' ? error.serverCode : error.diagnostic.code,
      retryable: error.diagnostic.retryable,
    };
  }
  const status = responseInfo(error).status;
  return { kind: 'failed', code: status ? `HTTP_${status}` : 'UNAVAILABLE', retryable: !status || status >= 500 || status === 429 };
}

/**
 * Libère UNE place du plafond pour un forfait actif, en retirant de l'appareil
 * une configuration importée qui ne peut plus servir.
 *
 * Jamais retirées : la configuration active, celle du tunnel en cours, une
 * configuration encore utilisable, un profil ajouté à la main. La plus inutile
 * part d'abord — forfait disparu de la liste du serveur, puis forfait bloqué,
 * expiré ou épuisé —, la plus ancienne à égalité. Elle n'est pas « supprimée »
 * au sens de l'utilisateur : si le forfait redevient utilisable, il revient.
 */
async function libererPlaceInutilisable(importsConnus: ReadonlySet<string>, authority: AccessAuthority): Promise<string | null> {
  const entries = storeValue(await configStore.list()) ?? [];
  const running = runtime?.activeProfile()?.configId ?? null;
  const assigned = new Map(connections.map(entry => [entry.id, entry]));
  const victim = entries
    .filter(meta => meta.source === 'backend' && importsConnus.has(meta.configId) && !meta.isActive && meta.configId !== running)
    .map(meta => {
      const remote = assigned.get(meta.subscriptionId || meta.configId);
      const unusable = !remote ? 0 : (profileRestriction(authority, meta) || remote.status !== 'active') ? 1 : 2;
      return { meta, unusable };
    })
    .filter(candidate => candidate.unusable < 2)
    .sort((a, b) => a.unusable - b.unusable ||
      (Date.parse(a.meta.savedAt || '') || 0) - (Date.parse(b.meta.savedAt || '') || 0))[0]?.meta;
  if (!victim) return null;
  const removed = await configStore.remove(victim.configId);
  return removed.status === 'ok' ? victim.configId : null;
}

export function storeValue<T>(result: configStore.StoreResult<T>): T | undefined {
  if (result.status === 'error') throw result.error ?? new Error('CONFIG_STORAGE_UNAVAILABLE');
  return result.value;
}

// ── Suppression côté serveur des configurations retirées dans l'application ──
// Le forfait de CE compte est supprimé du tableau de bord ; la configuration
// VPN partagée par d'autres utilisateurs n'est jamais touchée (le serveur ne
// connaît de toute façon que les forfaits de l'appelant). Une réponse 404 veut
// dire « plus rien à supprimer » : la demande est alors close.
let remoteDeletionFlight: Promise<void> | null = null;

export function flushRemoteDeletions(): Promise<void> {
  if (remoteDeletionFlight) return remoteDeletionFlight;
  const flight = (async () => {
    const pending = storeValue(await configStore.listRemoteDeletions()) ?? [];
    for (const id of pending) {
      try {
        await apiClient.delete(`/mobile/connections/${encodeURIComponent(id)}`);
      } catch (error) {
        if (responseInfo(error).status !== 404) {
          reportAccessSyncError(error);
          continue;
        }
      }
      storeValue(await configStore.clearRemoteDeletion(id));
    }
  })();
  remoteDeletionFlight = flight.finally(() => { remoteDeletionFlight = null; });
  return remoteDeletionFlight;
}

export function registerAccessRuntime(next: Runtime): () => void {
  runtime = next;
  void reconcileAccess().catch(reportAccessSyncError);
  // Une reprise suspendue par un changement de runtime repart avec le nouveau.
  if ([...importNotes.values()].some(note => note.kind === 'failed')) scheduleAutoImport();
  return () => {
    if (runtime !== next) return;
    runtime = null;
    // Sans runtime, plus personne ne peut recevoir une configuration importée.
    if (autoImportTimer) clearTimeout(autoImportTimer);
    autoImportTimer = null;
  };
}

export function reportAccessSyncError(error: unknown): void {
  const issue = accessIssueFromError(error);
  const status = responseInfo(error).status;
  // Never log Axios bodies, provisioning objects or tokens.
  console.warn('[Access] Synchronization deferred:', issue?.code ?? status ?? (error instanceof Error && /^ACCESS_/.test(error.message) ? error.message : 'UNAVAILABLE'));
}

/** Stop first, then remove only revoked/deleted payloads. Suspensions keep their ciphertext. */
export function reconcileAccess(): Promise<void> {
  const epoch = lifecycle;
  const operation = reconciliation.then(async () => {
    const authority = getAccessState().authority;
    if (!authority || epoch !== lifecycle) return;
    const currentRuntime = runtime;
    const active = currentRuntime?.activeProfile();
    if (currentRuntime && active && (blocksDevice(deviceAccess(authority)) || profileRestriction(authority, active))) {
      await currentRuntime.stop();
    }
    if (epoch !== lifecycle || getAccessState().authority !== authority) return;
    const entries = storeValue(await configStore.list()) ?? [];
    for (const entry of entries) {
      if (epoch !== lifecycle || getAccessState().authority !== authority) return;
      const restriction = profileRestriction(authority, entry);
      if (restriction?.status === 'revoked' || restriction?.status === 'deleted') {
        storeValue(await configStore.remove(entry.configId));
        continue;
      }
      const remote = authority.snapshot?.subscriptions.find(item => item.id === (entry.subscriptionId || entry.configId));
      if (remote && managedProfile(entry)) {
        storeValue(await configStore.updateMetadata(entry.configId, { name: remote.name, accessStatus: remote.status }));
        await saveQuotaData({ configId: entry.configId, totalQuota: remote.quotaTotalBytes,
          usedQuota: remote.quotaUsedBytes, expiryDate: remote.expireAt });
      } else if (restriction) {
        storeValue(await configStore.updateMetadata(entry.configId, { accessStatus: restriction.status }));
      }
    }
    // ── IMPORT DÈS L'ATTRIBUTION ─────────────────────────────────────────
    // L'instantané d'accès — reçu par HTTP ou par le service natif — annonce
    // un forfait actif que l'appareil n'a pas : l'import part tout de suite,
    // sans attendre un geste ni la relecture périodique de l'accueil. Un
    // rafraîchissement déjà en vol s'en charge lui-même, d'où la garde.
    if (!refresh && authority.snapshot && !blocksDevice(deviceAccess(authority))) {
      const detenus = new Set(entries.map(entry => entry.subscriptionId || entry.configId));
      const dismissed = new Set(storeValue(await configStore.listDismissed()) ?? []);
      const statut = new Map(authority.snapshot.subscriptions.map(item => [item.id, item.status]));
      const running = currentRuntime?.activeProfile()?.configId ?? null;
      // Une place tenue par une configuration inutilisable peut revenir à un
      // forfait resté hors de l'appareil faute de place.
      const placeLiberable = entries.some(entry => entry.source === 'backend' && !entry.isActive &&
        entry.configId !== running && statut.get(entry.subscriptionId || entry.configId) !== 'active');
      const manquant = authority.snapshot.subscriptions.some(item => {
        if (item.status !== 'active' || detenus.has(item.id) || dismissed.has(item.id)) return false;
        if (profileRestriction(authority, { configId: item.id, subscriptionId: item.id, source: 'backend', configHash: item.configHash })) return false;
        const note = importNotes.get(item.id);
        return !note || (note.kind === 'cap' && placeLiberable);
      });
      // ── MISE À JOUR DÈS LA RÉATTRIBUTION ───────────────────────────────
      // Le tableau de bord a changé la configuration d'un forfait DÉJÀ sur
      // l'appareil : l'instantané annonce une empreinte que le coffre n'a pas.
      // Seul un forfait ABSENT déclenchait un import : l'ancienne
      // configuration restait donc en service, et la nouvelle n'arrivait
      // qu'après un appui sur « Actualiser ». Le tunnel en cours n'est pas
      // touché : la nouvelle version sert à la prochaine connexion.
      const perimes = authority.snapshot.subscriptions.filter(item => {
        if (item.status !== 'active' || !item.configHash || dismissed.has(item.id)) return false;
        const detenu = entries.find(entry => managedProfile(entry) && (entry.subscriptionId || entry.configId) === item.id);
        if (!detenu || detenu.configHash === item.configHash || majLancees.get(item.id) === item.configHash) return false;
        return !profileRestriction(authority, { configId: item.id, subscriptionId: item.id, source: 'backend', configHash: item.configHash });
      });
      for (const item of perimes) majLancees.set(item.id, item.configHash!);
      if (manquant || perimes.length > 0) scheduleAutoImport(true);
    }
    await currentRuntime?.changed();
  });
  reconciliation = operation.catch(reportAccessSyncError);
  return operation;
}

function parseConnections(data: unknown): VpnConnection[] {
  if (!isRecord(data) || !Array.isArray(data.connections)) throw new Error('ACCESS_CONNECTIONS_INVALID');
  const ids = new Set<string>();
  return data.connections.map((entry): VpnConnection => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.name !== 'string' || typeof entry.status !== 'string' ||
        !['active', 'suspended', 'revoked', 'deleted', 'expired', 'exhausted'].includes(entry.status) ||
        !isRecord(entry.quota) || typeof entry.quota.totalBytes !== 'number' ||
        typeof entry.quota.usedBytes !== 'number') throw new Error('ACCESS_CONNECTIONS_INVALID');
    ids.add(entry.id);
    const totalBytes = entry.quota.totalBytes;
    const usedBytes = entry.quota.usedBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || !Number.isSafeInteger(usedBytes) || usedBytes < 0) throw new Error('ACCESS_CONNECTIONS_INVALID');
    return {
      id: entry.id, name: entry.name, status: entry.status,
      displayProtocol: typeof entry.displayProtocol === 'string' ? entry.displayProtocol : '',
      technicalProtocol: typeof entry.technicalProtocol === 'string' ? entry.technicalProtocol : '',
      dataToken: typeof entry.dataToken === 'string' ? entry.dataToken : '',
      quota: { totalBytes, usedBytes, totalGB: totalBytes / 1024 ** 3, usedGB: usedBytes / 1024 ** 3,
        remainingGB: Math.max(0, totalBytes - usedBytes) / 1024 ** 3 },
      duration: typeof entry.duration === 'number' ? entry.duration : 0,
      expiresAt: typeof entry.expiresAt === 'string' ? entry.expiresAt : null,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
      configVersion: typeof entry.configVersion === 'number' ? entry.configVersion : 1,
      sshRelayAvailable: entry.sshRelayAvailable === true,
      sshDirectAvailable: entry.sshDirectAvailable === true,
      configHash: typeof entry.configHash === 'string' ? entry.configHash : null,
      // Un serveur antérieur à cette correction n'envoie rien : l'absence vaut
      // « accès ordinaire », jamais un essai supposé.
      isFreeTrial: entry.isFreeTrial === true,
    };
  });
}

async function reconcileLegacyConnections(remote: VpnConnection[], authority: AccessAuthority): Promise<void> {
  // The legacy memory fallback returns [], so absence here is never a deletion.
  for (const entry of remote) {
    if (getAccessState().authority?.session !== authority.session) return;
    if (blocksProfile(entry.status)) {
      const stamp = captureAccessAuthority();
      if (stamp) await applyAccessIssue({
        code: entry.status === 'suspended' ? 'CONFIG_SUSPENDED' : entry.status === 'revoked' ? 'CONFIG_REVOKED'
          : entry.status === 'expired' ? 'CONFIG_EXPIRED' : entry.status === 'exhausted' ? 'CONFIG_EXHAUSTED' : 'CONFIG_DELETED',
        scope: 'subscription', temporary: !['revoked', 'deleted'].includes(entry.status), subscriptionId: entry.id,
      }, stamp, storeValue(await configStore.list()) ?? []);
    }
    // Only the new authoritative snapshot can lift a previously known block.
  }
}

export async function refreshAccessState(wait = false, signal?: AbortSignal, timeout = 35_000): Promise<boolean> {
  requireVpnConsent();
  if (!getAccessState().authority) return false;
  if (Date.now() < nativeHandoffUntil) return true;
  if (controlRequest) {
    if (wait) return controlRequest.promise;
    const pending = controlRequest;
    pending.controller.abort();
    // Some Android adapters never settle an aborted long poll.
    void pending.promise.catch(error => {
      if (responseInfo(error).status) reportAccessSyncError(error);
    });
    if (controlRequest === pending) controlRequest = null;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const promise = (async () => {
    const native = await syncNativeAccessState();
    if (native?.observing) return true; // One HTTP reader while the foreground service owns observation.
    const stamp = captureAccessAuthority();
    if (!stamp) return false;
    const snapshot = getAccessState().authority?.snapshot;
    const params = wait && snapshot ? { revision: snapshot.revision, wait: 25 } : undefined;
    try {
      const response = await apiClient.get('/mobile/access-state', { params, signal: controller.signal, timeout });
      if (controller.signal.aborted) return false;
      const profiles = storeValue(await configStore.list()) ?? [];
      if (controller.signal.aborted) return false;
      const applied = await applyAccessSnapshot(response.data, stamp, profiles);
      controlSupported = true;
      await reconcileAccess();
      return applied;
    } catch (error) {
      const status = responseInfo(error).status;
      if ((status === 404 || status === 405 || status === 501) && !accessIssueFromError(error)) {
        controlSupported = false;
        return false; // Endpoint not deployed; never turn a route-level 404 into logout.
      }
      throw error;
    }
  })();
  const request = { promise, controller };
  controlRequest = request;
  try { return await promise; }
  finally {
    signal?.removeEventListener('abort', cancel);
    if (controlRequest === request) controlRequest = null;
  }
}

export function refreshMobileConfigs(): Promise<VpnConnection[]> {
  if (refresh) return refresh;
  const epoch = lifecycle;
  const identity = accessRequestStamp();
  const operation = (async () => {
    requireVpnConsent();
    try { await refreshAccessState(); }
    catch (error) { reportAccessSyncError(error); }
    requireDeviceAccess();
    // Les suppressions faites dans l'application partent avant la relecture :
    // un forfait supprimé ne doit pas revenir dans la liste du serveur.
    try { await flushRemoteDeletions(); }
    catch (error) { reportAccessSyncError(error); }
    const requestStamp = accessRequestStamp();
    const response = await apiClient.get('/mobile/connections');
    if (epoch !== lifecycle || !currentIdentityRequest(identity)) return [];
    const remote = parseConnections(response.data);
    // A native snapshot may have arrived while the legacy list was in flight.
    if (!currentAccessRequest(requestStamp)) return connections;
    const authority = getAccessState().authority;
    if (controlSupported === false && authority) await reconcileLegacyConnections(remote, authority);
    const dismissed = new Set(storeValue(await configStore.listDismissed()) ?? []);
    connections = remote.filter(entry => !dismissed.has(entry.id));
    await reconcileAccess();
    // Une seule lecture du registre pour toute la boucle : elle sert à n'écrire
    // le marqueur d'essai QUE lorsqu'il change réellement, plutôt qu'à chaque
    // rafraîchissement (toutes les 30 s en mode hérité).
    const registres = storeValue(await configStore.list()) ?? [];
    const connus = new Map(registres.map(meta => [meta.configId, meta]));
    const importsConnus = new Set(
      registres
        .filter(meta => meta.source === 'backend')
        .map(meta => meta.configId),
    );
    const notes = new Map<string, ImportNote>();
    let miseAJourEnEchec = false;
    for (const entry of connections) {
      if (epoch !== lifecycle || !currentIdentityRequest(identity)) return [];
      const current = getAccessState().authority;
      if (!current || blocksDevice(deviceAccess(current))) break;
      const restriction = profileRestriction(current, {
        configId: entry.id, subscriptionId: entry.id, source: 'backend', configHash: entry.configHash,
      });
      // « Période d'essai » : le serveur seul en décide, à partir de la demande
      // d'essai déployée. On recopie sa réponse dans le registre pour que
      // l'accueil reste juste hors ligne — y compris quand le profil est
      // restreint, puisqu'un essai terminé doit encore pouvoir s'expliquer.
      const connu = connus.get(entry.id);
      if (connu && !!connu.isFreeTrial !== entry.isFreeTrial) {
        storeValue(await configStore.updateMetadata(entry.id, { isFreeTrial: entry.isFreeTrial }));
      }
      if (restriction || entry.status !== 'active') continue;
      // Une configuration illisible (payload perdu si le système a tué
      // l'application au milieu d'une écriture) ne doit pas faire échouer tout
      // le rafraîchissement — ce qui bloquait l'import de TOUS les forfaits :
      // elle est simplement réimportée, ce qui la répare.
      const lecture = await configStore.get(entry.id);
      const stored = lecture.status === 'ok' ? lecture.value : undefined;
      if (!entry.dataToken) {
        // Rien à provisionner sans jeton : on le note, pour que cette absence
        // ne relance pas un import à chaque instantané d'accès.
        if (!stored) notes.set(entry.id, { kind: 'failed', code: 'PVN_TOKEN_MISSING', retryable: false });
        continue;
      }
      const directUpgrade = stored && stored.config.sshRelay !== undefined;
      const changed = stored && (directUpgrade ||
        (entry.configHash ? stored.meta.configHash !== entry.configHash : stored.meta.configVersion !== entry.configVersion));
      if (!stored && !importsConnus.has(entry.id) && importsConnus.size >= MAX_IMPORTED_BACKEND_CONFIGS) {
        // Plafond atteint : une place tenue par une configuration qui ne peut
        // plus servir revient à ce forfait actif, au lieu de le laisser « à
        // télécharger » indéfiniment. Seules quatre configurations UTILISABLES
        // bloquent un import.
        const liberee = await libererPlaceInutilisable(importsConnus, current);
        if (!liberee) { notes.set(entry.id, { kind: 'cap', code: 'CONFIG_CAP_REACHED', retryable: false }); continue; }
        importsConnus.delete(liberee);
      }
      if (!stored || changed) {
        try {
          await provisionAndStore(entry.dataToken, current.deviceId, entry.id,
            directUpgrade ? stored : undefined);
          importsConnus.add(entry.id);
        }
        catch (error) {
          if (error instanceof ProvisioningError) console.warn('[Access] Provisioning deferred:', error.diagnostic.code);
          else reportAccessSyncError(error);
          notes.set(entry.id, importFailure(error));
          if (stored && importFailure(error).retryable) miseAJourEnEchec = true;
        }
        // Le provisionnement construit sa fiche à partir de la réponse
        // `/provision/activate`, qui ne connaît pas les essais : le marqueur est
        // apposé juste après, sans attendre le rafraîchissement suivant.
        if (entry.isFreeTrial) storeValue(await configStore.updateMetadata(entry.id, { isFreeTrial: true }));
      }
      if (controlSupported === false) {
        storeValue(await configStore.updateMetadata(entry.id, { name: entry.name, accessStatus: entry.status as 'active' }));
        await saveQuotaData({ configId: entry.id, totalQuota: entry.quota.totalBytes,
          usedQuota: entry.quota.usedBytes, expiryDate: entry.expiresAt });
      }
    }
    importNotes = notes;
    // Tant qu'un forfait attribué manque à cause d'un échec, une reprise est
    // programmée : l'utilisateur n'a jamais à relancer l'import lui-même.
    if (miseAJourEnEchec || [...notes.values()].some(note => note.kind === 'failed')) scheduleAutoImport();
    else autoImportAttempt = 0;
    await reconcileAccess();
    return connections;
  })();
  refresh = operation;
  void operation.finally(() => { if (refresh === operation) refresh = null; }).catch(() => { /* Caller handles the error. */ });
  // Un rafraîchissement qui échoue EN BLOC (réseau coupé avant même la liste)
  // n'a rien pu noter : sans cette reprise, un forfait tout juste attribué
  // attendrait le prochain geste de l'utilisateur.
  void operation.catch(() => { if (epoch === lifecycle) scheduleAutoImport(); });
  return operation;
}

function currentConfigRevision(stored: configStore.StoredConfig): boolean {
  const subscriptionId = stored.meta.subscriptionId || stored.meta.configId;
  const expected = getAccessState().authority?.snapshot?.subscriptions.find(entry => entry.id === subscriptionId)
    ?? connections.find(entry => entry.id === subscriptionId);
  return expected?.configHash ? stored.meta.configHash === expected.configHash
    : expected?.configVersion === undefined || stored.meta.configVersion === expected.configVersion;
}

/** A complete direct SSH cache needs no Internet request before the tunnel. */
export async function prepareSshConnection(id: string, stored: configStore.StoredConfig): Promise<Record<string, unknown>> {
  const protocol = String(stored.config.protocol || stored.meta.protocol || '').toLowerCase();
  if (!managedProfile(stored.meta) || !['ssh', 'ssh+payload'].includes(protocol)) return stored.config;
  const identity = accessRequestStamp();
  requireDeviceAccess();
  requireProfileAccess(stored.meta);
  const cached = storeValue(await configStore.get(id));
  if (!currentIdentityRequest(identity)) throw new Error('AUTH_SESSION_CHANGED');
  if (!cached) throw new Error('ACCESS_PROFILE_MISSING');
  requireDeviceAccess();
  requireProfileAccess(cached.meta);
  if (cached.config.sshRelay === undefined && isCompleteOfflineConfig(cached.config).complete &&
      currentConfigRevision(cached)) return cached.config;
  // A relay-only cache has no supplier identity to reconstruct locally.
  // Recover it once through the existing sealed provisioning path.
  const authority = getAccessState().authority;
  const token = (typeof cached.config.dataToken === 'string' ? cached.config.dataToken : undefined) ||
    cached.meta.dataToken || connections.find(entry => entry.id === id)?.dataToken;
  try {
    if (token && authority) {
      await provisionAndStore(token, authority.deviceId, id, cached);
    } else {
      await refreshMobileConfigs();
    }
  } catch (error) {
    if (!currentIdentityRequest(identity)) throw new Error('AUTH_SESSION_CHANGED');
    requireDeviceAccess();
    requireProfileAccess(cached.meta);
    if (accessIssueFromError(error) || responseInfo(error).status ||
        error instanceof ProvisioningError && error.diagnostic.httpStatus) throw error;
    if (error instanceof ProvisioningError &&
        !['PVN_NETWORK', 'PVN_TIMEOUT', 'PVN_UNKNOWN'].includes(error.diagnostic.code)) throw error;
    reportAccessSyncError(error);
    throw new ProvisioningError('Les identifiants SSH directs doivent être récupérés une fois auprès du serveur.', {
      code: 'SSH_DIRECT_SYNC_REQUIRED', stage: 'request', attempts: 1, retryable: true,
    });
  }
  if (!currentIdentityRequest(identity)) throw new Error('AUTH_SESSION_CHANGED');
  const current = storeValue(await configStore.get(id));
  if (!current) throw new Error('ACCESS_PROFILE_MISSING');
  requireDeviceAccess();
  requireProfileAccess(current.meta);
  if (current.config.sshRelay !== undefined || !isCompleteOfflineConfig(current.config).complete ||
      !currentConfigRevision(current)) {
    const note = importNotes.get(id);
    throw new ProvisioningError('La configuration SSH doit être synchronisée avec cette session.', {
      code: note?.code || 'SSH_DIRECT_SYNC_REQUIRED', stage: 'request', attempts: 1, retryable: note?.retryable ?? true,
    });
  }
  return current.config;
}

async function refreshNativeTicket(): Promise<void> {
  if (!nativeAccess() || controlSupported === false || ticketRequest || Date.now() < ticketRetryAt) return;
  const authority = getAccessState().authority;
  if (!authority || blocksDevice(deviceAccess(authority))) return;
  const native = getAccessState().native;
  if (native?.ticketStatus === 'ready' && native.ticketExpiresAt && Date.parse(native.ticketExpiresAt) - Date.now() > 3600_000) return;
  const stamp = accessRequestStamp();
  // Missing/invalid tickets cannot trigger an unbounded 401 acquisition loop.
  ticketRetryAt = Date.now() + 5 * 60_000;
  const operation = (async () => {
    const response = await apiClient.post('/mobile/access-ticket', {});
    requireVpnConsent();
    if (!currentIdentityRequest(stamp) || authority.session !== getAccessState().authority?.session) return;
    if (!isRecord(response.data) || typeof response.data.ticket !== 'string' || typeof response.data.expiresAt !== 'string') throw new Error('ACCESS_TICKET_INVALID');
    await storeNativeAccessTicket(API_BASE_URL, response.data.ticket, response.data.expiresAt, authority.session);
    await syncNativeAccessState();
  })();
  ticketRequest = operation;
  try { await operation; }
  catch (error) {
    ticketRetryAt = Date.now() + Math.max(5 * 60_000, retryDelay(0, responseInfo(error).retryAfter));
    reportAccessSyncError(error);
  } finally { if (ticketRequest === operation) ticketRequest = null; }
}

export async function prepareNativeAccess(): Promise<void> {
  if (nativeAccess()) {
    nativeHandoffUntil = Date.now() + 15_000;
    const pending = controlRequest;
    if (pending) {
      // Native observation takes over. Some Android HTTP adapters do not
      // settle on abort; the cancelled response is already rejected upstream.
      void pending.promise.catch(error => {
        if (responseInfo(error).status) reportAccessSyncError(error);
      });
      pending.controller.abort();
      if (controlRequest === pending) controlRequest = null;
    }
  }
  await refreshNativeTicket();
  requireDeviceAccess();
}

/** Owns foreground observation; Android continues independently only while its VPN service runs. */
export function startAccessObservation(): () => void {
  const epoch = ++lifecycle;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let running = false;
  let rerun = false;
  const controller = new AbortController();
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    if (!stopped && AppState.currentState === 'active' && getPrivacyConsent().vpn) timer = setTimeout(tick, delay);
  };
  const tick = async () => {
    if (running) { rerun = true; return; }
    if (stopped || AppState.currentState !== 'active' || !getPrivacyConsent().vpn) return;
    running = true;
    let delay = 1000;
    try {
      await refreshAccessState(controlSupported !== false, controller.signal);
      if (controlSupported === false) {
        await refreshMobileConfigs();
        delay = 30_000;
      } else {
        await refreshNativeTicket();
        if (getAccessState().native?.observing) delay = 30_000;
      }
      failures = 0;
    } catch (error) {
      if (!controller.signal.aborted) reportAccessSyncError(error);
      delay = ++failures >= 6 ? 300_000 : retryDelay(failures, responseInfo(error).retryAfter);
    } finally {
      running = false;
      if (rerun) { rerun = false; delay = 1000; }
      schedule(delay);
    }
  };
  const wake = () => {
    if (AppState.currentState === 'active') schedule(0);
    else { if (timer) clearTimeout(timer); timer = null; controlRequest?.controller.abort(); }
  };
  wakeObservation = wake;
  const foreground = AppState.addEventListener('change', wake);
  const privacy = subscribePrivacyConsent(wake);
  const unsubscribe = subscribeAccessState(() => { void reconcileAccess().catch(reportAccessSyncError); });
  const failuresSub = subscribeAccessFailures(({ issue, stamp }) => {
    if (issue.scope === 'session' || !currentAccessRequest(stamp)) return;
    const captured = captureAccessAuthority();
    if (!captured) return;
    void (async () => {
      await applyAccessIssue(issue, captured, storeValue(await configStore.list()) ?? []);
      await reconcileAccess();
    })().catch(reportAccessSyncError);
  });
  const native = nativeAccess() ? new NativeEventEmitter(NativeModules.SxbVpnNative) : null;
  const nativeSub = native?.addListener('onAccessStateChange', () => {
    controlRequest?.controller.abort();
    void syncNativeAccessState().then(() => reconcileAccess()).catch(reportAccessSyncError);
    wake();
  });
  schedule(0);
  return () => {
    stopped = true;
    if (epoch === lifecycle) {
      lifecycle++; connections = []; controlSupported = null; nativeHandoffUntil = 0; wakeObservation = null;
      stopAutoImport(); importNotes = new Map(); majLancees = new Map();
    }
    controller.abort();
    controlRequest?.controller.abort();
    if (timer) clearTimeout(timer);
    foreground.remove(); privacy(); unsubscribe(); failuresSub(); nativeSub?.remove();
  };
}

export function wakeAccessObservation(): void { wakeObservation?.(); }
