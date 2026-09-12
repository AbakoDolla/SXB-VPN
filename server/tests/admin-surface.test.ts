import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Le doublon non protégé de `/api/clients` ne doit jamais revenir.
 *
 * `server/routes/vpn/index.ts` exposait le parc entier — identifiants, jetons
 * d'activation, quotas — derrière `requireAuth` SEUL : aucune permission,
 * aucune portée revendeur. L'application d'un client porte une session valide,
 * elle passait donc ce contrôle. `POST` et `DELETE` laissaient créer ou
 * suspendre un client dans les mêmes conditions, et `GET /config/:token`
 * répondait SANS authentification du tout, en divulguant des identifiants de
 * serveur écrits en dur.
 *
 * Enchaînés, ces défauts donnaient à n'importe quel utilisateur de
 * l'application la configuration VPN de tous les autres : lister le parc pour
 * récupérer les jetons, puis échanger chaque jeton contre une configuration.
 *
 * Aucun appelant n'a jamais existé — ni application, ni tableau de bord, ni
 * script. `/api/clients` couvre les mêmes besoins avec permissions et
 * cloisonnement.
 */
describe("surface d'administration des clients", () => {
  const racine = new URL("../../", import.meta.url);
  const serveur = readFileSync(new URL("server.ts", racine), "utf8");

  it("ne remonte plus le doublon non protégé", () => {
    assert.equal(existsSync(new URL("server/routes/vpn/index.ts", racine).pathname.replace(/^\//, "")), false,
      "Le routeur doublon ne doit pas réapparaître");
    assert.doesNotMatch(serveur, /app\.use\(["']\/api\/vpn["']/,
      "Aucun montage de /api/vpn : /api/clients porte déjà ce besoin, avec permissions");
    assert.doesNotMatch(serveur, /import\s+vpnRouter/);
  });

  it("laisse intactes les routes VPN légitimes, qui portent leurs propres contrôles", () => {
    // `/api/mobile` et `/api/provision` servent les appareils déjà en service :
    // les retirer couperait l'accès sur le terrain.
    assert.match(serveur, /app\.use\(["']\/api\/mobile["']/);
    assert.match(serveur, /app\.use\(["']\/api\/provision["']/);
    assert.match(serveur, /app\.use\(["']\/api\/clients["']/);
  });

  it("garde la liste des clients derrière une permission et une portée revendeur", () => {
    const clients = readFileSync(new URL("server/routes/clients.ts", racine), "utf8");
    // La route de liste doit exiger un droit explicite, et non la seule
    // présence d'une session.
    assert.match(clients, /requirePermission\(/);
    assert.match(clients, /porteeClientsRevendeur|chargerFicheRevendeur/);
  });
});
