/**
 * branding.test.ts — Nom affiché et identité technique de l'application.
 *
 * Le produit s'appelle désormais « Stuff x Bilal x Global Users » et signe
 * « Powered by AbakoDollar$ ». Ce renommage ne concerne QUE ce qu'un humain lit
 * dans l'interface.
 *
 * Ce que ces garde-fous protègent surtout, c'est l'inverse : les identifiants
 * lus par une machine. Renommer expo.android.package ferait une application
 * DIFFÉRENTE pour Android — comptes, configurations et données perdus, mise à
 * jour par-dessus l'existant impossible. Changer un préfixe de jeton
 * invaliderait tous les codes déjà distribués. Ces valeurs sont donc épinglées.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const depot = path.resolve(mobile, '..');
const lire = (chemin: string) => readFileSync(path.join(depot, chemin), 'utf8');
const NOM_COMPLET = 'Stuff x Bilal x Global Users';
const app = JSON.parse(lire('app-mobile/app.json')).expo;

describe('identité de marque', () => {
  it('affiche le nom complet dans l’application, et le nom court sous l’icône Android', () => {
    // Android tronque un nom long sous l'icône : le lanceur reçoit le nom court.
    assert.equal(app.name, 'Stuff x Bilal');
    for (const langue of ['fr', 'en']) {
      assert.match(lire(`app-mobile/localization/${langue}.ts`), new RegExp(`app_name: '${NOM_COMPLET}'`));
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

  it('ne laisse plus l’ancien nom de produit dans un écran lu par l’utilisateur', () => {
    const ecrans = ['app-mobile/app/activate.tsx', 'app-mobile/app/onboarding.tsx',
      'app-mobile/app/support.tsx', 'app-mobile/app/access-blocked.tsx',
      'app-mobile/app/diagnostics.tsx', 'app-mobile/app/(tabs)/profile.tsx',
      'app-mobile/app/(tabs)/history.tsx', 'app-mobile/app/(tabs)/notifications.tsx'];
    for (const ecran of ecrans) {
      assert.doesNotMatch(lire(ecran), />\s*SXB VPN\s*</, `${ecran} : ancien nom encore affiché`);
    }
    // Tableau de bord : onglet, en-tête, pied de page et panneau de contrôle.
    assert.match(lire('artifacts/sxb-dashboard/index.html'), new RegExp(`<title>${NOM_COMPLET} Dashboard</title>`));
    for (const langue of ['fr', 'en']) {
      const core = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/core.json`));
      const operations = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`));
      assert.ok(core.login.footer.includes(NOM_COMPLET), `${langue} : pied de page`);
      assert.ok(core.logo.includes(NOM_COMPLET), `${langue} : texte du logo`);
      assert.ok(operations.maintenance.controlPanel.includes(NOM_COMPLET), `${langue} : panneau de contrôle`);
    }
    // Notification de mise à jour visible par l'utilisateur.
    assert.match(lire('server/services/fcm.ts'), new RegExp(`Mise à jour ${NOM_COMPLET} \\$\\{update.versionName\\}`));
    assert.ok(lire('server/routes/mobile.ts').includes(`Nouvelle version ${NOM_COMPLET} disponible`));
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
