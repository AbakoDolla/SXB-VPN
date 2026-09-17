/**
 * montee-moteur.test.ts — La montée du moteur est cohérente et complète.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI EST EN JEU
 * ═══════════════════════════════════════════════════════════════════════════
 * Le moteur passe de sing-box 1.11 à 1.14. Entre les deux, sing-box a
 * SUPPRIMÉ — et non simplement déprécié — des options que SXB écrit dans
 * chaque configuration :
 *
 *  • l'outbound `{"type":"dns"}`, supprimé en 1.13 ;
 *  • les champs `sniff` / `sniff_override_destination` d'un inbound, en 1.13 ;
 *  • le format de serveur DNS `{"address": …}`, supprimé en 1.14 ;
 *  • le bloc `dns.fakeip`, supprimé en 1.14.
 *
 * Une configuration qui en contient une seule est refusée EN BLOC. Le risque
 * n'est donc pas une dégradation : c'est un parc entier qui ne se connecte
 * plus, y compris les profils déjà provisionnés sur des téléphones que
 * personne ne peut corriger après coup.
 *
 * Ces contrôles vérifient ce qu'aucun test de logique ne voit : que la
 * traduction est branchée là où TOUT passe, et que la version visée est la
 * même partout — un seul épinglage oublié et la CI compile un moteur pendant
 * que le code en vise un autre.
 *
 * La traduction elle-même est prouvée ailleurs, deux fois :
 *  • `app-mobile/tests/StabilityPolicyTest.kt` exécute le VRAI code Kotlin ;
 *  • `scripts/run-android-policy-gates.sh` fait valider sa sortie par le VRAI
 *    moteur (`libbox.CheckConfig`), puis par un binaire sing-box réel.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const racine = path.resolve(__dirname, '..', '..');
const lire = (relatif: string) => readFileSync(path.join(racine, relatif), 'utf8');

const VERSION = '1.14.1';

describe('montée du moteur — version épinglée', () => {
  it('vise la même version partout', () => {
    // Un seul épinglage oublié et la CI compile un moteur pendant que le code
    // en vise un autre. Le défaut ne se verrait qu'à l'exécution, sur le
    // téléphone de l'utilisateur.
    const emplacements: [string, RegExp][] = [
      ['app-mobile/scripts/build-libbox.sh', new RegExp(`SING_BOX_VERSION:-v${VERSION}`)],
      ['app-mobile/modules/android-native/SxbEngineSchema.kt', new RegExp(`ENGINE_VERSION = "${VERSION}"`)],
      ['scripts/tests/singbox-engine-check/go.mod', new RegExp(`sing-box v${VERSION}`)],
      ['scripts/tests/singbox-engine-check/main.go', new RegExp(`v${VERSION}`)],
      ['scripts/tests/xray-runtime-fixture.mjs', new RegExp(`SING_BOX_VERSION = '${VERSION}'`)],
    ];
    for (const [fichier, motif] of emplacements) {
      assert.match(lire(fichier), motif, `version absente ou différente : ${fichier}`);
    }
  });

  it('ne laisse aucune trace de l’ancien moteur', () => {
    for (const fichier of [
      'app-mobile/scripts/build-libbox.sh',
      'scripts/tests/singbox-engine-check/go.mod',
      'scripts/tests/singbox-engine-check/main.go',
      'scripts/tests/xray-runtime-fixture.mjs',
      'scripts/tests/xray-translate.test.mjs',
      'app-mobile/ci-patches/0001-build-android-libbox.patch',
    ]) {
      assert.ok(!lire(fichier).includes('1.11.15'), `épinglage oublié dans ${fichier}`);
    }
  });

  it('fournit le Go qu’exige ce moteur', () => {
    // sing-box 1.14 déclare `go 1.25`. Un runner en 1.24 échoue à la
    // résolution des modules, avant même de compiler quoi que ce soit.
    for (const flux of ['.github/workflows/build-android.yml', '.github/workflows/build-google-play.yml']) {
      const source = lire(flux);
      assert.match(source, /go-version: "1\.25\.x"/, `Go trop ancien dans ${flux}`);
      assert.ok(!source.includes('go-version: "1.24.x"'), `Go 1.24 subsiste dans ${flux}`);
    }
    assert.match(lire('scripts/tests/singbox-engine-check/go.mod'), /^go 1\.25/m);
  });
});

describe('la traduction est branchée là où TOUT passe', () => {
  const service = lire('app-mobile/modules/android-native/SxbVpnService.kt');

  it('s’applique à la frontière du moteur, pas dans les générateurs', () => {
    // SXB produit des configurations à plusieurs endroits et en reçoit d'autres
    // déjà écrites — sing-box importé, Xray traduit, profils provisionnés il y a
    // des semaines. Corriger les générateurs laisserait ces derniers de côté,
    // c'est-à-dire précisément ceux qu'on ne peut plus réparer.
    const debut = service.indexOf('private fun startLibboxService(');
    assert.ok(debut > 0, 'la frontière du moteur doit exister');
    const frontiere = service.slice(debut, debut + 3000);
    assert.match(frontiere, /SxbEngineSchema\.moderniser\(JSONObject\(configJson\)\)/);
    // Et c'est bien la version TRADUITE qui est remise au moteur.
    assert.match(frontiere, /Libbox\.newService\(configModerne, this\)/);
    assert.ok(
      !/Libbox\.newService\(configJson\b/.test(frontiere),
      'la configuration d’origine ne doit jamais atteindre le moteur',
    );
  });

  it('n’est jamais le seul point de passage contourné', () => {
    // Trois chemins démarrent un tunnel. Tous doivent emprunter la frontière,
    // sans quoi la traduction ne couvrirait qu'une partie du parc.
    const appels = service.match(/startLibboxService\(/g) ?? [];
    assert.ok(appels.length >= 4, `chemins attendus vers la frontière (vu : ${appels.length})`);

    // Et le moteur n'est instancié qu'à UN seul endroit. Un second appel
    // ailleurs contournerait la traduction en silence. Le contrôle porte sur le
    // code, pas sur la prose qui le documente.
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
    const instanciations = code.match(/Libbox\.newService\(/g) ?? [];
    assert.equal(instanciations.length, 1, 'le moteur ne doit être instancié qu’à la frontière');
  });

  it('ne fait jamais échouer une connexion pour un défaut de traduction', () => {
    // Une configuration illisible ici le serait tout autant plus bas : c'est au
    // moteur de produire le diagnostic, qui est le sien. La traduction ne doit
    // pas s'interposer entre l'utilisateur et cette explication.
    const debut = service.indexOf('private fun startLibboxService(');
    const frontiere = service.slice(debut, debut + 3000);
    assert.match(frontiere, /runCatching \{[\s\S]{0,200}SxbEngineSchema\.moderniser/);
    assert.match(frontiere, /\.getOrElse \{/);
  });
});

describe('le harnais prouve le chemin réel, pas une approximation', () => {
  it('fait valider la sortie TRADUITE par le vrai moteur', () => {
    const fixture = lire('scripts/tests/xray-runtime-fixture.mjs');
    // Vérifier la sortie du seul générateur prouverait quelque chose que
    // l'application n'exécute jamais : elle traduit toujours avant de démarrer.
    assert.match(fixture, /SxbEngineSchema\.moderniser\(JSONObject\(buildRawSingBoxConfig\(config\)\)\)/);
    assert.match(fixture, /import com\.sxbvpn\.vpnmodule\.SxbEngineSchema/);

    const portes = lire('scripts/run-android-policy-gates.sh');
    assert.match(portes, /modules\/android-native\/SxbEngineSchema\.kt/);
    // Et la sortie passe bien devant le moteur réel.
    assert.match(portes, /singbox-engine-check run/);
  });

  it('exécute les preuves Kotlin du module', () => {
    const harnais = lire('app-mobile/tests/run-stability-policy.cjs');
    assert.match(harnais, /SxbEngineSchema\.kt/);
    const preuves = lire('app-mobile/tests/StabilityPolicyTest.kt');
    for (const attendu of [
      "l'outbound dns, supprimé en 1.13, devient une action de route",
      'le format de serveur DNS supprimé en 1.14 devient sa forme typée',
      'une configuration déjà au format courant ressort inchangée',
      "rien de ce qui fait joindre le serveur n'est touché",
      'les références pendantes sont supprimées, jamais laissées derrière',
    ]) {
      assert.ok(preuves.includes(attendu), `preuve Kotlin manquante : ${attendu}`);
    }
  });
});

describe('le module de traduction reste pur', () => {
  const schema = lire('app-mobile/modules/android-native/SxbEngineSchema.kt');

  it('n’a aucune dépendance Android', () => {
    // Le harnais de test le compile hors d'Android. Une seule importation
    // `android.*` et il cesse d'être vérifiable ailleurs que sur un appareil.
    assert.ok(!/^import android\./m.test(schema), 'aucune importation Android');
    assert.ok(!/Context|SharedPreferences|Log\./.test(schema), 'aucun type Android');
    assert.match(schema, /^import org\.json\.JSONObject$/m);
  });

  it('ne touche jamais à ce qui fait joindre le serveur', () => {
    // La traduction porte sur la FORME. Écrire une adresse, un nom TLS, un
    // en-tête Host ou un identifiant ici casserait silencieusement un profil
    // qui fonctionne — la panne la plus difficile à diagnostiquer qui soit.
    const code = schema.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const interdit of [
      'server_name', '"uuid"', '"password"', '"flow"', '"tls"', '"transport"', 'utls', 'fingerprint',
    ]) {
      assert.ok(!code.includes(interdit), `le module ne doit jamais écrire ${interdit}`);
    }
  });
});
