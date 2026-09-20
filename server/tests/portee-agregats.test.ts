import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Les COMPTEURS doivent être cloisonnés comme les LISTES.
 *
 * `/api/vpn-profiles` filtrait correctement sa liste par `porteeProfils`, mais
 * `/api/vpn-profiles/stats/all` comptait la plateforme entière. Un
 * administrateur dont l'espace ne contenait aucune configuration lisait donc
 * quand même le total général. Mesuré en production : un compte neuf, à zéro
 * configuration, affichait « total 59 / active 59 » — exactement le chiffre de
 * l'OWNER. C'est la capture d'écran envoyée par le client (« Total profiles 57
 * / Active 57 »).
 *
 * Le piège est qu'une liste protégée donne l'illusion du cloisonnement : seul
 * un agrégat oublié trahit le parc. Ce garde-fou lit la source, car la portée
 * est appliquée à l'exécution et aucun typage ne peut la rendre obligatoire.
 */
describe("cloisonnement des agrégats de configurations", () => {
  const racine = new URL("../../", import.meta.url);
  const source = readFileSync(new URL("server/routes/vpn-profiles.ts", racine), "utf8");

  /** Isole le corps d'une route, commentaires retirés. */
  function corpsDeRoute(chemin: string): string {
    const debut = source.indexOf(`router.get('${chemin}'`);
    assert.notEqual(debut, -1, `La route ${chemin} doit exister`);
    const suite = source.indexOf("\nrouter.", debut + 1);
    const bloc = source.slice(debut, suite === -1 ? source.length : suite);
    return bloc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
  }

  for (const chemin of ["/stats/all", "/:id/stats"]) {
    describe(`GET ${chemin}`, () => {
      const corps = corpsDeRoute(chemin);

      it("demande la portée de l'appelant", () => {
        assert.match(corps, /porteeProfils\(\s*prisma\s*,\s*_?req\.user\s*\)/,
          "Sans `porteeProfils`, le compteur porte sur toute la plateforme");
      });

      it("ne compte jamais sans filtre", () => {
        assert.doesNotMatch(corps, /vpnProfile\.count\(\s*\)/,
          "`count()` nu compte le parc entier, quel que soit l'appelant");
      });

      it("compose la portée avec le filtre d'état au lieu de l'écraser", () => {
        // `{ where: { status: 'active' } }` seul perd la portée : les deux
        // conditions doivent tenir dans le même objet.
        assert.doesNotMatch(corps, /count\(\{\s*where:\s*\{\s*status:\s*'active'\s*\}\s*\}\)/,
          "Le filtre d'état a écrasé la portée");
        assert.match(corps, /\.\.\.\(portee \?\? \{\}\),\s*status: 'active'/,
          "La portée et l'état doivent être combinés");
      });

      it("cloisonne aussi la répartition par protocole", () => {
        assert.match(corps, /groupBy\(\{\s*where:\s*\{\s*\.\.\.\(portee \?\? \{\}\)/,
          "`groupBy` révélait la répartition de toute la plateforme");
      });
    });
  }

  it("protège la lecture unitaire qui précède les statistiques par identifiant", () => {
    // Un filtre de liste n'empêche pas de deviner un identifiant : la route
    // doit vérifier la ligne elle-même avant de répondre.
    assert.match(corpsDeRoute("/:id/stats"), /profilVisible\(profile,\s*req\)/,
      "Sans contrôle unitaire, un administrateur lit la fiche d'un autre en devinant son identifiant");
  });

  it("laisse la liste protégée comme elle l'était", () => {
    // Garde-fou de non-régression : la correction des compteurs ne doit pas
    // avoir déplacé la portée de la liste.
    assert.match(source, /const portee = await porteeProfils\(prisma, req\.user\);/);
    assert.match(source, /\.\.\.\(portee \? \{ where: portee \} : \{\}\)/);
  });
});
