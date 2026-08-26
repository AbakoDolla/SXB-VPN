import { apiRequest } from './client';

export const APP_ROLES = ['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'] as const;
export type AppRole = typeof APP_ROLES[number];

export interface AppUpdate {
  id: string;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  notes: string;
  minSupportedCode: number;
  forceUpdate: boolean;
  targetRoles: string[];
  targetDeviceIds: string[];
  publishedAt: string;
  updatedAt: string;
}

export interface AppUpdateResponse {
  update: AppUpdate | null;
  visibleToRole?: boolean;
  canPublish: boolean;
  eligibleDeviceCount: number;
}

export type AppUpdateInput = Omit<AppUpdate, 'id' | 'publishedAt' | 'updatedAt'> & { active: boolean };

export async function fetchCurrentAppUpdate(): Promise<AppUpdateResponse> {
  return apiRequest<AppUpdateResponse>('/app-updates/current');
}

export async function publishAppUpdate(input: AppUpdateInput): Promise<AppUpdateResponse> {
  return apiRequest<AppUpdateResponse>('/app-updates/publish', { method: 'POST', body: input });
}

export async function disableAppUpdate(): Promise<void> {
  await apiRequest('/app-updates/current', { method: 'DELETE' });
}
