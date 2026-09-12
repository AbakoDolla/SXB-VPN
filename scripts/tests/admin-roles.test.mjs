import assert from "node:assert/strict";
import { test } from "node:test";
import { api, db, ok, row } from "./reseller-http.test.mjs";

/**
 * Création d'administrateur et étanchéité des rôles.
 *
 * Le propriétaire demande de VÉRIFIER que son SUPER_ADMIN peut créer un
 * administrateur qui se connecte ensuite, et que chaque rôle ne dispose que de
 * ses propres accès. Ces routes existent déjà ; ce fichier les éprouve contre
 * le vrai serveur monté par `reseller-http.test.mjs` — mêmes routeurs, même
 * faux ORM de forme Prisma — plutôt que d'ouvrir une seconde infrastructure de
 * test, ce qui serait précisément la redondance qu'il veut éviter.
 */

const bcrypt = (await import("./reseller-http.test.mjs")).require("bcryptjs");

/**
 * Le harnais nomme ses rôles par leur libellé (`id: "ADMIN"`), alors que la
 * route de création exige un identifiant au format UUID. On ajoute donc, pour
 * chaque cas, des rôles ayant la forme que la route attend — sans toucher à
 * ceux du harnais, dont dépendent les autres fichiers de test.
 */
const UUID_ROLES = {
  OWNER: "90000000-0000-4000-8000-000000000001",
  SUPER_ADMIN: "90000000-0000-4000-8000-000000000002",
  ADMIN: "90000000-0000-4000-8000-000000000003",
  SUPPORT: "90000000-0000-4000-8000-000000000004",
};

/** Déclare les rôles au format attendu et leur reporte les droits existants. */
function declarerRolesUuid() {
  for (const [nom, id] of Object.entries(UUID_ROLES)) {
    if (!db.state.Role.some(role => role.id === id)) db.state.Role.push({ id, name: nom });
    // Les droits sont portés par le rôle nommé dans le harnais : on les
    // reporte sur le jumeau, sinon le compte créé naîtrait sans permission.
    for (const permission of db.state.RolePermission.filter(p => p.roleId === nom)) {
      if (!db.state.RolePermission.some(p => p.roleId === id && p.permissionId === permission.permissionId)) {
        db.state.RolePermission.push({ roleId: id, permissionId: permission.permissionId });
      }
    }
  }
}

/** Un compte créé doit pouvoir se connecter : on éprouve le mot de passe réel. */
async function connexionPossible(email, password) {
  const reponse = await api(null, "POST", "/auth/login", { email, password });
  return reponse;
}

test("un SUPER_ADMIN crée un ADMIN qui se connecte ensuite avec le mot de passe choisi", async () => {
  declarerRolesUuid();
  const motDePasse = "Choisi-Par-Le-Proprietaire-2026";
  const cree = await api("super", "POST", "/users", {
    name: "Administrateur terrain",
    email: "terrain@example.test",
    roleId: UUID_ROLES.ADMIN,
    password: motDePasse,
  });
  ok(cree, 201);

  // Le compte existe réellement, avec le rôle demandé et un mot de passe haché.
  const enregistre = db.state.User.find(u => u.email === "terrain@example.test");
  assert.ok(enregistre, "Le compte doit être écrit en base");
  assert.equal(enregistre.roleId, UUID_ROLES.ADMIN);
  assert.notEqual(enregistre.passwordHash, motDePasse, "Le mot de passe ne doit jamais être stocké en clair");
  assert.ok(bcrypt.compareSync(motDePasse, enregistre.passwordHash),
    "Le mot de passe choisi doit être celui qui ouvre le compte");

  // Et il ouvre réellement une session : créer sans pouvoir se connecter ne
  // servirait à rien.
  const connexion = await connexionPossible("terrain@example.test", motDePasse);
  ok(connexion);
  assert.equal(connexion.body.user.role, "ADMIN");
  assert.ok(Array.isArray(connexion.body.user.permissions));
  assert.ok(connexion.body.accessToken, "La connexion doit délivrer une session utilisable");

  // Un mot de passe erroné reste refusé, sans dire lequel des deux est faux.
  const refus = await connexionPossible("terrain@example.test", "mauvais-mot-de-passe");
  assert.equal(refus.status, 401);
  assert.equal(JSON.stringify(refus.body).includes(motDePasse), false);
});

test("un ADMIN ne peut ni fabriquer ni toucher un compte au-dessus de lui", async () => {
  declarerRolesUuid();
  // Escalade par création : s'octroyer un SUPER_ADMIN ou un OWNER.
  for (const nom of ["SUPER_ADMIN", "OWNER"]) {
    const tentative = await api("admin", "POST", "/users", {
      name: `Escalade ${nom}`,
      email: `escalade-${nom.toLowerCase()}@example.test`,
      roleId: UUID_ROLES[nom],
      password: "Tentative-Escalade-2026",
    });
    assert.ok(tentative.status >= 400,
      `Un ADMIN ne doit pas créer un ${nom} (reçu ${tentative.status})`);
    assert.equal(db.state.User.some(u => u.email === `escalade-${nom.toLowerCase()}@example.test`), false,
      "Aucun compte ne doit subsister après un refus");
  }

  // Escalade par modification d'un compte supérieur existant.
  const avant = row("User", "super").passwordHash;
  const modification = await api("admin", "PATCH", "/users/super", { password: "reprise-de-compte" });
  assert.ok(modification.status >= 400, "Un ADMIN ne doit pas modifier un SUPER_ADMIN");
  assert.equal(row("User", "super").passwordHash, avant, "Le compte supérieur doit rester intact");
});

test("chaque rôle reste dans son périmètre, y compris en lecture", async () => {
  declarerRolesUuid();
  // SUPPORT : lecture seule. Il consulte, il n'écrit pas.
  const lectureSupport = await api("support", "GET", "/clients");
  assert.ok(lectureSupport.status < 400, "SUPPORT doit pouvoir consulter");
  const ecritureSupport = await api("support", "POST", "/users", {
    name: "Interdit", email: "interdit@example.test", roleId: UUID_ROLES.ADMIN, password: "Interdit-2026",
  });
  assert.ok(ecritureSupport.status >= 400, "SUPPORT ne doit pas créer de compte");

  // RESELLER : aucun accès à l'administration des comptes.
  const revendeur = await api("r1", "POST", "/users", {
    name: "Interdit", email: "interdit-r1@example.test", roleId: UUID_ROLES.ADMIN, password: "Interdit-2026",
  });
  assert.ok(revendeur.status >= 400, "Un revendeur ne doit pas créer de compte d'administration");

  // CLIENT : la session d'une application mobile n'ouvre aucune porte
  // d'administration — c'est le défaut qui avait laissé fuiter tout le parc
  // par l'ancien doublon /api/vpn.
  const client = await api("u1", "GET", "/users");
  assert.ok(client.status >= 400, "Un client ne doit pas lister les comptes");
  const clientClients = await api("u1", "GET", "/clients");
  assert.ok(clientClients.status >= 400, "Un client ne doit pas lister le parc");
});

test("la matrice des permissions fait autorité et ne peut pas se verrouiller elle-même", async () => {
  declarerRolesUuid();
  // Retirer un droit doit être immédiatement effectif : la matrice décide, pas
  // le nom du rôle. Le retrait porte sur les deux formes du rôle ADMIN.
  const avant = db.state.RolePermission.length;
  db.state.RolePermission = db.state.RolePermission.filter(
    p => !((p.roleId === "ADMIN" || p.roleId === UUID_ROLES.ADMIN) && p.permissionId === "users.create"));
  assert.notEqual(db.state.RolePermission.length, avant);

  const refus = await api("admin", "POST", "/users", {
    name: "Apres retrait", email: "apres-retrait@example.test", roleId: UUID_ROLES.SUPPORT, password: "Apres-Retrait-2026",
  });
  assert.equal(refus.status, 403, "Le droit retiré doit être appliqué sans redémarrage");

  // Le SUPER_ADMIN, lui, conserve sa capacité : le retrait ciblait ADMIN seul.
  const superAdmin = await api("super", "POST", "/users", {
    name: "Toujours possible", email: "toujours@example.test", roleId: UUID_ROLES.SUPPORT, password: "Toujours-2026",
  });
  ok(superAdmin, 201);
});
