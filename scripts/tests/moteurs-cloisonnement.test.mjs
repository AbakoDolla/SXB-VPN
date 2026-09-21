import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────────
// Les écrans « moteur » (xpanel, xray, sing-box, SSH) portaient tous le même
// défaut : leurs compteurs et leurs listes interrogeaient la table entière.
//
// Pour xpanel, la fuite a été MESURÉE en production : un administrateur sans
// aucun client ni serveur lisait « 753 utilisateurs synchronisés, 3 serveurs,
// 6 configs » — les chiffres exacts du propriétaire.
//
// Pour xray, sing-box et SSH, les tables sont VIDES en production : aucune
// mesure ne peut prouver la fuite aujourd'hui. Elle apparaîtrait au premier
// compte créé. Ces gardes s'appuient donc sur le code, et c'est assumé.
// ─────────────────────────────────────────────────────────────────────────────

describe('xpanel — les compteurs sont ceux du requérant', () => {
  it('le parc et les serveurs passent par la portée', () => {
    const route = source('server/routes/xpanel.ts');

    assert.match(route, /const porteeClientsRequerant = await porteeClients\(prisma, req\.user\)/);
    assert.match(route, /const porteeServeursRequerant = await porteeServeurs\(prisma, req\.user\)/);
    assert.match(route, /vpnClient\.count\(\{\s*where: etFiltres\(\{ status: "active" \}, porteeClientsRequerant\)/);
    assert.match(route, /vPSServer\.count\(\{\s*where: \(porteeServeursRequerant \?\? undefined\)/);

    // Le handler doit recevoir la requête : `_req` est le motif d'origine.
    assert.doesNotMatch(
      route,
      /router\.get\("\/status".*async \(_req/,
      'le handler /status doit recevoir `req` pour porter une portée',
    );
  });

  it('aucun compteur du parc ne reste sans portée', () => {
    const route = source('server/routes/xpanel.ts');
    // Un `count()` nu, ou un `count({ where: { status: ... } })` sans portée,
    // compte toute la plateforme.
    assert.doesNotMatch(route, /vpnClient\.count\(\)/);
    assert.doesNotMatch(route, /vPSServer\.count\(\)/);
    assert.doesNotMatch(route, /vpnClient\.count\(\{ where: \{ status: "active" \} \}\)/);
  });
});

describe('xray et sing-box — comptes rattachés au client servi', () => {
  for (const [moteur, fichier, modele] of [
    ['xray', 'server/routes/xray.ts', 'xrayAccount'],
    ['sing-box', 'server/routes/singbox.ts', 'singboxAccount'],
  ]) {
    it(`${moteur} : la liste et les compteurs appliquent porteeComptesMoteur`, () => {
      const route = source(fichier);

      assert.match(route, /porteeComptesMoteur/, 'la portée des comptes de moteur doit être importée');
      assert.match(route, /const portee = await porteeComptesMoteur\(prisma, req\.user\)/);

      // La liste : sans `where`, elle rend le parc entier.
      assert.match(
        route,
        new RegExp(`${modele}\\.findMany\\(\\{\\s*where: \\(portee \\?\\? undefined\\)`),
        `la liste ${moteur} doit être filtrée par la portée`,
      );

      // Les compteurs.
      assert.match(
        route,
        new RegExp(`${modele}\\.count\\(\\{ where: \\(portee \\?\\? undefined\\) as any \\}\\)`),
        `le total ${moteur} doit être filtré par la portée`,
      );
      assert.match(
        route,
        new RegExp(`${modele}\\.count\\(\\{ where: etFiltres\\(\\{ status: "active" \\}, portee\\)`),
        `le compteur « actifs » ${moteur} doit combiner statut ET portée`,
      );

      // Les formes d'origine : un compteur nu compte toute la plateforme.
      assert.doesNotMatch(route, new RegExp(`${modele}\\.count\\(\\)`));
      assert.doesNotMatch(
        route,
        new RegExp(`${modele}\\.count\\(\\{ where: \\{ status: "active" \\} \\}\\)`),
      );
    });
  }
});

describe('SSH — comptes rattachés à leur auteur', () => {
  it('la liste et les quatre compteurs appliquent porteeComptesSsh', () => {
    const route = source('server/routes/ssh.ts');

    assert.match(route, /porteeComptesSsh/);
    assert.match(route, /sshAccount\.findMany\(\{\s*where: \(portee \?\? undefined\)/);

    for (const statut of ['active', 'suspended', 'expired']) {
      assert.match(
        route,
        new RegExp(`sshAccount\\.count\\(\\{ where: etFiltres\\(\\{ status: '${statut}' \\}, portee\\)`),
        `le compteur « ${statut} » doit combiner statut ET portée`,
      );
      assert.doesNotMatch(
        route,
        new RegExp(`sshAccount\\.count\\(\\{ where: \\{ status: '${statut}' \\} \\}\\)`),
        `le compteur « ${statut} » ne doit pas porter sur toute la table`,
      );
    }
    assert.doesNotMatch(route, /sshAccount\.count\(\),/);
  });

  it('l’accès direct par identifiant ne contourne pas la portée', () => {
    const route = source('server/routes/ssh.ts');

    // `findUnique({ where: { id } })` rendait le compte de n'importe quel
    // propriétaire à qui connaissait son identifiant. Un filtre de liste ne
    // protège pas un accès direct.
    assert.match(route, /sshAccount\.findFirst\(\{\s*where: etFiltres\(\{ id: req\.params\.id \}, portee\)/);
    assert.doesNotMatch(
      route,
      /sshAccount\.findUnique\(\{\s*where: \{ id: req\.params\.id \},?\s*\}\)/,
      'un accès direct par identifiant doit passer par la portée',
    );
  });
});

describe('withUnlockedEngine — le passage obligé des accès par identifiant', () => {
  it('vérifie la propriété avant d’exécuter l’action', () => {
    const service = source('server/services/profile-engines.ts');

    // Toutes les routes de moteur (lecture, modification, suspension,
    // suppression, génération de config) passent ici. Sans ce contrôle,
    // connaître un identifiant suffisait à agir sur le compte d'autrui.
    assert.match(service, /async function assertCompteMoteurAccessible\(/);
    assert.match(service, /await assertCompteMoteurAccessible\(db, engine, id, req\)/);

    // Le refus doit emprunter le MÊME code que l'inexistant, sinon la réponse
    // révèle que la ressource existe.
    assert.match(
      service,
      /if \(trouve === 0\) throw new ProfileLockError\(404, 'PROFILE_ENGINE_NOT_FOUND'\)/,
    );

    // Le contrôle doit précéder l'action, jamais la suivre.
    const posControle = service.indexOf('await assertCompteMoteurAccessible');
    const posAction = service.indexOf('const result = await action(db, account)');
    assert.ok(posControle > 0 && posAction > 0, 'les deux repères doivent exister');
    assert.ok(
      posControle < posAction,
      'la vérification de propriété doit précéder l’exécution de l’action',
    );
  });

  it('SSH passe par sa portée propre, les autres moteurs par celle des clients', () => {
    const service = source('server/services/profile-engines.ts');
    assert.match(service, /engine === 'ssh'\s*\?\s*await porteeComptesSsh\(db, requerant\)/);
    assert.match(service, /:\s*await porteeComptesMoteur\(db, requerant\)/);
  });
});

describe('portée des comptes de moteur — auteur ou client servi', () => {
  it('un compte appartient à son auteur, même avant d’être attribué', () => {
    const portee = source('server/services/portee-donnees.ts');

    assert.match(portee, /export async function porteeComptesMoteur\(/);
    assert.match(portee, /export async function porteeComptesSsh\(/);

    // Cloisonner sur le SEUL client servi privait l'auteur du compte qu'il
    // venait de créer : le flux normal est de créer l'offre PUIS de
    // l'attribuer. Le banc l'a refusé. `createdBy` répare le rattachement.
    assert.match(portee, /\{ createdBy: requerant\.userId \}/);
    assert.match(
      portee,
      /\.\.\.\(porteeDesClients \? \[\{ client: porteeDesClients \}\] : \[\]\)/,
      'le client servi doit rester un rattachement valide, en plus de l’auteur',
    );

    // Seuls les rôles cloisonnés sont restreints : le propriétaire, le
    // super-administrateur et le support ne doivent rien perdre.
    assert.match(portee, /if \(!estCloisonne\(requerant\?\.role \?\? null\)\) return null/);
  });

  it('les deux tables de moteur portent un auteur dans le schéma', () => {
    for (const schema of ['backend/prisma/schema.prisma', 'prisma/schema.prisma']) {
      const texte = source(schema);
      for (const modele of ['XrayAccount', 'SingboxAccount']) {
        const bloc = texte.slice(texte.indexOf(`model ${modele} {`));
        const corps = bloc.slice(0, bloc.indexOf('\n}'));
        assert.match(corps, /createdBy\s+String\?/, `${modele} doit porter createdBy dans ${schema}`);
      }
    }
  });

  it('la création renseigne l’auteur', () => {
    assert.match(source('server/routes/xray.ts'), /createdBy: req\.user\?\.userId \?\? null/);
    assert.match(source('server/routes/singbox.ts'), /createdBy: req\.user\?\.userId \?\? null/);
  });
});
