/**
 * config-hash.ts — Hash de configuration exposé au mobile (invalidation de cache, §6.4)
 *
 * - Profil IMPORTÉ : empreinte opaque stockée à l'import (HMAC versionné pour
 *   les nouveaux imports, SHA-256 historique conservé pour les anciens).
 * - Profil LEGACY (colonnes) : hash déterministe sur les colonnes techniques
 *   NON secrètes + updatedAt — tout changement de profil change le hash.
 *
 * Jamais de credential dans le matériau du hash legacy (password/uuid exclus).
 */
import crypto from 'crypto';

export function configHashForProfile(profile: any): string | null {
  if (!profile) return null;
  if (profile.canonicalConfigHash) return profile.canonicalConfigHash;
  const src = JSON.stringify({
    protocol:  profile.protocol  ?? null,
    host:      profile.host      ?? null,
    port:      profile.port      ?? null,
    tls:       profile.tls       ?? null,
    sni:       profile.sni       ?? null,
    network:   profile.network   ?? null,
    path:      profile.path      ?? null,
    dns:       profile.dns       ?? null,
    method:    profile.method    ?? null,
    payloadId: profile.payloadId ?? null,
    updatedAt: profile.updatedAt ? new Date(profile.updatedAt).toISOString() : null,
  });
  return crypto.createHash('sha256').update(src).digest('hex');
}

export function configVersionForProfile(profile: any): number {
  const v = profile?.configVersion;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : 1;
}
