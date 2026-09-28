/**
 * parite-schemas-prisma.test.mjs — Alarme anti-divergence des schémas Prisma
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE BANC
 *
 * Le dépôt porte DEUX schémas Prisma :
 *   - prisma/schema.prisma          (racine)
 *   - backend/prisma/schema.prisma  (miroir)
 *
 * Et c'est le MIROIR qui est comparé à la base de production :
 *   scripts/backend-migrate.cjs — DDL explicites puis migrate diff readonly.
 * La racine ne sert qu'à `prisma generate`.
 *
 * Conséquence : une modification portée sur la SEULE racine n'atteint jamais
 * la base. Le déploiement réussit, la CI reste verte, et la contrainte
 * attendue n'existe pas en production — une panne parfaitement silencieuse.
 *
 * Aucun script ne synchronise les deux fichiers : la parité ne tient que par
 * discipline. Ce banc transforme cette discipline en échec de CI.
 *
 * CE QU'IL VÉRIFIE, au-delà de la simple égalité d'empreinte :
 *   1. les deux schémas existent ;
 *   2. ils sont identiques — avec un diff lisible et la marche à suivre ;
 *   3. le schéma poussé en production est bien celui qui est sous surveillance
 *      (si le workflow change de cible, l'alarme surveillerait un fichier
 *      inerte : ce banc le détecte) ;
 *   4. les contraintes d'unicité critiques figurent dans le schéma DÉPLOYÉ.
 *
 * Ce banc est en LECTURE SEULE : il ne réaligne rien, il alerte.
 *
 * Vérifiable à l'envers : la variable d'environnement PARITE_RACINE permet de
 * le pointer vers une arborescence de contrôle pour prouver qu'il échoue bien
 * sous divergence volontaire, sans jamais toucher aux schémas réels.
 *
 * Exécution CI : node --experimental-strip-types --test scripts/tests/*.test.mjs
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PARITE_RACINE
  ? path.resolve(process.env.PARITE_RACINE)
  : path.resolve(__dirname, '../..');

const SCHEMA_RACINE = 'prisma/schema.prisma';
const SCHEMA_DEPLOYE = 'backend/prisma/schema.prisma';
const WORKFLOW = '.github/workflows/deploy-vps.yml';

const chemin = (rel) => path.join(ROOT, rel);
const lire = (rel) => fs.readFileSync(chemin(rel), 'utf8');
const empreinte = (rel) =>
  crypto.createHash('sha256').update(fs.readFileSync(chemin(rel))).digest('hex');

/** Premières lignes divergentes, pour rendre l'échec exploitable. */
function premieresDivergences(a, b, maximum = 5) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const ecarts = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && ecarts.length < maximum; i++) {
    if (la[i] !== lb[i]) {
      ecarts.push(
        `    l.${i + 1}\n` +
          `      ${SCHEMA_RACINE}  : ${la[i] === undefined ? '<absente>' : JSON.stringify(la[i])}\n` +
          `      ${SCHEMA_DEPLOYE} : ${lb[i] === undefined ? '<absente>' : JSON.stringify(lb[i])}`,
      );
    }
  }
  return ecarts;
}

test('les deux schémas Prisma existent', () => {
  for (const rel of [SCHEMA_RACINE, SCHEMA_DEPLOYE]) {
    assert.ok(
      fs.existsSync(chemin(rel)),
      `${rel} est introuvable. Les deux schémas sont requis : la racine alimente ` +
        `\`prisma generate\`, le miroir backend/ est appliqué à la base de production.`,
    );
  }
});

test('le schéma racine et le schéma déployé sont strictement identiques', () => {
  const contenuRacine = lire(SCHEMA_RACINE);
  const contenuDeploye = lire(SCHEMA_DEPLOYE);
  const empreinteRacine = empreinte(SCHEMA_RACINE);
  const empreinteDeploye = empreinte(SCHEMA_DEPLOYE);

  if (empreinteRacine !== empreinteDeploye) {
    const ecarts = premieresDivergences(contenuRacine, contenuDeploye);
    assert.fail(
      `\n\n  ⛔ DIVERGENCE DES SCHÉMAS PRISMA — le déploiement ignorerait vos changements.\n\n` +
        `  ${SCHEMA_RACINE}\n    sha256 ${empreinteRacine}\n` +
        `  ${SCHEMA_DEPLOYE}\n    sha256 ${empreinteDeploye}\n\n` +
        `  Premières lignes divergentes :\n${ecarts.join('\n')}\n\n` +
        `  POURQUOI C'EST BLOQUANT\n` +
        `    Le déploiement applique « ${SCHEMA_DEPLOYE} » à la base\n` +
        `    (${WORKFLOW}, gate backend-migrate et comparaison readonly).\n` +
        `    Une modification portée sur la seule racine n'atteint JAMAIS la production :\n` +
        `    le déploiement réussit, la CI passe, et la contrainte n'existe pas en base.\n\n` +
        `  MARCHE À SUIVRE\n` +
        `    Reportez la modification sur les DEUX fichiers, puis vérifiez :\n` +
        `      node --experimental-strip-types --test scripts/tests/parite-schemas-prisma.test.mjs\n`,
    );
  }
  assert.equal(empreinteRacine, empreinteDeploye);
});

test('le schéma surveillé est bien celui que le déploiement compare à la base réelle', () => {
  const workflow = lire(WORKFLOW);
  const executable = workflow
    .split('\n')
    .filter((ligne) => !/^\s*#/.test(ligne))
    .join('\n');
  assert.match(executable, /^\s*node scripts\/backend-migrate\.cjs prepare\s*$/m);
  assert.doesNotMatch(executable, /db\s+push|accept-data-loss/);
  const cli = lire('scripts/backend-migrate.cjs');
  assert.match(cli, /"server", "services", "backend-migration\.ts"/);
  const gate = lire('server/services/backend-migration.ts');
  const cible = gate.match(/export const BACKEND_SCHEMA = "([^"]+)"/)?.[1];
  assert.equal(cible, SCHEMA_DEPLOYE, 'Le gate doit comparer le schema backend surveille, pas un fichier inerte');
  assert.match(gate, /const schema = path\.join\(options\.root, BACKEND_SCHEMA\)/);
  assert.match(gate, /"--from-schema-datasource", schema, "--to-schema-datamodel", schema, "--exit-code"/);
  assert.match(gate, /result\.code === 2.*BACKEND_SCHEMA_DRIFT/);
});

test('les contraintes d’unicité critiques figurent dans le schéma déployé', () => {
  const deploye = lire(SCHEMA_DEPLOYE);
  // Ces deux contraintes portent le cloisonnement par propriétaire : elles
  // n'ont d'effet en production que parce qu'elles sont dans le schéma poussé.
  const requises = ['@@unique([managedById, deviceId])', '@@unique([createdBy, uuid])'];
  for (const contrainte of requises) {
    assert.ok(
      deploye.includes(contrainte),
      `\n\n  ⛔ « ${contrainte} » absente de ${SCHEMA_DEPLOYE}.\n` +
        `  Cette contrainte porte le cloisonnement par propriétaire ; sans elle dans le\n` +
        `  schéma DÉPLOYÉ, la base de production ne l'applique pas, quelle que soit la\n` +
        `  présence de la contrainte dans ${SCHEMA_RACINE}.\n`,
    );
  }
});
