import { resolveDistribution } from './distributionPolicy';

export { PRIVACY_URL, DATA_DELETION_URL } from './distributionPolicy';

/**
 * Canal de distribution de cette application — toujours « direct ».
 *
 * Les marqueurs de build ne sont plus lus : il n'existe qu'un seul canal.
 * Voir `distributionPolicy.ts` pour ce que le retrait du canal Play répare.
 */
export const distribution = resolveDistribution();
