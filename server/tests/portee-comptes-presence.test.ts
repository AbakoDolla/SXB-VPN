import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Les COMPTES et la PRÉSENCE doivent être cloisonnés comme le reste.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI A ÉTÉ MESURÉ EN PRODUCTION
 * ═══════════════════════════════════════════════════════════════════════════
 * Avec un administrateur créé à l'instant, propriétaire d'UN SEUL client, le
 * tableau de bord rendait :
 *
 *   • `GET /api/users`               → 768 comptes de toute la plateforme,
 *                                      autres administrateurs compris, avec
 *                                      « Tout sélectionner (754) » puis
 *                                      « Supprimer la sélection » ;
 *   • `GET /api/presence/connected`  → 27 clients nominatifs d'autrui, avec
 *                                      leur identifiant d'appareil et le nom
 *                                      de leur revendeur ;
 *   • `GET /api/presence/resellers`  → 6 revendeurs au lieu du sien.
 *
 * Les listes voisines (`/api/clients`, `/api/devices`, `/api/vpn-profiles`)
 * étaient, elles, correctement cloisonnées : c'est précisément le piège, un
 * espace d'apparence vierge qui fuit par trois surfaces annexes.
 *
 * Ces garde-fous lisent la source, car la portée s'applique à l'exécution et
 * le `tsconfig` racine ne couvre pas `server/` : une régression ici ne
 * tomberait qu'EN PRODUCTION.
 */

const racine = new URL("../../", import.meta.url);

/** Isole le corps d'une route, commentaires retirés. */
function corpsDeRoute(source: string, amorce: string): string {
  const debut = source.indexOf(amorce);
  assert.notEqual(debut, -1, `La route ${amorce} doit exister`);
  const suite = source.indexOf("\nrouter.", debut + 1);
  const bloc = source.slice(debut, suite === -1 ? source.length : suite);
  return bloc
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("portée des comptes de connexion", () => {
  // Lecture de la source, et non appel : `portee-donnees` tire `database.ts`,
  // que le banc de test ne peut pas charger. C'est aussi la convention des
  // garde-fous voisins, `server/` n'étant couvert par aucun typage.
  const source = readFileSync(new URL("server/services/portee-donnees.ts", racine), "utf8");
  const corps = (() => {
    const debut = source.indexOf("export async function porteeComptes");
    assert.notEqual(debut, -1, "porteeComptes doit exister");
    const suite = source.indexOf("\nexport ", debut + 1);
    return source.slice(debut, suite === -1 ? source.length : suite);
  })();

  it("ne cloisonne que l'administrateur", () => {
    assert.match(corps, /!== ROLE_ADMIN\) return null/,
      "Propriétaire, super-administrateur et support doivent voir ce qu'ils voyaient");
  });

  it("rattache le compte par ses RELATIONS", () => {
    // Un compte ne porte ni gestionnaire ni auteur : son rattachement ne peut
    // s'exprimer que par le client VPN qu'il incarne ou la fiche revendeur
    // qu'il porte.
    assert.match(corps, /\{ id: moi \}/,
      "L'administrateur doit rester visible dans son propre annuaire");
    assert.match(corps, /vpnClients: \{ some: \{ managedById: moi \} \}/,
      "Les comptes de ses clients doivent lui rester visibles");
    assert.match(corps, /resellerInfo: \{ createdBy: moi \}/,
      "Les comptes des revendeurs qu'il a créés doivent lui rester visibles");
  });

  it("refuse plutôt que d'ouvrir l'annuaire sans identité", () => {
    assert.match(corps, /if \(!requerant\?\.userId\) return \{ id: \{ in: \[\] \} \}/,
      "Une identité absente doit fermer, jamais ouvrir");
  });

  it("reste exportée depuis le point unique de cloisonnement", () => {
    assert.match(source, /export async function porteeComptes/,
      "La règle doit vivre avec les autres portées, pas dans la route");
  });
});

describe("cloisonnement de /api/users", () => {
  const source = readFileSync(new URL("server/routes/users.ts", racine), "utf8");

  it("importe la portée qu'il emploie", () => {
    assert.match(source, /import \{ porteeComptes \} from "\.\.\/services\/portee-donnees"/,
      "Un appel sans import ne tomberait qu'à l'exécution, en production");
  });

  it("filtre la liste EN BASE", () => {
    const corps = corpsDeRoute(source, 'router.get("/", requireAuth');
    assert.match(corps, /porteeComptes\(\s*prisma\s*,\s*req\.user\s*\)/,
      "Sans portée, `findMany` rend l'annuaire entier");
    assert.doesNotMatch(corps, /user\.findMany\(\{\s*\n\s*include:/,
      "`findMany` ne doit plus partir sans `where`");
  });

  it("vise un compte unique à travers la portée", () => {
    // `findUnique({ where: { id } })` ignore toute portée : seul `findFirst`
    // accepte un filtre composé. C'est ce qui retire à un administrateur le
    // pouvoir de lire, modifier ou SUPPRIMER le compte d'autrui.
    const utiles = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    for (const ligne of utiles) {
      assert.ok(
        !/prisma\.user\.findUnique\(\{ where: \{ id \}/.test(ligne),
        `Cette lecture contourne la portée : ${ligne.trim()}`,
      );
    }
    const cibles = utiles.filter((l) => /ciblerCompte\(req, id\)/.test(l));
    assert.ok(cibles.length >= 3,
      `Lecture, modification et suppression doivent toutes cibler à travers la portée (vu ${cibles.length})`);
  });

  it("ne supprime rien hors de portée", () => {
    const corps = corpsDeRoute(source, 'router.delete("/:id"');
    assert.match(corps, /ciblerCompte\(req, id\)/,
      "La suppression doit chercher le compte à travers la portée");
    assert.match(corps, /if \(!u\) \{[\s\S]*?404/,
      "Hors de portée, la route doit répondre « introuvable » sans supprimer");
  });
});

describe("cloisonnement de /api/presence", () => {
  const source = readFileSync(new URL("server/routes/presence.ts", racine), "utf8");

  it("n'invente plus une portée réservée au revendeur", () => {
    assert.doesNotMatch(source, /porteeClients: isReseller/,
      "La portée doit venir du point unique, pas d'un test de rôle local");
    assert.doesNotMatch(source, /const isReseller = /,
      "Ne cloisonner que le revendeur laissait l'administrateur tout voir");
  });

  it("annonce une portée conforme à celle qu'il applique", () => {
    // Dire « platform » à un administrateur désormais cloisonné serait faux,
    // et ferait croire l'interface à un chiffre qu'elle ne reçoit pas.
    assert.doesNotMatch(source, /scope: req\.user\?\.role === "RESELLER"/,
      "Le libellé se déduisait du rôle, plus de la portée appliquée");
    assert.match(source, /scope: portee\.porteeClients \? "own" : "platform"/,
      "Le libellé doit suivre la portée réellement appliquée");
  });

  it("demande la portée au point unique, pour tous les rôles", () => {
    assert.match(source, /porteeClients\(\s*prisma\s*,\s*req\.user\s*\)/,
      "Sans elle, la liste nominative des connectés part entière");
    assert.match(source, /porteeRevendeurs\(\s*prisma\s*,\s*req\.user\s*\)/,
      "Sans elle, les fiches revendeur d'autrui restent nommées");
  });

  it("applique la même portée aux connectés ET aux revendeurs", () => {
    for (const amorce of ['router.get("/connected"', 'router.get("/resellers"']) {
      const corps = corpsDeRoute(source, amorce);
      assert.match(corps, /porteeDemandeur\(req\)/,
        `${amorce} doit porter la portée du demandeur`);
    }
  });
});

describe("le service de présence honore la portée reçue", () => {
  const source = readFileSync(new URL("server/services/vpn-presence.ts", racine), "utf8");

  it("expose une portée dédiée aux fiches revendeur", () => {
    // Une fiche revendeur n'a pas de gestionnaire : la portée des clients ne
    // s'y applique pas, elle ferait échouer la requête sur un champ inconnu.
    assert.match(source, /porteeFichesRevendeur\?: Record<string, unknown> \| null/,
      "Sans option dédiée, la liste des fiches reste globale");
  });

  it("compose la portée avec la furtivité au lieu de la remplacer", () => {
    assert.match(source, /etAvec\(stealthRevendeur, options\.porteeFichesRevendeur\)/,
      "Les deux conditions doivent tenir ensemble");
    assert.match(source, /etAvec\(\{ resellerId: \{ not: null \}, \.\.\.stealth \}, options\.porteeClients\)/,
      "Le décompte des parcs doit être cloisonné lui aussi");
    assert.doesNotMatch(source, /where: \{ resellerId: \{ not: null \}, \.\.\.stealth \}/,
      "Ce `where` nu comptait les parcs de toute la plateforme");
  });
});
