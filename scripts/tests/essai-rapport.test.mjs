/**
 * essai-rapport.test.mjs — Le compte rendu d'une gestion d'essais dit la vérité.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI EST ARRIVÉ
 * ═══════════════════════════════════════════════════════════════════════════
 * L'exploitant a géré vingt-cinq essais. Le résumé annonçait « 22 traités ·
 * 22 forfaits modifiés · 3 échecs » — et juste en dessous, VINGT-CINQ lignes
 * rouges, toutes marquées « Échec ». Il en a conclu que rien ne marchait.
 *
 * Rien n'avait échoué. Le serveur renvoie l'état `ok` pour une réussite ;
 * l'écran, lui, cherchait `updated`. Aucune ligne ne correspondait, donc
 * TOUTES étaient affichées, et le libellé de repli était « Échec ». Une
 * opération réussie à 88 % se lisait comme un désastre complet.
 *
 * Deux règles en découlent, et ce fichier les tient :
 *  • les états affichés viennent de ceux que le SERVEUR émet, jamais d'une
 *    liste écrite à côté ;
 *  • le MOTIF prime sur l'état — « Échec » seul ne laisse rien à corriger.
 *
 * Exécution : npx tsx --test scripts/tests/essai-rapport.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const lire = (relatif) => readFileSync(path.join(ROOT, relatif), 'utf8');

const ROUTE = lire('server/routes/free-trial.ts');
const VUE = lire('artifacts/sxb-dashboard/src/components/FreeTrialView.tsx');

describe('compte rendu de gestion des essais', () => {
  it('affiche un libellé pour CHAQUE état que le serveur émet', () => {
    // Les états émis par la route de gestion groupée, lus dans le code plutôt
    // que recopiés : une liste recopiée se périme en silence, et c'est
    // exactement ce qui a produit la panne. L'ancre est une chaîne d'une seule
    // ligne — le disque est en CRLF ici et en LF en intégration, et un motif
    // multi-ligne passerait d'un côté pour échouer de l'autre.
    const debut = ROUTE.indexOf("'/requests/manage'");
    assert.ok(debut > 0, 'la route de gestion doit exister');
    const gestion = ROUTE.slice(debut);
    const emis = new Set(
      [...gestion.matchAll(/resultats\.push\(\{[\s\S]{0,200}?status:\s*'([a-z]+)'/g)].map(m => m[1]),
    );
    // La forme conditionnelle `status: echec ? 'partial' : 'ok'` n'est pas
    // couverte par le motif ci-dessus : on l'ajoute explicitement.
    for (const m of gestion.matchAll(/status:\s*\w+\s*\?\s*'([a-z]+)'\s*:\s*'([a-z]+)'/g)) {
      emis.add(m[1]); emis.add(m[2]);
    }
    assert.ok(emis.has('ok'), 'la réussite est bien « ok »');
    assert.ok(emis.size >= 3, `états attendus, vus : ${[...emis].join(', ')}`);

    const table = VUE.slice(VUE.indexOf('const MANAGE_RESULT_LABELS'));
    const connus = new Set([...table.slice(0, table.indexOf('};')).matchAll(/^\s*(\w+):/gm)].map(m => m[1]));
    for (const etat of emis) {
      assert.ok(connus.has(etat), `état « ${etat} » sans libellé — il s’affichera comme un échec`);
    }
  });

  it('ne signale QUE ce qui n’a pas entièrement abouti', () => {
    // Filtrer sur autre chose que `ok` remettrait chaque réussite dans la
    // liste rouge — le défaut d'origine, mot pour mot.
    assert.match(VUE, /resultatGestion\.results\.filter\(item => item\.status !== 'ok'\)/);
    assert.ok(
      !VUE.includes("results.filter(item => item.status !== 'updated')"),
      'le filtre ne doit plus viser un état que le serveur n’émet pas',
    );
  });

  it('montre le MOTIF rendu par le serveur, pas seulement l’état', () => {
    // « Échec » sans motif ne laisse rien à corriger à l'exploitant.
    assert.match(VUE, /reason: item\.reason\s*\n\s*\?\s*t\(item\.reason, \{ defaultValue: item\.reason \}\)/);
  });

  it('conserve le motif d’un échec partiel au lieu de le jeter', () => {
    // Avant : modifier le volume ET ajouter un serveur, la modification passe,
    // l'ajout échoue — et l'écran annonçait « ok ». L'exploitant voyait
    // « 0 forfait créé » sans une ligne pour dire pourquoi.
    assert.match(ROUTE, /status:\s*echec \? 'partial' : 'ok'/);
    assert.match(ROUTE, /\.\.\.\(echec \? \{ reason: echec \} : \{\}\)/);
  });

  it('ne fait jamais sortir un message d’exception vers le tableau de bord', () => {
    // Un message d'exception porte l'adresse, le port, parfois la requête
    // entière. Le recopier dans une réponse affichée ferait sortir de la
    // configuration technique par une porte dérobée — ce que le cloisonnement
    // des rôles interdit. Seul un code déjà normalisé passe.
    assert.match(ROUTE, /function motifSurEssai\(erreur: any, repli: string\): string/);
    const gestion = ROUTE.slice(ROUTE.indexOf("'/requests/manage'"));
    assert.ok(
      !/echec\s*=\s*\w+\?\.message/.test(gestion),
      'le motif exposé ne doit jamais être le message brut de l’exception',
    );
    // Le détail, lui, reste au journal du serveur : il sert au diagnostic.
    assert.match(gestion, /console\.error\('free-trial (manage|assign) error:'/);
  });

  it('propose le libellé « partiel » dans les deux langues', () => {
    for (const langue of ['en', 'fr']) {
      const libelles = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`));
      const bloc = libelles.freeTrial.manageResult;
      assert.ok(bloc.partial, `libellé « partial » manquant en ${langue}`);
      assert.notEqual(bloc.partial, bloc.failed, 'un succès partiel ne se lit pas comme un échec');
    }
  });
});
