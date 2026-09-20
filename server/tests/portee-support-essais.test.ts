import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Deux dernières fuites mesurées sur l'administrateur de recette.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * CE QUI A ÉTÉ MESURÉ EN PRODUCTION
 * ═════════════════════════════════════════════════════════════════════════
 * Le balayage des 22 surfaces, ADMIN contre OWNER, a laissé deux anomalies
 * après les correctifs précédents :
 *
 *   • `GET /api/free-trial/stats/overview` — les COMPTEURS étaient corrects
 *     (0 essai contre 596), mais `trafficGrantedBytes`, `trafficUsedBytes` et
 *     `trafficRemainingBytes` étaient IDENTIQUES à ceux du propriétaire.
 *     C'est exactement la capture d'écran envoyée par le client :
 *     « Trial data: 294.9 GB used of 17.6 TB » au-dessus d'un tableau vide.
 *
 *   • `GET /api/support` — 9 tickets sur 9, avec le nom du client, son
 *     adresse électronique et la description de sa panne.
 *
 * Le piège est le même dans les deux cas : une liste protégée donne
 * l'illusion du cloisonnement, et c'est l'AGRÉGAT voisin qui trahit le parc.
 *
 * Ces garde-fous lisent la source : la portée s'applique à l'exécution et le
 * `tsconfig` racine ne couvre pas `server/`, si bien qu'une régression ici ne
 * tomberait qu'EN PRODUCTION.
 */

const racine = new URL("../../", import.meta.url);

/** Le dépôt est en CRLF : une ancre écrite avec « \n » ne matcherait jamais. */
function lire(chemin: string): string {
  return readFileSync(new URL(chemin, racine), "utf8").replace(/\r\n/g, "\n");
}

describe("le volume d'essai suit la portée de son lecteur", () => {
  const source = lire("server/routes/free-trial.ts");

  it("ne ramasse plus les forfaits d'essai de toute la plateforme", () => {
    // Cette condition était GLOBALE et inconditionnelle : quel que soit
    // l'appelant, elle sélectionnait tout forfait né d'un essai. Les
    // compteurs voisins, eux, étaient bien cloisonnés — d'où un espace
    // vierge surmonté de 17,6 To.
    assert.doesNotMatch(
      source,
      /conditions\.push\(\{ freeTrialRequestId: \{ not: null \} \}\);/,
      "Ce `push` nu additionnait le trafic d'essai de toute la plateforme",
    );
  });

  it("passe la portée par la demande dont le forfait est né", () => {
    assert.match(
      source,
      /conditions\.push\(porteeCampagne[\s\S]{0,200}?freeTrialRequest: porteeCampagne/,
      "Le volume doit se restreindre aux demandes visibles par l'appelant",
    );
  });

  it("conserve le cas sans portée pour le propriétaire", () => {
    // Hors administrateur, `porteeDemandesEssai` rend `null` : le
    // propriétaire et le super-administrateur doivent lire exactement ce
    // qu'ils lisaient. Un correctif qui change leurs chiffres est un bug.
    assert.match(
      source,
      /: \{ freeTrialRequestId: \{ not: null \} \}\);/,
      "Sans portée, la sélection d'origine doit être préservée",
    );
  });

  it("dérive la portée de la même source que les compteurs", () => {
    assert.match(
      source,
      /const porteeCampagne = await porteeDemandesEssai\(prisma, req\.user\)/,
      "Les compteurs et le volume doivent partager UNE seule portée",
    );
  });
});

describe("les tickets de support sont cloisonnés", () => {
  const source = lire("server/routes/support.ts");

  it("s'en remet au point unique du cloisonnement", () => {
    assert.match(
      source,
      /import \{ porteeComptes \} from "\.\.\/services\/portee-donnees"/,
      "La règle ne doit jamais être recopiée dans une route",
    );
  });

  it("ne rend plus un filtre vide au personnel de support", () => {
    assert.doesNotMatch(
      source,
      /const baseWhere = isSupportStaff\(req\)\n\s*\? \{\}\n/,
      "Ce `{}` livrait les 9 tickets de la plateforme à un administrateur",
    );
    assert.match(
      source,
      /isSupportStaff\(req\)\n\s*\? \(portee \? \{ user: portee \} : \{\}\)/,
      "La liste doit se restreindre aux comptes visibles par l'appelant",
    );
  });

  it("vise un ticket à travers la portée, jamais par identifiant nu", () => {
    assert.doesNotMatch(
      source,
      /supportTicket\.findUnique/,
      "`findUnique` n'accepte aucun filtre composé : la portée y est impossible",
    );
    const cibles = source.match(/supportTicket\.findFirst\(\{\s*where: await cibler\(req, req\.params\.id\)/g) ?? [];
    assert.equal(
      cibles.length,
      3,
      "Lecture, modification ET suppression doivent toutes passer par le ciblage",
    );
  });

  it("refuse de supprimer un ticket hors de portée", () => {
    // La suppression partait sur l'identifiant NU : un administrateur
    // effaçait n'importe quel ticket de la plateforme, sans le lire.
    assert.match(
      source,
      /const cible = await prisma\.supportTicket\.findFirst\(\{ where: await cibler\(req, req\.params\.id\) \}\);\n\s*if \(!cible\) \{\n\s*return res\.status\(404\)/,
      "Le 404 doit précéder la suppression",
    );
  });

  it("ferme plutôt que d'ouvrir quand le compte est inconnu", () => {
    assert.match(
      source,
      /conditions\.push\(\{ userId: req\.user\?\.userId \|\| '__no_user__' \}\)/,
      "Sans identité, la requête ne doit rien rendre — jamais tout rendre",
    );
  });
});
