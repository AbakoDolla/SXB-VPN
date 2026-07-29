/**
 * register-hooks.mjs — Enregistre les hooks de résolution de modules
 * permettant de substituer server/database.ts par un stub Prisma en mémoire
 * pour les tests E2E de routes HTTP (aucune DB requise).
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL(new URL('./resolve-hooks.mjs', import.meta.url).pathname));
