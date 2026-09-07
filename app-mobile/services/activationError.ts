export type ActivationErrorKey =
  | 'token_not_found'
  | 'token_used'
  | 'error_invalid_token'
  | 'error_expired_token'
  | 'error_suspended'
  | 'activation_account_expired'
  | 'activation_quota_reached'
  | 'activation_forbidden'
  | 'activation_rate_limited'
  | 'error_no_network'
  | 'error_server'
  | 'error_generic';

type HttpErrorLike = {
  response?: {
    status?: number;
    data?: unknown;
  };
};

function normalizeMarker(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function responseMarker(error: HttpErrorLike): string {
  const data = error.response?.data;
  if (typeof data === 'string') return normalizeMarker(data);
  if (!data || typeof data !== 'object') return '';

  const record = data as Record<string, unknown>;
  return [
    record.code,
    record.error,
    record.message,
    record.reason,
    record.status,
  ].map(normalizeMarker).filter(Boolean).join(' ');
}

function containsAny(marker: string, values: string[]): boolean {
  return values.some((value) => marker.includes(value));
}

/**
 * Les statuts HTTP seuls ne suffisent pas : 403 couvre aussi bien un quota
 * atteint, un compte suspendu qu'un refus de propriété. Seul un code/message
 * explicitement lié à l'expiration peut donc afficher « token expiré ».
 */
export function activationErrorKey(error: unknown): ActivationErrorKey {
  const httpError = (error ?? {}) as HttpErrorLike;
  const status = httpError.response?.status;
  const marker = responseMarker(httpError);

  if (!httpError.response) return 'error_no_network';

  if (containsAny(marker, ['quota', 'capacity', 'capacite', 'limit_reached', 'limit reached'])) {
    return 'activation_quota_reached';
  }
  if (
    containsAny(marker, ['reseller_expired', 'account_expired', 'access_expired', 'acces expire'])
  ) {
    return 'activation_account_expired';
  }
  if (containsAny(marker, ['token_expired', 'token expired', 'token expire'])) {
    return 'error_expired_token';
  }
  if (containsAny(marker, ['suspended', 'suspendu', 'revoked', 'revoque', 'disabled', 'desactive'])) {
    return 'error_suspended';
  }
  if (containsAny(marker, ['already_used', 'already used', 'deja utilise', 'token_used', 'claimed'])) {
    return 'token_used';
  }
  if (containsAny(marker, ['not_found', 'not found', 'introuvable'])) {
    return 'token_not_found';
  }
  if (containsAny(marker, ['invalid', 'invalide', 'malformed', 'format'])) {
    return 'error_invalid_token';
  }

  if (status === 404) return 'token_not_found';
  if (status === 409) return 'token_used';
  if (status === 410) return 'error_expired_token';
  if (status === 400 || status === 422) return 'error_invalid_token';
  if (status === 429) return 'activation_rate_limited';
  if (status === 401 || status === 403) return 'activation_forbidden';
  if (status !== undefined && status >= 500) return 'error_server';
  return 'error_generic';
}
