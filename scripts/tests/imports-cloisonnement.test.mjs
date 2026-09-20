/**
 * Toute fonction de cloisonnement employee doit etre IMPORTEE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE TEST EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * En posant le cloisonnement sur les chiffres du tableau de bord, j'ai employe
 * `porteeServeurs`, `porteeRevendeurs` et `porteeBons` dans `dashboard.ts`
 * SANS les importer. Rien ne l'a signale :
 *
 *   • le `tsconfig` racine porte `"files": []` et ne couvre pas `server/` —
 *     un « typecheck » y passe sans rien verifier de ce code ;
 *   • le build de production passe par esbuild, qui ne verifie pas les types
 *     et resout sans broncher un import nomme absent.
 *
 * La faute ne serait donc apparue qu'A L'EXECUTION, en production, sous la
 * forme d'un `porteeServeurs is not defined` au premier chargement du tableau
 * de bord — c'est-a-dire pour tout le monde a la fois.
 *
 * Ce test ferme cette porte pour TOUTES les surfaces, pas seulement celle ou
 * la faute a eu lieu.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleCloisonnement = path.join(racine, 'server', 'services', 'portee-donnees.ts');

/** Les fonctions que le module de cloisonnement expose. */
function fonctionsExportees() {
  const source = readFileSync(moduleCloisonnement, 'utf8');
  return new Set(
    [...source.matchAll(/export (?:async )?function (\w+)/g)].map(m => m[1]),
  );
}

/** Chaque source du serveur, routes et services confondus. */
function sourcesServeur() {
  const fichiers = [];
  for (const dossier of ['routes', 'services']) {
    const base = path.join(racine, 'server', dossier);
    for (const nom of readdirSync(base).filter(n => n.endsWith('.ts'))) {
      fichiers.push([
        path.posix.join('server', dossier, nom),
        readFileSync(path.join(base, nom), 'utf8'),
      ]);
    }
  }
  return fichiers;
}

test('toute fonction de cloisonnement employee est importee', () => {
  const exportees = fonctionsExportees();
  assert.ok(exportees.size >= 8, `le module doit exposer ses fonctions (vu ${exportees.size})`);

  const manquants = [];
  for (const [nom, source] of sourcesServeur()) {
    if (nom.endsWith('portee-donnees.ts')) continue;

    // Ce que le fichier importe depuis le module de cloisonnement.
    const importe = new Set();
    for (const bloc of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*portee-donnees['"]/g)) {
      for (const morceau of bloc[1].split(',')) {
        const propre = morceau.trim().split(/\s+as\s+/)[0].trim();
        if (propre) importe.add(propre);
      }
    }

    // Ce qu'il APPELLE réellement. On vise l'appel, parenthèse comprise : une
    // simple mention en commentaire ne doit pas exiger un import.
    for (const fonction of exportees) {
      const appelle = new RegExp(`(?<![\\w.])${fonction}\\s*\\(`).test(source);
      if (appelle && !importe.has(fonction)) manquants.push(`${nom} → ${fonction}`);
    }
  }

  assert.deepEqual(manquants, [],
    'ces appels échoueraient À L’EXÉCUTION, en production, au premier chargement');
});

test('le module de cloisonnement expose bien les surfaces attendues', () => {
  // Si l'une disparaît, les appels correspondants tomberaient au démarrage.
  const exportees = fonctionsExportees();
  for (const attendue of [
    'porteeClients', 'porteeSousClient', 'porteeProfils', 'porteeJetonsEssai',
    'porteeDemandesEssai', 'porteeRevendeurs', 'porteeServeurs', 'porteeBons',
    'auteurAInscrire', 'gestionnaireAInscrire',
  ]) {
    assert.ok(exportees.has(attendue), `${attendue} doit rester exportée`);
  }
});
