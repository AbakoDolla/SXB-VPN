import { apiRequest } from './client';

export interface MobileHealthTotals {
  devices: number;
  active: number;
  inactive: number;
  reports: number;
  successes: number;
  failures: number;
  successRate: number;
  updatesNeeded: number;
}

export interface MobileHealthVersion {
  appVersion: string;
  versionCode: number;
  devices: number;
  updatesNeeded: number;
}

export interface MobileHealthDevice {
  pseudonym: string;
  appVersion: string;
  versionCode: number;
  androidApi: number | null;
  deviceModel: string | null;
  lastSeenAt: string;
  tunnelState: string;
  protocol: string | null;
  lastOutcome: string;
  lastErrorCode: string | null;
  sessionDurationSeconds: number;
  reconnectCount: number;
  activeDurationSeconds: number;
  backgroundDurationSeconds: number;
  wakeCount: number;
  reportCount: number;
  batteryOptimization: string;
  needsUpdate: boolean;
}

export interface MobileHealthSummary {
  generatedAt: string;
  retentionDays: number;
  activeWindowHours: number;
  deviceRetentionDays: number;
  detailsLimit: number;
  detailsTruncated: boolean;
  latestVersionCode: number | null;
  totals: MobileHealthTotals;
  versions: MobileHealthVersion[];
  devices: MobileHealthDevice[];
}

export function fetchMobileHealthSummary(): Promise<MobileHealthSummary> {
  return apiRequest<MobileHealthSummary>('/mobile-health/summary');
}
