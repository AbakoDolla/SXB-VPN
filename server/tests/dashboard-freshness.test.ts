import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Le document d'entrée du tableau de bord doit être revalidé.
 *
 * `index.html` ne porte aucune version dans son nom : c'est lui qui désigne le
 * bundle à charger. Servi sans consigne de cache, le navigateur applique sa
 * propre heuristique de fraîcheur et peut resservir une page périmée pendant
 * des heures. L'utilisateur reste alors sur l'ancienne interface — une section
 * déployée reste invisible — sans aucun message d'erreur pour l'expliquer.
 */
describe("fraîcheur du tableau de bord", () => {
  const serveur = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
  const nginx = readFileSync(new URL("../../infrastructure/nginx/sxb-vpn.conf", import.meta.url), "utf8");

  it("impose la revalidation du document d'entrée, quel que soit le chemin servi", () => {
    assert.match(serveur, /const revalidateEntryDocument = \(res: Response\) => \{\s*\n\s*res\.setHeader\("Cache-Control", "no-cache"\);/);
    // Chemin direct (/index.html) servi par le middleware statique.
    assert.match(serveur, /if \(filePath\.endsWith\(`\$\{path\.sep\}index\.html`\)\) revalidateEntryDocument\(res as Response\);/);
    // Chemin d'application (/clients, /tokens…) servi par le repli SPA.
    assert.match(serveur, /revalidateEntryDocument\(res\);\s*\n\s*res\.sendFile\(path\.join\(distPath, "index\.html"\)\);/);
  });

  it("n'affaiblit pas le cache long des fichiers versionnés", () => {
    // Les fichiers de /assets portent une empreinte dans leur nom : les
    // revalider à chaque chargement coûterait un aller-retour par fichier,
    // sur un réseau mobile, sans rien apporter.
    assert.doesNotMatch(serveur, /setHeader\("Cache-Control", "no-cache"\)[\s\S]{0,200}assets/);
    assert.match(nginx, /add_header Cache-Control "public, immutable"/);
  });

  it("porte la même consigne au niveau du proxy, sans toucher aux fichiers versionnés", () => {
    assert.match(nginx, /location = \/index\.html \{[\s\S]{0,400}add_header Cache-Control "no-cache" always;/);
    assert.match(nginx, /location \/ \{[\s\S]{0,700}add_header Cache-Control "no-cache" always;/);
    // La règle des fichiers statiques reste distincte et inchangée.
    assert.match(nginx, /location ~\* \\\.\(jpg\|jpeg\|png\|gif\|ico\|css\|js\|svg\|woff\|woff2\|ttf\|eot\)\$/);
  });
});
