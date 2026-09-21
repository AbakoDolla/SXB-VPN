/**
 * Le fichier d'attribution livré avec l'APK dit-il la vérité ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE CONTRÔLE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * `assets/engine/NOTICE.txt` est copié dans le paquet applicatif par le plugin
 * Expo. C'est le seul endroit où l'utilisateur final peut apprendre ce que son
 * téléphone exécute réellement et sous quelles conditions.
 *
 * Il documentait la base de domaines `geosite.db` (données MIT) et ne disait
 * rien de `libbox.so` — c'est-à-dire sing-box, sous GPL-3.0-or-later, bel et
 * bien empaqueté dans l'APK. L'obligation existait que le fichier la mentionne
 * ou non ; son silence en était simplement la part la plus facile à reprocher.
 *
 * Ces contrôles verrouillent l'attribution. Ils ne prétendent pas établir la
 * conformité complète : la mise à disposition des sources est une décision qui
 * n'appartient pas au code.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QU'ILS REFUSENT AUSSI
 * ═══════════════════════════════════════════════════════════════════════════
 * Un texte de licence approximatif vaut moins que pas de licence du tout : il
 * donne l'apparence de la conformité sans en avoir la substance. Les empreintes
 * ci-dessous figent les textes reproduits, relevés aux sources officielles :
 *
 *   - notice sing-box, tag v1.12.9 (791 octets)
 *   - GPL-3.0 canonique de gnu.org (35 149 octets), confirmée identique octet
 *     pour octet au fichier COPYING de GNU coreutils
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const racine = path.resolve(__dirname, '..');
const notice = readFileSync(path.join(racine, 'assets', 'engine', 'NOTICE.txt'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** Empreinte du texte GPL-3.0 tel que publié par la Free Software Foundation. */
const EMPREINTE_GPL3 =
  '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986';

/** La version de sing-box réellement compilée, lue dans le script de build. */
function versionSingBoxCompilee(): string {
  const script = readFileSync(path.join(racine, 'scripts', 'build-libbox.sh'), 'utf8');
  const trouve = script.match(/SING_BOX_VERSION="\$\{SING_BOX_VERSION:-v([\d.]+)\}"/);
  assert.ok(trouve, 'version de sing-box introuvable dans build-libbox.sh');
  return trouve[1];
}

/** Le commit dnstt réellement compilé, lu dans son script de build. */
function commitDnsttCompile(): string {
  const script = readFileSync(path.join(racine, 'scripts', 'build-dnstt.sh'), 'utf8');
  const trouve = script.match(/DNSTT_COMMIT="([0-9a-f]{40})"/);
  assert.ok(trouve, 'commit dnstt introuvable dans build-dnstt.sh');
  return trouve[1];
}

describe('NOTICE.txt — sing-box est déclaré', () => {
  it('le composant, sa source et sa licence sont nommés', () => {
    assert.ok(notice.includes('SagerNet/sing-box'), 'le composant n’est pas nommé');
    assert.ok(
      notice.includes('https://github.com/SagerNet/sing-box'),
      'la source amont n’est pas indiquée',
    );
    assert.ok(notice.includes('GPL-3.0-or-later'), 'la licence n’est pas indiquée');
  });

  it('la version déclarée est celle que le build compile réellement', () => {
    const version = versionSingBoxCompilee();
    assert.ok(
      notice.includes(version),
      `NOTICE annonce une autre version que celle compilée (${version})`,
    );
  });

  it('la clause de nom propre à sing-box est reproduite', () => {
    assert.ok(
      notice.includes(
        'no derivative work may use the name or imply association\nwith this application without prior consent',
      ),
      'la clause additionnelle du LICENSE amont manque',
    );
  });

  it('la notice amont est reproduite avec son détenteur de droits', () => {
    assert.ok(
      notice.includes('Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>'),
      'le détenteur des droits n’est pas nommé',
    );
  });
});

describe('NOTICE.txt — le texte de la GPL-3.0 est intact', () => {
  /**
   * Le contrôle décisif. Un texte de licence retapé, tronqué ou reformaté
   * donnerait l'apparence de la conformité sans en avoir la substance.
   */
  it('le texte reproduit est exactement celui de la FSF', () => {
    const debut = notice.indexOf('                    GNU GENERAL PUBLIC LICENSE');
    assert.ok(debut > 0, 'le texte intégral de la GPL-3.0 est absent');

    const texte = notice.slice(debut).trimEnd() + '\n';
    const empreinte = createHash('sha256').update(texte, 'utf8').digest('hex');
    assert.equal(
      empreinte,
      EMPREINTE_GPL3,
      'le texte de la GPL-3.0 a été modifié, tronqué ou reformaté',
    );
  });

  it('les clauses structurantes sont présentes', () => {
    for (const clause of [
      'Version 3, 29 June 2007',
      '0. Definitions.',
      '6. Conveying Non-Source Forms.',
      '15. Disclaimer of Warranty.',
      '17. Interpretation of Sections 15 and 16.',
    ]) {
      assert.ok(notice.includes(clause), `clause manquante : ${clause}`);
    }
  });
});

describe('NOTICE.txt — dnstt est attribué', () => {
  it('le composant et sa licence sont nommés', () => {
    assert.ok(notice.includes('Mygod/dnstt'), 'le composant n’est pas nommé');
    assert.ok(notice.includes('CC0 1.0'), 'la licence CC0 n’est pas indiquée');
  });

  it('le commit déclaré est celui que le build compile réellement', () => {
    assert.ok(
      notice.includes(commitDnsttCompile()),
      'NOTICE annonce un autre commit que celui compilé',
    );
  });
});

describe('NOTICE.txt — ce qui existait n’a pas été perdu', () => {
  it('l’attribution de la base de domaines est conservée', () => {
    // Le contrôle d'artefact Android vérifie cette ligne dans l'APK construit.
    assert.ok(
      notice.includes('Copyright (c) 2018-2019 V2Ray'),
      'l’attribution MIT de v2fly a disparu',
    );
    assert.ok(notice.includes('MIT License'), 'le texte MIT a disparu');
    assert.ok(notice.includes('SagerNet/sing-geosite'), 'la source de geosite.db a disparu');
  });

  it('l’empreinte de la base de domaines reste déclarée', () => {
    const donnees = readFileSync(path.join(racine, 'scripts', 'prepare-geosite.cjs'), 'utf8');
    const trouve = donnees.match(/([0-9a-f]{64})/);
    if (trouve) {
      assert.ok(
        notice.includes(trouve[1]),
        'l’empreinte déclarée ne correspond plus à celle du script',
      );
    }
  });

  it('le fichier reste en ASCII pur', () => {
    // Il est lu tel quel depuis l'APK ; un caractère accentué mal encodé y
    // apparaîtrait comme un artefact illisible.
    assert.doesNotMatch(notice, /[^\x00-\x7F]/, 'caractère non-ASCII dans NOTICE.txt');
  });
});

describe('NOTICE.txt — aucun engagement qui ne nous appartienne', () => {
  /**
   * Déclarer une licence est un constat. Promettre la publication des sources
   * est une décision commerciale, qui n'est pas celle du code.
   */
  it('aucune promesse de publication n’est ajoutée hors du texte de licence', () => {
    const debutGpl = notice.indexOf('                    GNU GENERAL PUBLIC LICENSE');
    assert.ok(debutGpl > 0, 'texte GPL introuvable');

    // Le corps de la GPL parle lui-même d'« offre écrite » : seul ce qui
    // précède est de notre fait.
    const avantLaLicence = notice.slice(0, debutGpl);
    assert.doesNotMatch(
      avantLaLicence,
      /written offer|upon request|sources? (is|are|will be) (available|provided|published)/i,
      'le fichier engage une mise à disposition que personne n’a décidée',
    );
  });
});
