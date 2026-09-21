/**
 * Les protections affichées comme actives le sont-elles vraiment ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CES CONTRÔLES DÉFENDENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Quand l'utilisateur active le Kill Switch, l'application lui affirme :
 * « Toute connexion internet sera bloquée si le VPN se déconnecte. »
 *
 * C'est une promesse de sécurité, pas un réglage de confort. Elle n'est tenue
 * que si le service natif — qui tourne dans son propre processus — apprend le
 * changement. Les deux valeurs voyagent bien dans les options de `startVpn`,
 * donc régler AVANT de connecter a toujours marché. Le trou était ailleurs :
 * régler PENDANT une session ne prévenait personne.
 *
 * Deux conséquences, opposées et toutes deux fâcheuses :
 *
 *   - activer en cours de session laissait le tunnel sans protection, alors
 *     que l'interface annonçait le contraire ;
 *   - désactiver en cours de session laissait le « trou noir » en place, et
 *     l'utilisateur se retrouvait sans internet sans comprendre pourquoi.
 *
 * Ces contrôles lisent le code source plutôt que d'exécuter React : le pont
 * natif n'existe pas hors d'un appareil Android. Ils vérifient donc le
 * câblage — que l'appel existe, qu'il vise la bonne méthode, et que le
 * contexte n'expose plus un simple `useState` déguisé en réglage.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const racine = path.resolve(__dirname, '..');
const contexte = readFileSync(path.join(racine, 'contexts', 'VpnContext.tsx'), 'utf8');
const moduleNatif = readFileSync(
  path.join(racine, 'modules', 'android-native', 'SxbVpnModule.kt'),
  'utf8',
);
const serviceNatif = readFileSync(
  path.join(racine, 'modules', 'android-native', 'SxbVpnService.kt'),
  'utf8',
);

describe('kill switch — le réglage atteint le service en cours', () => {
  it('le contexte n’expose plus le setter d’état brut', () => {
    assert.doesNotMatch(
      contexte,
      /setKillSwitch:\s*setKillSwitchState/,
      'exposer setKillSwitchState revient à ne rien faire du réglage',
    );
    assert.doesNotMatch(
      contexte,
      /setAutoReconnect:\s*setAutoReconnectState/,
      'exposer setAutoReconnectState revient à ne rien faire du réglage',
    );
  });

  it('activer ou désactiver appelle la méthode native correspondante', () => {
    const debut = contexte.indexOf('const setKillSwitch = useCallback');
    assert.ok(debut > 0, 'setKillSwitch introuvable dans VpnContext');

    const corps = contexte.slice(debut, debut + 400);
    assert.ok(corps.includes('setKillSwitchState'), 'l’état local doit rester mis à jour');
    assert.ok(
      corps.includes("appliquerAuServiceNatif('setKillSwitch'"),
      'le réglage doit être transmis au service natif',
    );
  });

  it('la reconnexion automatique suit le même chemin', () => {
    const debut = contexte.indexOf('const setAutoReconnect = useCallback');
    assert.ok(debut > 0, 'setAutoReconnect introuvable dans VpnContext');

    const corps = contexte.slice(debut, debut + 400);
    assert.ok(corps.includes('setAutoReconnectState'), 'l’état local doit rester mis à jour');
    assert.ok(
      corps.includes("appliquerAuServiceNatif('setAutoReconnect'"),
      'le réglage doit être transmis au service natif',
    );
  });

  it('l’absence de pont natif ne fait pas échouer le réglage', () => {
    const debut = contexte.indexOf('const appliquerAuServiceNatif');
    assert.ok(debut > 0, 'appliquerAuServiceNatif introuvable');

    const corps = contexte.slice(debut, debut + 600);
    assert.ok(
      corps.includes('IS_ANDROID') && corps.includes("typeof SxbVpnNative"),
      'le pont doit être vérifié avant l’appel',
    );
    assert.ok(corps.includes('catch'), 'un pont indisponible ne doit pas remonter une exception');
  });

  it('les deux réglages restent transmis aussi au démarrage du tunnel', () => {
    // Le correctif complète le chemin existant, il ne le remplace pas :
    // une connexion neuve doit toujours partir avec les bonnes valeurs.
    const debut = contexte.indexOf('includeOwnApp');
    assert.ok(debut > 0, 'options de startVpn introuvables');

    const options = contexte.slice(Math.max(0, debut - 400), debut);
    assert.ok(options.includes('killSwitch'), 'killSwitch doit rester dans les options de startVpn');
    assert.ok(
      options.includes('autoReconnect'),
      'autoReconnect doit rester dans les options de startVpn',
    );
  });
});

describe('kill switch — les méthodes natives visées existent réellement', () => {
  /**
   * Un appel vers une méthode absente échouerait en silence : `NativeModules`
   * renvoie `undefined`, la garde `typeof … === 'function'` refuse l'appel, et
   * le réglage redeviendrait décoratif sans que rien ne le signale.
   */
  it('SxbVpnModule expose bien setKillSwitch et setAutoReconnect', () => {
    assert.match(
      moduleNatif,
      /@ReactMethod\s+fun setKillSwitch\(enabled: Boolean\)/,
      'setKillSwitch doit rester exposé au pont React Native',
    );
    assert.match(
      moduleNatif,
      /@ReactMethod\s+fun setAutoReconnect\(enabled: Boolean\)/,
      'setAutoReconnect doit rester exposé au pont React Native',
    );
  });

  it('ces méthodes agissent sur la session vivante, pas sur une copie', () => {
    const debut = moduleNatif.indexOf('fun setKillSwitch(enabled: Boolean)');
    const corps = moduleNatif.slice(debut, debut + 200);
    assert.ok(
      corps.includes('SxbVpnService.instance'),
      'le réglage doit viser le service en cours d’exécution',
    );
  });

  it('désactiver le kill switch retire le blocage au lieu de le laisser en place', () => {
    const debut = serviceNatif.indexOf('fun setKillSwitch(enabled: Boolean)');
    assert.ok(debut > 0, 'setKillSwitch introuvable dans SxbVpnService');

    const corps = serviceNatif.slice(debut, debut + 400);
    assert.ok(
      corps.includes('removeKillSwitchBlackhole'),
      'sans cela, couper le kill switch laisserait l’utilisateur sans internet',
    );
  });
});
