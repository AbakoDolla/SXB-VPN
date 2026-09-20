/**
 * L'historique de consommation ne se reinitialise jamais.
 *
 * CE QUE LE PROPRIETAIRE EXIGE
 * ────────────────────────────
 * « Le systeme ne doit PAS reinitialiser la consommation parce que
 *   l'utilisateur se deconnecte, passe hors ligne ou devient inactif. »
 *
 * CE QUE LA MESURE A MONTRE
 * ─────────────────────────
 * En production, 79 forfaits sur 95 portent une consommation non nulle, et
 * `quotaUsed` est une COLONNE STOCKEE : elle ne se recalcule pas depuis une
 * session vivante, donc une deconnexion ne peut structurellement pas l'effacer.
 *
 * CE QUI N'ETAIT PROTEGE PAR RIEN
 * ───────────────────────────────
 * La seule facon de perdre cet historique serait qu'un chemin de MISE A JOUR
 * ecrive un zero — en changeant un quota, en prolongeant une echeance, en
 * reactivant un acces. Rien ne l'interdisait. Ce test l'interdit.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Chaque source du serveur, routes et services confondus. */
function sourcesServeur() {
  const fichiers = [];
  for (const dossier of ['routes', 'services']) {
    const base = path.join(racine, 'server', dossier);
    for (const nom of readdirSync(base).filter(n => n.endsWith('.ts'))) {
      fichiers.push([path.join('server', dossier, nom), readFileSync(path.join(base, nom), 'utf8')]);
    }
  }
  return fichiers;
}

test('remettre la consommation a zero n’est possible qu’a la CREATION', () => {
  // Un zero est legitime quand on cree un forfait : il n'a rien consommé.
  // Il ne l'est JAMAIS dans une mise à jour — ce serait effacer l'historique
  // d'un client qui a réellement consommé.
  const coupables = [];

  for (const [nom, source] of sourcesServeur()) {
    // Chaque écriture de `quotaUsed`/`quotaUsedBytes` à zéro, avec ce qui la
    // précède : c'est l'appel englobant qui dit s'il s'agit d'une création.
    const motif = /quotaUsed(?:Bytes)?:\s*(?:BigInt\(0\)|0)\b/g;
    for (const trouve of source.matchAll(motif)) {
      const avant = source.slice(Math.max(0, trouve.index - 700), trouve.index);
      // Le dernier appel ouvert avant l'écriture.
      const dernierAppel = [...avant.matchAll(/\.(create|createMany|update|updateMany|upsert)\s*\(/g)].pop();
      const operation = dernierAppel ? dernierAppel[1] : '(inconnue)';
      if (operation === 'create' || operation === 'createMany') continue;
      const ligne = source.slice(0, trouve.index).split('\n').length;
      coupables.push(`${nom}:${ligne} — ${operation}`);
    }
  }

  assert.deepEqual(coupables, [],
    'un zéro écrit hors création effacerait la consommation déjà mesurée');
});

test('le planificateur de forfaits LIT la consommation sans jamais l’ecrire', () => {
  // C'est le chemin par lequel passent tous les changements groupés : quota,
  // durée, échéance, suspension, réactivation. S'il écrivait `quotaUsed`, un
  // simple ajustement de quota effacerait ce que le client a consommé.
  const source = readFileSync(path.join(racine, 'server/services/subscription-bulk.ts'), 'utf8');
  assert.match(source, /versBigInt\(forfait\.quotaUsed\)/, 'la consommation doit être lue');
  assert.doesNotMatch(source, /data\.quotaUsed\s*=/, 'la consommation ne doit jamais être réécrite');
  assert.doesNotMatch(source, /quotaUsed:\s*(?:BigInt\(0\)|0)\b/,
    'le planificateur ne doit jamais remettre la consommation à zéro');
});

test('la conversion d’un essai preserve la consommation', () => {
  // Convertir un essai en forfait payant change la NATURE de l'accès, pas son
  // passé : le client qui a consommé 7 Go pendant son essai les a bien
  // consommés. Les remettre à zéro lui offrirait un volume qu'il a déjà pris.
  const service = readFileSync(path.join(racine, 'server/services/free-trial.ts'), 'utf8');
  const debut = service.indexOf('export function planifierConversion');
  assert.ok(debut > 0, 'le planificateur de conversion doit exister');
  const bloc = service.slice(debut, service.indexOf('export function vueJetonPourAdmin', debut));
  assert.doesNotMatch(bloc, /quotaUsed/,
    'la conversion ne doit toucher en rien à la consommation déjà mesurée');
});
