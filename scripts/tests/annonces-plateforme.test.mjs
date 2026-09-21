import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('annonces — publier est un acte de plateforme, pas d’exploitant', () => {
  it("n'admet plus les ADMIN parmi les publicateurs", () => {
    const route = source('server/routes/announcements.ts');

    // MESURÉ EN PRODUCTION AVANT CORRECTION, sur un administrateur au parc vide :
    //   POST   /api/announcements           -> 201 (il publiait à TOUTE la plateforme)
    //   PATCH  /api/announcements/<id-proprio> -> 422 (il franchissait le contrôle ;
    //          seule la validation du titre l'a arrêté, pas un refus d'accès)
    //
    // La liste est un réglage global unique, sans propriétaire : `PATCH` et
    // `DELETE` n'ont AUCUNE propriété à vérifier. Le seul verrou possible est
    // donc le rôle.
    assert.match(route, /const PUBLISHER_ROLES = new Set\(\['OWNER', 'SUPER_ADMIN', 'SUPPORT'\]\)/);
    assert.doesNotMatch(route, /PUBLISHER_ROLES = new Set\(\[[^\]]*'ADMIN'/);

    // Les trois écritures restent gardées par ce même verrou.
    const ecritures = route.match(/if \(!isPublisher\(req\)\) return res\.status\(403\)/g) || [];
    assert.equal(ecritures.length, 3, 'POST, PATCH et DELETE doivent tous vérifier isPublisher');
  });

  it('laisse la LECTURE ouverte : une annonce de plateforme est faite pour être diffusée', () => {
    const route = source('server/routes/announcements.ts');
    // `requireAuth` seul, sans restriction de rôle : les applications mobiles
    // et tous les exploitants doivent pouvoir lire l'annonce du propriétaire.
    assert.match(route, /router\.get\('\/', requireAuth, async/);
  });

  it('ferme aussi la vue et le menu, pas seulement la route', () => {
    const app = source('artifacts/sxb-dashboard/src/App.tsx');
    const layout = source('artifacts/sxb-dashboard/src/components/Layout.tsx');

    // Deuxième barrière : la navigation directe ne doit pas ouvrir l'écran.
    assert.match(
      app,
      /case 'announcements':[\s\S]{0,600}role !== UserRole\.OWNER && role !== UserRole\.SUPER_ADMIN && role !== UserRole\.SUPPORT/,
    );
    // Troisième barrière : l'entrée disparaît du menu de l'administrateur.
    assert.match(layout, /id: 'announcements'[\s\S]{0,160}roles: \['OWNER', 'SUPER_ADMIN', 'SUPPORT'\]/);
    assert.doesNotMatch(layout, /id: 'announcements'[\s\S]{0,160}roles: STAFF/);
  });

  it("la diffusion sans appareil cible touche toute la plateforme — d'où la réserve", () => {
    const fcm = source('server/services/fcm.ts');
    // C'est CE comportement qui rend la publication si sensible : sans
    // `targetDeviceId`, aucun filtre `deviceId` n'est appliqué et tous les
    // jetons actifs sont notifiés. Si un jour la diffusion devient cloisonnée,
    // ce test tombera et la réserve ci-dessus pourra être rediscutée.
    assert.match(fcm, /uniqueDeviceIds\.length > 0 \? \{ deviceId: \{ in: uniqueDeviceIds \} \} : \{\}/);
  });

  it('les mises à jour de l’app restent réservées au sommet', () => {
    const route = source('server/routes/app-updates.ts');
    // Même diffusion massive (`sendAppUpdatePush`), même réserve — déjà en place.
    assert.match(route, /router\.post\("\/publish", requireAuth[\s\S]{0,120}isSuperAdmin\(req\)/);
    assert.match(route, /router\.delete\("\/current", requireAuth[\s\S]{0,120}isSuperAdmin\(req\)/);
  });
});
