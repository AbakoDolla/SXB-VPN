---
name: SXB VPN API Null-Safety Pattern
description: Pattern obligatoire pour toutes les fonctions API fetch du dashboard
---

## Le problème

Les fonctions `fetchXxx()` dans `artifacts/sxb-dashboard/src/api/` retournaient `res.accounts` directement. Si l'API échouait (403, 500, réseau), `res` était undefined et `.map()` crashait toute la vue → ErrorBoundary → "Une erreur est survenue".

## Le fix (pattern canonique)

```typescript
export async function fetchXrayAccounts(): Promise<XrayAccount[]> {
  try {
    const res = await apiRequest<{ accounts: XrayAccount[] }>('/xray/accounts');
    return res?.accounts ?? [];
  } catch { return []; }
}

export async function fetchXrayStats(): Promise<XrayStats> {
  try {
    const res = await apiRequest<{ stats: XrayStats }>('/xray/stats');
    return res?.stats ?? { total: 0, active: 0, byProtocol: [] };
  } catch { return { total: 0, active: 0, byProtocol: [] }; }
}
```

## Fichiers corrigés

- `api/xray.ts` — fetchXrayAccounts, fetchXrayStats, fetchXrayProtocols
- `api/singbox.ts` — fetchSingboxAccounts, fetchSingboxStats, fetchSingboxProtocols
- `api/ssh.ts` — fetchSshAccounts, fetchSshStats
- `api/payload.ts` — fetchPayloads

**Why:** Le backend peut retourner 401/403/500 pour des raisons valides (permission manquante, route non encore implémentée, DB down). Les composants React appellent `.map()` directement sur le retour → TypeError sur undefined → crash du composant entier.

**How to apply:** Toute nouvelle fonction fetch qui retourne un tableau DOIT utiliser `try/catch + ?? []`. Toute fonction qui retourne un objet DOIT fournir un fallback avec les valeurs à zéro.
