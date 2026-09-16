/**
 * Distribution des mises à jour — à QUI, avec quelle preuve, et sous quelle
 * contrainte.
 *
 * TROIS DÉFAUTS OBSERVÉS SUR L'APPAREIL DU PROPRIÉTAIRE
 * ────────────────────────────────────────────────────
 *  1. La notification « Nouvelle version SXB VPN disponible » restait affichée
 *     APRÈS l'installation. Le serveur ne connaissait pas la version installée :
 *     il annonçait la publication à tous les appareils activés, et rien ne
 *     pouvait plus la faire disparaître.
 *
 *  2. Le bouton « Télécharger » de l'onglet Alertes n'affichait aucune
 *     progression. Sur une archive de 62 Mo, l'écran restait figé plusieurs
 *     minutes sans distinguer un téléchargement d'un blocage.
 *
 *  3. « Mise à jour obligatoire » était publiable depuis le tableau de bord
 *     mais n'imposait rien : la fenêtre se refermait comme une autre.
 *
 * CE QUI NE DOIT PAS ARRIVER : couper le tunnel pour forcer une mise à jour.
 * Le VPN vit dans le service natif de premier plan ; la fenêtre bloquante ne
 * doit jamais le toucher.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const racine = path.resolve(mobile, '..');
const lire = (relatif: string) => readFileSync(path.join(racine, relatif), 'utf8');

describe('mise à jour — ciblage par version réellement installée', () => {
  it('fait déclarer sa version par l’application, sur chaque requête', () => {
    const client = lire('app-mobile/services/apiClient.ts');
    // Le numéro de build est lu UNE fois : une installation redémarre le
    // processus, il ne peut pas changer en cours d'exécution.
    assert.match(client, /export const INSTALLED_VERSION_CODE = \(\(\) => \{/);
    assert.match(client, /Number\.isSafeInteger\(value\) && value > 0 \? value : 0/);
    assert.match(client, /config\.headers\['X-SXB-App-Version-Code'\] = String\(INSTALLED_VERSION_CODE\)/);
    // Une version inconnue n'envoie RIEN plutôt qu'un zéro qui se lirait
    // « version 0 » et rendrait tout appareil éligible à tout.
    assert.match(client, /INSTALLED_VERSION_CODE > 0/);
  });

  it('n’annonce plus une version que l’appareil porte déjà', () => {
    const service = lire('server/services/app-update.ts');
    assert.match(service, /installedVersionCode: number = 0/);
    assert.match(
      service,
      /if \(Number\.isSafeInteger\(installedVersionCode\) && installedVersionCode >= update\.versionCode\) return null/,
      'un appareil à jour doit cesser de recevoir la notification',
    );
    // Version inconnue = ancien comportement : mieux vaut une notification de
    // trop qu'un appareil resté en arrière sans jamais le savoir.
    assert.match(service, /export function installedVersionCodeFromHeaders/);
    assert.match(service, /x-sxb-app-version-code/);

    // Les DEUX chemins qui exposent la mise à jour doivent filtrer pareil :
    // la liste des notifications et la vérification de version.
    const routes = lire('server/routes/mobile.ts');
    const appels = routes.match(/getMobileAppUpdate\([^)]*\)/g) || [];
    assert.equal(appels.length, 2, 'exactement deux chemins exposent la mise à jour');
    for (const appel of appels) {
      assert.match(appel, /installedVersionCodeFromHeaders\(req\.headers as any\)/, `filtre manquant : ${appel}`);
    }
  });

  it('conserve le ciblage explicite par appareil, en plus du filtre de version', () => {
    const service = lire('server/services/app-update.ts');
    // Les deux règles se cumulent : un appareil non ciblé ne reçoit rien, et
    // un appareil ciblé mais déjà à jour non plus.
    assert.match(service, /update\.targetDeviceIds\.length > 0 && !update\.targetDeviceIds\.includes\(deviceId\.trim\(\)\)/);
    assert.match(service, /return \(await isActivatedDevice\(deviceId\)\) \? update : null/);
  });
});

describe('mise à jour — progression visible pendant le téléchargement', () => {
  it('affiche une barre et un pourcentage dans l’onglet des alertes', () => {
    const alertes = lire('app-mobile/app/(tabs)/notifications.tsx');
    // La progression vient du téléchargement réel, pas d'une animation.
    assert.match(alertes, /downloadAndInstallAppUpdate\([\s\S]{0,600}\}, setProgress, \(\) => setInstalling\(true\)\)/);
    assert.match(alertes, /<ProgressBar[\s\S]{0,120}progress=\{progress\}/);
    assert.match(alertes, /update_downloading_pct'\)\.replace\('\{pct\}', String\(Math\.round\(progress \* 100\)\)\)/);
    // L'installation est une étape distincte : le téléchargement est fini,
    // l'utilisateur doit confirmer dans l'installeur système.
    assert.match(alertes, /installing[\s\S]{0,60}update_install_prompt/);
  });

  it('remonte la progression depuis le vrai téléchargement', () => {
    const service = lire('app-mobile/services/appUpdate.ts');
    assert.match(service, /onProgress\?\.\(Math\.min\(1, \(event\.totalBytesWritten \|\| 0\) \/ total\)\)/);
    // L'intégrité reste vérifiée avant de confier l'archive à l'installeur.
    assert.match(service, /throw new Error\('integrity_mismatch'\)/);
  });
});

describe('mise à jour obligatoire — bloquante, mais jamais au prix du tunnel', () => {
  const invite = lire('app-mobile/components/UpdatePrompt.tsx');

  it('ne se referme pas tant que la version imposée n’est pas installée', () => {
    assert.match(invite, /const blocking = remote\?\.forceUpdate === true && remote\.versionCode > installedVc/);
    // Trois sorties existaient : le bouton « Plus tard », le retour Android,
    // et le « Plus tard » mémorisé qui empêchait de reproposer la version.
    assert.match(invite, /if \(blocking\) return;/, 'le rejet doit être refusé');
    assert.match(invite, /onRequestClose=\{\(\) => \{ if \(!downloading && !blocking\) onDismiss\(\); \}\}/);
    assert.match(invite, /latest\.forceUpdate !== true\) return;/, 'un rejet passé ne doit pas masquer une mise à jour imposée');
    assert.match(invite, /\{!blocking && \(/, 'le bouton « Plus tard » disparaît');
  });

  it('ne touche jamais au tunnel et le dit à l’utilisateur', () => {
    // La fenêtre ne doit appeler AUCUNE commande de tunnel : bloquer l'accès
    // au moment où la personne en a le plus besoin serait le pire arbitrage.
    assert.doesNotMatch(invite, /stopVpn|disconnect\(|stopForAccess/);
    assert.match(invite, /update_required_vpn_note/);
    for (const langue of ['fr', 'en']) {
      const textes = lire(`app-mobile/localization/${langue}.ts`);
      for (const cle of ['update_required_title', 'update_required_body', 'update_required_vpn_note']) {
        assert.match(textes, new RegExp(`\\b${cle}:`), `${langue} : ${cle} manquante`);
      }
    }
  });

  it('reste pilotée depuis le tableau de bord, sans valeur inventée côté mobile', () => {
    // `forceUpdate` traverse la publication, la réponse mobile et le client.
    assert.match(lire('server/routes/app-updates.ts'), /forceUpdate: z\.boolean\(\)\.default\(false\)/);
    assert.match(lire('server/services/app-update.ts'), /forceUpdate: update\.forceUpdate/);
    assert.match(lire('app-mobile/services/appUpdate.ts'), /forceUpdate: item\.forceUpdate === true/);
  });
});

describe('diagnostic VPN — retiré, y compris son déverrouillage', () => {
  it('ne laisse ni écran, ni réglage, ni pont, ni interrupteur natif', () => {
    const reglages = lire('app-mobile/app/settings.tsx');
    // Le mot peut rester dans un commentaire d'historique ; ce qui ne doit
    // plus exister, c'est une route, un appel ou un réglage.
    assert.doesNotMatch(reglages, /router\.push\("\/diagnostics"\)|DiagnosticLogging|t\('diagnostic_/,
      'les réglages ne doivent plus y mener');
    assert.doesNotMatch(lire('app-mobile/app/(tabs)/index.tsx'), /\/diagnostics/, 'l’accueil ne doit plus y mener');
    assert.doesNotMatch(lire('app-mobile/modules/expo-sxb-vpn/src/index.ts'), /DiagnosticLogging/);
    assert.doesNotMatch(lire('app-mobile/modules/android-native/SxbVpnModule.kt'), /fun (set|get)DiagnosticLogging/);
    // Le masquage n'a plus d'interrupteur sur une version publiée.
    assert.match(
      lire('app-mobile/modules/android-native/SxbSecureLogger.kt'),
      /fun isDiagnosticEnabled\(\): Boolean = BuildConfig\.DEBUG && policyAllowsDiagnostics/,
    );
  });
});
