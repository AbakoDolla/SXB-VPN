/*
 * resolve-hooks.mjs — Hook `resolve` Node.js
 *
 * 1. Redirige toute import de server/database.ts (root ou backend/) vers
 *    scripts/tests/stubs/database-stub.mjs (Prisma mock en mémoire).
 * 2. Ajoute le fallback d'extension `.ts` pour les imports relatifs sans
 *    extension (les sources serveur utilisent des imports style bundler).
 */
const STUB = new URL('./stubs/database-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Cas direct
  try {
    const result = await nextResolve(specifier, context);
    if (/\/server\/database\.(ts|js)$/.test(result.url) || result.url.endsWith('/server/database')) {
      return { url: STUB, shortCircuit: true };
    }
    return result;
  } catch (err) {
    // Fallback : imports relatifs extensionless → essayer avec ".ts"
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      try {
        const retry = await nextResolve(specifier + '.ts', context);
        if (/\/server\/database\.ts$/.test(retry.url)) {
          return { url: STUB, shortCircuit: true };
        }
        return retry;
      } catch { /* tombe dans le throw ci-dessous */ }
    }
    throw err;
  }
}
