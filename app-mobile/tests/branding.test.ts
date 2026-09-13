/**
 * branding.test.ts — Nom affiché et identité technique de l'application.
 *
 * Le produit s'appelle « SXB VPN » et signe « Powered by AbakoDollar$ ». Il a
 * porté un temps « Stuff x Bilal x Global Users » ; ce nom est revenu à SXB VPN
 * partout où un humain le lit — écran d'accueil de l'application, libellé sous
 * l'icône Android, tableau de bord, notifications.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CES GARDE-FOUS PROTÈGENT VRAIMENT
 * ═══════════════════════════════════════════════════════════════════════════
 * L'inverse du nom affiché : les identifiants lus par une MACHINE. Un
 * renommage se fait à la main dans des dizaines de fichiers, et rien ne
 * distingue à l'œil nu une chaîne décorative d'une chaîne dont dépend la
 * production. Or :
 *
 *  • renommer `expo.android.package` ferait une application DIFFÉRENTE pour
 *    Android — comptes, configurations et données perdus, et plus aucune mise
 *    à jour possible par-dessus l'existant ;
 *  • changer un préfixe de jeton invaliderait tous les codes déjà distribués ;
 *  • renommer une clé de stockage ou l'en-tête d'identification d'appareil
 *    ferait passer chaque compte existant pour absent ;
 *  • la phrase de confirmation de réinitialisation est COMPARÉE par le serveur :
 *    elle contient « SXB VPN » par coïncidence, pas parce que c'est le nom du
 *    produit. Elle ne suit donc aucun renommage.
 *
 * Ces valeurs sont épinglées ici précisément pour qu'un futur changement de nom
 * ne puisse pas les emporter au passage.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const depot = path.resolve(mobile, '..');
const lire = (chemin: string) => readFileSync(path.join(depot, chemin), 'utf8');
const NOM = 'SXB VPN';
/** Noms portés auparavant : aucun ne doit subsister dans une surface lue. */
const ANCIENS_NOMS = ['Stuff x Bilal x Global Users', 'Stuff x Bilal'];
const app = JSON.parse(lire('app-mobile/app.json')).expo;

describe('identité de marque', () => {
  it('affiche « SXB VPN » dans l’application et sous l’icône Android', () => {
    // Un seul et même nom partout : il tient sous une icône de lanceur, donc
    // rien n'oblige plus à maintenir une variante courte à côté d'une longue.
    assert.equal(app.name, NOM);
    for (const langue of ['fr', 'en']) {
      assert.match(lire(`app-mobile/localization/${langue}.ts`), new RegExp(`app_name: '${NOM}'`));
    }
  });

  it('signe « Powered by AbakoDollar$ » dans les deux langues, sans perdre l’attribution', () => {
    for (const langue of ['fr', 'en']) {
      assert.match(lire(`app-mobile/localization/${langue}.ts`), /created_by: 'Powered by AbakoDollar\$'/);
    }
    // L'attribution doit rester rendue : une clé traduite mais jamais affichée
    // équivaut à l'avoir supprimée.
    for (const ecran of ['app-mobile/app/settings.tsx', 'app-mobile/app/activate.tsx',
      'app-mobile/app/index.tsx', 'app-mobile/app/(tabs)/profile.tsx']) {
      assert.match(lire(ecran), /t\(["']created_by["']\)/, `${ecran} : attribution absente`);
    }
  });

  it('ne laisse AUCUN ancien nom dans une surface lue par un humain', () => {
    // Le premier écran vu au lancement — celui que l'utilisateur a signalé —
    // passe par app_name, vérifié ci-dessus. Ici on balaye tout le reste : un
    // renommage partiel laisse une application qui se contredit d'un écran à
    // l'autre.
    const surfaces = [
      'app-mobile/app.json',
      'app-mobile/localization/fr.ts', 'app-mobile/localization/en.ts',
      'artifacts/sxb-dashboard/index.html',
      'artifacts/sxb-dashboard/src/App.tsx',
      'artifacts/sxb-dashboard/src/components/Layout.tsx',
      'server/services/fcm.ts', 'server/routes/mobile.ts',
      'server/middleware/maintenance.ts',
    ];
    for (const langue of ['fr', 'en']) {
      for (const fichier of ['core', 'dashboard', 'operations', 'commerce', 'resellers', 'settings', 'technical']) {
        surfaces.push(`artifacts/sxb-dashboard/src/locales/${langue}/${fichier}.json`);
      }
    }
    for (const surface of surfaces) {
      const contenu = lire(surface);
      for (const ancien of ANCIENS_NOMS) {
        assert.ok(!contenu.includes(ancien), `${surface} : « ${ancien} » encore présent`);
      }
    }

    // Tableau de bord : onglet, en-tête, pied de page et panneau de contrôle
    // portent le nom courant — l'absence de l'ancien ne prouve pas la présence
    // du nouveau, une chaîne vide passerait le contrôle ci-dessus.
    assert.match(lire('artifacts/sxb-dashboard/index.html'), new RegExp(`<title>${NOM} Dashboard</title>`));
    for (const langue of ['fr', 'en']) {
      const core = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/core.json`));
      const operations = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`));
      assert.ok(core.login.footer.includes(NOM), `${langue} : pied de page`);
      assert.ok(core.logo.includes(NOM), `${langue} : texte du logo`);
      assert.ok(operations.maintenance.controlPanel.includes(NOM), `${langue} : panneau de contrôle`);
    }
    // Notification de mise à jour visible par l'utilisateur.
    assert.match(lire('server/services/fcm.ts'), new RegExp(`Mise à jour ${NOM} \\$\\{update.versionName\\}`));
    assert.ok(lire('server/routes/mobile.ts').includes(`Nouvelle version ${NOM} disponible`));
  });

  it('ne touche à AUCUN identifiant lu par une machine', () => {
    // Changer l'un de ces champs casserait la mise à jour de l'APK installé.
    assert.equal(app.android.package, 'com.sxbvpn.mobile');
    assert.equal(app.ios.bundleIdentifier, 'com.sxbvpn.mobile');
    assert.equal(app.slug, 'sxb-mobile');
    assert.equal(app.scheme, 'sxbvpn');

    // Les codes déjà distribués restent valides : préfixes intacts.
    assert.match(lire('app-mobile/contexts/AuthContext.tsx'), /startsWith\('SXB-DATA-'\)/);
    assert.match(lire('app-mobile/localization/fr.ts'), /token_user_placeholder: 'SXB-USER-XXXX-XXXX-XXXX'/);
    assert.match(lire('app-mobile/localization/fr.ts'), /token_data_placeholder: 'SXB-DATA-XXXX-XXXX-XXXX'/);

    // Clés de stockage et en-tête HTTP : renommées, les comptes existants
    // seraient considérés comme absents et les appareils non identifiés.
    assert.match(lire('app-mobile/contexts/AuthContext.tsx'), /'SXB' \+ Array\.from\(bytes/);
    assert.match(lire('app-mobile/services/apiClient.ts'), /'X-SXB-Device-ID'/);

    // Phrase de confirmation de réinitialisation : comparée par le serveur.
    assert.match(lire('server/services/application-reset.ts'), /RESET_CONFIRMATION_TEXT = "RESET SXB VPN"/);
    assert.match(lire('artifacts/sxb-dashboard/src/api/reset.ts'), /RESET_CONFIRMATION = "RESET SXB VPN"/);
  });
});
