/** Client observations are forgeable. Only the server supplies confirmed violations. */
export const SIGNAUX_MOBILES = [
  'signatureInvalid', 'decoyTouched', 'hooked', 'frida', 'xposed',
  'attestationFailed', 'debugger', 'rooted', 'emulator',
] as const;
export type SignalMobile = (typeof SIGNAUX_MOBILES)[number];
export type RiskLevel = 'NORMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ConfirmedViolation = 'TOKEN_REPLAY' | 'DEVICE_MISMATCH' | 'SESSION_REPLAY';
export type ActionRisque = 'none' | 'watch' | 'revalidate' | 'revoke_session';

export interface RiskPolicy {
  version: number;
  medium: number;
  high: number;
  weights: Record<SignalMobile, number>;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  version: 1, medium: 30, high: 65,
  weights: {
    signatureInvalid: 75, decoyTouched: 40, hooked: 50, frida: 50, xposed: 40,
    attestationFailed: 40, debugger: 30, rooted: 10, emulator: 10,
  },
};

export interface EvaluationRisque {
  score: number;
  level: RiskLevel;
  severity: 'info' | 'warning' | 'critical';
  action: ActionRisque;
  signaux: SignalMobile[];
  policyVersion: number;
  evidence: 'client_observation' | 'server_verified';
}

export function normaliserSignaux(brut: unknown): SignalMobile[] {
  if (!brut || typeof brut !== 'object') return [];
  const source = brut as Record<string, unknown>;
  return SIGNAUX_MOBILES.filter(signal => source[signal] === true);
}

export function evaluerRisque(
  signaux: SignalMobile[],
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
  confirmed?: ConfirmedViolation,
): EvaluationRisque {
  const retenus = [...new Set(signaux)].filter(signal => SIGNAUX_MOBILES.includes(signal));
  const common = { signaux: retenus, policyVersion: policy.version };
  if (confirmed) {
    return { ...common, score: 100, level: 'CRITICAL', severity: 'critical',
      action: 'revoke_session', evidence: 'server_verified' };
  }
  // Correlated local observations are not independent evidence. In particular,
  // root + several hook detectors must not manufacture a confirmed compromise.
  const score = Math.min(89, Math.max(0, ...retenus.map(signal => policy.weights[signal])));
  const rootOnly = retenus.length === 1 && retenus[0] === 'rooted';
  const level: RiskLevel = score === 0 ? 'NORMAL' : rootOnly ? 'LOW'
    : score >= policy.high ? 'HIGH' : score >= policy.medium ? 'MEDIUM' : 'LOW';
  return {
    ...common, score, level, evidence: 'client_observation',
    severity: level === 'HIGH' || level === 'MEDIUM' ? 'warning' : 'info',
    action: level === 'HIGH' ? 'revalidate' : level === 'MEDIUM' ? 'watch' : 'none',
  };
}

export function meriteUneTrace(evaluation: EvaluationRisque): boolean {
  return evaluation.signaux.length > 0 || evaluation.evidence === 'server_verified';
}
