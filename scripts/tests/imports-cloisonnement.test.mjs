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

/**
 * Les modules dont les fonctions doivent etre importees pour fonctionner.
 *
 * `portee-donnees` cloisonne les donnees par proprietaire ; `reseller-access`
 * pose les plafonds de role. Les deux subissent exactement le meme risque :
 * une fonction employee sans import ne tombe qu'a l'execution, en production.
 */
const MODULES = [
  { nom: 'portee-donnees', chemin: path.join(racine, 'server', 'services', 'portee-donnees.ts') },
  { nom: 'reseller-access', chemin: path.join(racine, 'server', 'services', 'reseller-access.ts') },
];

/** Les fonctions qu'un module expose. */
function fonctionsExportees(chemin = MODULES[0].chemin) {
  const source = readFileSync(chemin, 'utf8');
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
  const manquants = [];

  for (const module of MODULES) {
    const exportees = fonctionsExportees(module.chemin);
    assert.ok(exportees.size >= 2,
      `${module.nom} doit exposer ses fonctions (vu ${exportees.size})`);

    for (const [nom, source] of sourcesServeur()) {
      if (nom.endsWith(`${module.nom}.ts`)) continue;

      // Ce que le fichier importe depuis ce module.
      const importe = new Set();
      const motif = new RegExp(
        `import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${module.nom}['"]`, 'g');
      for (const bloc of source.matchAll(motif)) {
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
