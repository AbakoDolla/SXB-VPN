import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────────
// QUI PAIE LE BON N'EST PAS QUI L'ÉMET
//
// MESURÉ EN PRODUCTION, avec deux administrateurs créés à l'instant :
//
//   POST /api/vouchers { resellerId: <revendeur de l'admin A> }
//   avec le jeton de l'administrateur B            →  HTTP 201
//
// Le bon était créé, et `executerMutationQuota` ponctionnait l'enveloppe du
// revendeur de A. B dépensait le quota d'un autre exploitant. La LECTURE des
// bons était déjà cloisonnée : B ne revoyait donc jamais ce qu'il venait de
// faire, et A ne voyait qu'un quota qui fond. Une fuite invisible à l'écran,
// et pourtant financière — la pire des deux catégories.
//
// Le contrôle en place, `canSeeUser`, statue sur la visibilité d'un COMPTE,
// pas sur la propriété d'une FICHE revendeur. Les deux notions avaient été
// confondues.
// ─────────────────────────────────────────────────────────────────────────────

describe('vouchers — l’enveloppe qui finance appartient au requérant', () => {
  const route = source('server/routes/vouchers.ts');

  it('la fiche est chargée SOUS la portée, pas par son seul identifiant', () => {
    assert.match(
      route,
      /reseller\.findFirst\(\{\s*where: etFiltres\(\{ id: requestedResellerId \}, porteeDesRevendeurs\)/,
      'la fiche du revendeur doit entrer dans la requête avec la portée',
    );
    // La forme d'origine : un identifiant suffisait.
    assert.doesNotMatch(
      route,
      /reseller\.findUnique\(\{\s*where: \{ id: requestedResellerId \}/,
      'charger la fiche par son seul identifiant rouvre la ponction de quota',
    );
  });

  it('n’applique la restriction qu’aux rôles cloisonnés', () => {
    // `porteeRevendeurs` ferme aussi les fiches du propriétaire au
    // SUPER_ADMIN. C'est la règle générale de lecture, mais l'appliquer ici
    // retirerait au super-administrateur un pouvoir qu'il exerce aujourd'hui.
    // On ferme la fuite mesurée, rien de plus.
    assert.match(
      route,
      /const porteeDesRevendeurs = estCloisonne\(req\.user\?\.role\)\s*\n?\s*\? await porteeRevendeurs\(prisma, req\.user\)\s*\n?\s*: null/,
      'seul un rôle cloisonné doit être restreint, pour ne rien retirer au super-administrateur',
    );
  });

  it('importe ce qu’il emploie', () => {
    // Le `tsconfig` racine ne couvre pas `server/` et esbuild ne vérifie pas
    // les types : une fonction employée sans import ne tomberait QU'EN
    // PRODUCTION, au premier voucher émis.
    assert.match(route, /porteeRevendeurs/);
    assert.match(route, /estCloisonne/);
    assert.match(route, /import \{ etFiltres \} from "\.\.\/services\/free-trial-marks"/);
    const ligneImport = route.split('\n').find((l) => l.includes('from "../services/portee-donnees"'));
    assert.ok(ligneImport, 'la ligne d’import de la portée doit exister');
    for (const nom of ['porteeRevendeurs', 'estCloisonne', 'porteeBons', 'auteurAInscrire']) {
      assert.ok(ligneImport.includes(nom), `${nom} doit être importé depuis le point unique`);
    }
  });

  it('le refus emprunte le même code que le revendeur inexistant', () => {
    // Un code distinct révélerait que la fiche existe, et donc qu'un autre
    // exploitant détient ce revendeur.
    const bloc = route.slice(route.indexOf('const porteeDesRevendeurs'));
    const fin = bloc.indexOf('return accessError');
    assert.match(
      bloc.slice(0, fin > 0 ? fin : 1200),
      /status: 404,\s*\n?\s*body: \{ error: "errors\.resellers\.not_found"/,
      'hors périmètre, la réponse doit être celle d’un revendeur introuvable',
    );
  });
});
