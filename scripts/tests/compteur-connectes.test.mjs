/**
 * Compteur « clients connectés » — ce qu'il compte, et ce qu'il annonce.
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * Deux défauts constatés en production, et les invariants qui les ferment.
 *
 *  1. La carte s'appelait « Connectés » sur un tableau de bord où l'exploitant
 *     est lui-même connecté. Il lisait « Connectés : 0 » juste après s'être
 *     authentifié et concluait à un compteur cassé. Elle compte en réalité les
 *     tunnels VPN ouverts par l'application mobile des CLIENTS.
 *
 *  2. La date du dernier signal ne lisait que le battement de santé, alors que
 *     la présence compte AUSSI la consommation remontée. Un parc qui avait
 *     consommé le jour même se voyait annoncer « aucun signal depuis six
 *     jours » : le compteur comptait le trafic, la date l'ignorait.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lireSource = (relatif) => readFileSync(path.join(racine, relatif), 'utf8');
const locale = (langue) => JSON.parse(lireSource(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`)).dashboard;

test('la date du dernier signal lit les deux sources de présence', () => {
  const presence = lireSource('server/services/vpn-presence.ts');
  const bloc = presence.slice(
    presence.indexOf('export async function dernierSignalPresence'),
    presence.indexOf('export async function compterConnectes'),
  );
  assert.ok(bloc.length > 0, 'la fonction doit exister');

  // Les deux sources qui alimentent la présence. En omettre une fait mentir la
  // date affichée sous le compteur.
  assert.match(bloc, /mobileHealthDevice\.findFirst/);
  assert.match(bloc, /trafficUsage\.findFirst/);
  // Le plus récent des deux fait foi.
  assert.match(bloc, /date > recent \? date : recent/);
  // Une source muette ne doit pas effacer l'autre.
  assert.equal((bloc.match(/catch \{/g) || []).length, 2, 'chaque lecture doit être isolée');
});

test('la présence compte bien le battement ET le trafic', () => {
  const presence = lireSource('server/services/vpn-presence.ts');
  // C'est ce qui rend la date à deux sources nécessaire : le compteur lui-même
  // accepte déjà les deux signaux.
  assert.match(presence, /completerParTrafic/);
  assert.match(presence, /async function lireSignauxTrafic/);
});

test('la carte dit de QUI elle parle', () => {
  for (const langue of ['fr', 'en']) {
    const textes = locale(langue);
    // Un libellé nu — « Connectés » — se lit comme « qui est connecté ici ».
    assert.ok(textes.connected, `${langue}: libellé manquant`);
    assert.notEqual(textes.connected.trim().toLowerCase(), 'connectés');
    assert.notEqual(textes.connected.trim().toLowerCase(), 'connected');
    // Et une explication lève le doute pour de bon.
    assert.ok(textes.connectedHelp?.length > 60, `${langue}: explication trop courte`);
  }
  // L'explication doit dire que la session du tableau de bord n'y figure pas :
  // c'est exactement la question posée par l'exploitant.
  assert.match(locale('fr').connectedHelp, /tableau de bord/);
  assert.match(locale('en').connectedHelp, /dashboard/);
});

test('la carte affiche son explication', () => {
  const vue = lireSource('artifacts/sxb-dashboard/src/components/DashboardView.tsx');
  assert.match(vue, /help=\{t\("operations\.dashboard\.connectedHelp"\)\}/);
  // Le support de l'explication existe dans la carte, sinon le texte serait
  // accepté puis silencieusement jeté.
  assert.match(vue, /help\?: string/);
  assert.match(vue, /title=\{help\}/);
});

test('aucun libellé de présence ne promet ce que la carte ne mesure pas', () => {
  for (const langue of ['fr', 'en']) {
    const textes = locale(langue);
    for (const cle of ['connectedSub', 'connectedLastSignal', 'connectedNoSignal', 'connectedUnmeasuredSub']) {
      assert.ok(textes[cle], `${langue}: ${cle} manquante`);
    }
    // Le sous-titre nomme le tunnel, pas une vague « présence ».
    assert.match(textes.connectedSub, /tunnel/i);
    assert.match(textes.connectedLastSignal, /tunnel/i);
  }
});
