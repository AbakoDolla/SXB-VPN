import { apiRequest } from './client';

export const APP_ROLES = ['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'] as const;
export type AppRole = typeof APP_ROLES[number];

export interface AppUpdate {
  id: string;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  /** Condensat SHA-256 de l'APK ; vide si non renseigné. */
  apkSha256: string;
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
  /**
   * La publication décrit-elle encore l'APK réellement servie ?
   *
   * L'URL publiée est un pointeur mobile : chaque construction remplace le
   * fichier derrière elle, et le condensat publié devient faux. Le serveur
   * cesse alors d'annoncer la mise à jour, car tout téléchargement échouerait
   * au contrôle d'intégrité.
   */
  describesServedApk?: boolean;
  /** Vrai quand la publication est réellement distribuée en ce moment. */
  distributed?: boolean;
}

export type AppUpdateInput = Omit<AppUpdate, 'id' | 'publishedAt' | 'updatedAt'> & { active: boolean };

/** La dernière APK réellement déployée, telle que la chaîne d'intégration l'a écrite. */
export interface AppBuild {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  apkSha256: string;
  sizeBytes: number;
  releaseTag: string;
  releaseUrl: string;
  commit: string;
  builtAt: string;
}

export interface LatestBuildResponse {
  build: AppBuild | null;
  newerThanPublished: boolean;
}

export async function fetchCurrentAppUpdate(): Promise<AppUpdateResponse> {
  return apiRequest<AppUpdateResponse>('/app-updates/current');
}

/**
 * Lit la dernière APK construite et déployée.
 *
 * Ne publie rien : sert uniquement à pré-remplir le formulaire avec des valeurs
 * exactes, le condensat SHA-256 en particulier — 64 caractères dont une seule
 * faute fait refuser l'installation par tous les appareils, après téléchargement.
 */
export async function fetchLatestBuild(): Promise<LatestBuildResponse> {
  return apiRequest<LatestBuildResponse>('/app-updates/latest-build');
}

export async function publishAppUpdate(input: AppUpdateInput): Promise<AppUpdateResponse> {
  return apiRequest<AppUpdateResponse>('/app-updates/publish', { method: 'POST', body: input });
}

export async function disableAppUpdate(): Promise<void> {
  await apiRequest('/app-updates/current', { method: 'DELETE' });
}
