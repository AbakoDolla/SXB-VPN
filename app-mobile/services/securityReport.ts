/** Bounded observations and durable native events; delivery failure never stops a tunnel. */
import { InteractionManager, NativeModules, Platform } from 'react-native';
import apiClient from './apiClient';
import { sessionSecurity } from './deviceSecurity';

interface RapportNatif {
  isRooted?: boolean;
  hasFrida?: boolean;
  hasXposed?: boolean;
  isEmulator?: boolean;
  isHooked?: boolean;
  debugger?: boolean;
  signatureStatus?: string;
  packageName?: string;
  appVersion?: string;
  buildType?: string;
  channel?: string;
  certificateDigests?: string[];
}
interface ModuleNatif {
  checkSecurity?: () => Promise<RapportNatif>;
  pendingSecurityEvents?: () => Promise<string>;
  acknowledgeSecurityEvents?: (ids: string) => Promise<void>;
}
const INTERVALLE_MS = 30 * 60 * 1000;
const DELAI_REPOS_MS = 1_500;
let dernierEnvoi = 0;
let derniereEmpreinte = '';
let flushing = false;

function natif(): ModuleNatif | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.SxbVpnNative as ModuleNatif | undefined) ?? null;
}

export function signauxDepuisRapport(rapport: RapportNatif | null | undefined): Record<string, boolean> {
  if (!rapport) return {};
  const signaux: Record<string, boolean> = {};
  if (rapport.isRooted) signaux.rooted = true;
  if (rapport.hasFrida) signaux.frida = true;
  if (rapport.hasXposed) signaux.xposed = true;
  if (rapport.isHooked) signaux.hooked = true;
  if (rapport.isEmulator) signaux.emulator = true;
  if (rapport.debugger) signaux.debugger = true;
  if (rapport.signatureStatus === 'INVALID') signaux.signatureInvalid = true;
  return signaux;
}

export async function flushSecurityEvents(): Promise<void> {
  const module = natif();
  if (flushing || !module?.pendingSecurityEvents || !module.acknowledgeSecurityEvents) return;
  flushing = true;
  try {
    const authority = await sessionSecurity();
    const pending: Array<Record<string, unknown>> = JSON.parse(await module.pendingSecurityEvents());
    const events = pending.filter(event => authority
      ? event.securityClientId === authority.clientId : !event.securityClientId)
      .map(({ securityClientId: _client, ...event }) => event);
    if (events.length) {
      const response = await apiClient.post('/mobile-security/events', { events: events.slice(0, 25) }, { timeout: 8_000 });
      if (!Array.isArray(response.data.acceptedIds)) throw new Error('SECURITY_EVENT_RESPONSE_INVALID');
      await module.acknowledgeSecurityEvents(JSON.stringify(response.data.acceptedIds));
    }
  } catch {
    console.warn('[SXB] SECURITY_EVENT_DELIVERY_DEFERRED');
  } finally { flushing = false; }
}

export async function remonterIntegrite(options: { force?: boolean; decoy?: string } = {}): Promise<void> {
  await flushSecurityEvents();
  const module = natif();
  if (!module?.checkSecurity) return;
  const maintenant = Date.now();
  if (!options.force && maintenant - dernierEnvoi < INTERVALLE_MS) return;
  dernierEnvoi = maintenant;
  await new Promise<void>(resolve => {
    InteractionManager.runAfterInteractions(() => { setTimeout(resolve, DELAI_REPOS_MS); });
  });
  try {
    const rapport = await module.checkSecurity();
    const signaux = signauxDepuisRapport(rapport);
    if (options.decoy) signaux.decoyTouched = true;
    const noms = Object.keys(signaux).sort();
    if (noms.length === 0) { derniereEmpreinte = ''; return; }
    const empreinte = noms.join(',');
    if (!options.force && empreinte === derniereEmpreinte) return;
    await apiClient.post('/mobile-security/report', {
      signals: signaux, appVersion: rapport.appVersion,
      integrity: {
        packageName: rapport.packageName, buildType: rapport.buildType,
        channel: rapport.channel, certificateDigests: rapport.certificateDigests,
      },
      ...(options.decoy ? { decoy: options.decoy } : {}),
    }, { timeout: 8_000 });
    derniereEmpreinte = empreinte;
  } catch {
    console.warn('[SXB] SECURITY_OBSERVATION_DEFERRED');
  }
}

export function reinitialiserRemontee(): void {
  dernierEnvoi = 0;
  derniereEmpreinte = '';
}
