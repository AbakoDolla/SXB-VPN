import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sessionUser } from "../services/session-user";

/**
 * L'utilisateur de session vu par le tableau de bord.
 *
 * Le tableau de bord remplace l'utilisateur courant par la réponse de chaque
 * route de profil. Ces routes renvoyaient l'enregistrement brut de la base :
 * `role` y était l'objet Role et `permissions` était absent. Le rendu évalue
 * `permissions.includes(...)`, donc enregistrer son profil suffisait à faire
 * tomber toute section vérifiant un droit — écran « Une erreur est survenue »,
 * observé en production sur la génération de jeton.
 */
describe("utilisateur de session", () => {
  const requete = (role: string, permissions: string[]) =>
    ({ user: { userId: "u1", email: "a@b.c", role, permissions } }) as any;

  const enregistrement = {
    id: "u1",
    name: "Revendeur Un",
    email: "un@sxb.local",
    status: "active",
    phone: "+225 07 00 00 00",
    avatarUrl: "/uploads/avatars/u1.png",
    passwordHash: "$2a$12$jamais-exposé",
    roleId: "role-reseller",
    role: { id: "role-reseller", name: "RESELLER", description: "Revendeur" },
  };

  it("porte toujours une liste de droits et un rôle en chaîne", () => {
    const profil = sessionUser(enregistrement, requete("RESELLER", ["tokens.create"])) as any;
    assert.equal(profil.role, "RESELLER", "Un objet Role ferait échouer toute comparaison de rôle");
    assert.deepEqual(profil.permissions, ["tokens.create"]);
    assert.ok(Array.isArray(profil.permissions));
    assert.equal(profil.phone, "+225 07 00 00 00", "Le formulaire de profil relit ce champ");
    assert.equal(profil.avatarUrl, "/uploads/avatars/u1.png");
  });

  it("n'expose jamais le condensat du mot de passe ni le rôle brut", () => {
    const profil = sessionUser(enregistrement, requete("RESELLER", [])) as any;
    assert.equal(profil.passwordHash, undefined);
    assert.equal(profil.roleId, undefined);
    assert.equal(typeof profil.role, "string");
  });

  it("prend le rôle et les droits de la session, jamais de l'enregistrement", () => {
    // requireAuth ramène un revendeur sans fiche au rôle CLIENT : recopier le
    // rôle stocké en base contournerait ce contrôle.
    const profil = sessionUser(enregistrement, requete("CLIENT", [])) as any;
    assert.equal(profil.role, "CLIENT");
    assert.deepEqual(profil.permissions, []);
  });

  it("reste une liste vide plutôt qu'une absence quand la session n'en porte pas", () => {
    const profil = sessionUser(enregistrement, {} as any) as any;
    assert.deepEqual(profil.permissions, [], "Une valeur absente relançait le plantage du rendu");
    assert.equal(profil.role, null);
  });

  it("est la seule forme renvoyée par les trois routes qui alimentent la session", () => {
    const utilisateurs = readFileSync(new URL("../routes/users.ts", import.meta.url), "utf8");
    const authentification = readFileSync(new URL("../routes/auth.ts", import.meta.url), "utf8");

    // PATCH /users/me et POST /users/me/avatar alimentent `onUserUpdated`.
    assert.match(utilisateurs, /return res\.json\(sessionUser\(updated, req\)\);/);
    assert.match(utilisateurs, /user: sessionUser\(safe, req\)/);
    assert.match(authentification, /return res\.json\(sessionUser\(user, req\)\);/);

    // Aucune de ces routes ne doit renvoyer l'enregistrement brut.
    assert.doesNotMatch(utilisateurs, /const \{ passwordHash, \.\.\.safe \} = updated as any;\s*\n\s*return res\.json\(safe\);/);
    assert.doesNotMatch(utilisateurs, /user: safe \}/);
  });

  it("le tableau de bord refuse un droit inconnu au lieu de faire tomber la section", () => {
    const racine = new URL("../../artifacts/sxb-dashboard/src/", import.meta.url);
    const droits = readFileSync(new URL("contexts/PermissionsContext.tsx", racine), "utf8");
    const menu = readFileSync(new URL("components/Layout.tsx", racine), "utf8");
    const bons = readFileSync(new URL("components/VouchersView.tsx", racine), "utf8");

    assert.match(droits, /Array\.isArray\(permissions\) \? permissions : \[\]/);
    assert.match(menu, /Array\.isArray\(currentUser\.permissions\) \? currentUser\.permissions : \[\]/);
    assert.match(bons, /Array\.isArray\(permissions\) && permissions\.includes\(permission\)/);

    // Plus aucun accès direct non gardé : c'était le point de plantage.
    assert.doesNotMatch(droits, /\|\| permissions\.includes\(/);
    assert.doesNotMatch(menu, /\|\| currentUser\.permissions\.includes\(/);
  });
});
