/**
 * Surface du routeur /xapi — verrou structurel.
 *
 * POURQUOI CE BANC EXISTE. `POST /xapi/mobile/connections/:id/status` écrivait
 * `subscription.update({ where: { id } })` SANS authentification, en doublon
 * dégradé de `mobile.ts`. Elle n'était retenue que par la réécriture nginx
 * `^/xapi(/.*)$ → /api$1`, c'est-à-dire par une ligne de configuration qui ne
 * vit pas dans ce dépôt et que personne ici ne contrôle.
 *
 * Rien ne l'avait empêchée d'être écrite, et rien n'empêcherait de la
 * réintroduire. Ce fichier est ce quelque chose.
 *
 * RÈGLE : /xapi est une surface de LECTURE publique. Aucun verbe d'écriture.
 *
 * Le banc lit le code amputé de ses commentaires : l'en-tête du routeur parle
 * de la route supprimée pour expliquer pourquoi elle l'a été, et un banc qui
 * lit la prose mesure les intentions au lieu des faits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (p) => readFileSync(join(racine, p), "utf8").replace(/\r\n/g, "\n");

/** Retire les blocs /* *​/ et les lignes commençant par // (jamais en milieu de
 *  ligne : cela mutilerait les URL « https:// »). */
function sansCommentaires(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const xapi = lire("server/routes/xapi.ts");
const code = sansCommentaires(xapi);

test("le routeur /xapi ne déclare aucune route d'écriture", () => {
  const ecritures = [...code.matchAll(/router\.(post|put|patch|delete)\s*\(\s*["'`]([^"'`]*)/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(
    ecritures,
    [],
    `/xapi est une surface de lecture publique, non authentifiée : toute écriture y est ` +
      `atteignable sans jeton dès que la réécriture nginx change. Trouvé : ${ecritures.join(", ")}`
  );
});

test("aucune mutation de base de données ne subsiste dans /xapi", () => {
  const mutations = [...code.matchAll(/\.(update|create|delete|upsert|updateMany|deleteMany|createMany)\s*\(/g)]
    .map((m) => m[1]);
  assert.deepEqual(mutations, [], `Appels de mutation trouvés : ${mutations.join(", ")}`);
});

test("la publication de mise à jour reste servie en GET et en HEAD", () => {
  assert.match(code, /router\.get\(\s*["']\/mobile\/app-version["']/,
    "GET /xapi/mobile/app-version est la seule voie par laquelle une application " +
    "dont la session a expiré apprend qu'une mise à jour existe.");
  assert.match(code, /router\.head\(\s*["']\/mobile\/app-version["']/,
    "La sonde HEAD est utilisée pour mesurer la disponibilité.");
});

test("le routeur reste monté dans server.ts", () => {
  const serveur = sansCommentaires(lire("server.ts"));
  assert.match(serveur, /["']\/xapi["']/,
    "Supprimer le montage rendrait app-version injoignable le jour où la réécriture " +
    "nginx sera corrigée. Le routeur se vide de ses écritures, il ne se démonte pas.");
});

test("l'en-tête ne documente aucune route absente du fichier", () => {
  const entete = (xapi.match(/^\/\*\*[\s\S]*?\*\//) || [""])[0];
  // Seules les LIGNES DE DÉCLARATION sont vérifiées : « * GET /xapi/... ».
  // Les paragraphes explicatifs ont le droit — et le devoir — de nommer une
  // route supprimée pour dire pourquoi elle l'a été ; les confondre avec une
  // déclaration ferait mesurer au banc la prose plutôt que la surface, et
  // punirait précisément la documentation qu'on veut encourager.
  const declarations = [...entete.matchAll(/^\s*\*\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\s+\/xapi(\/[\w\-/:.]*)/gm)];
  assert.ok(declarations.length > 0, "L'en-tête doit énumérer la surface réelle du routeur.");
  for (const [, verbe, chemin] of declarations) {
    const motif = new RegExp(`router\\.${verbe.toLowerCase()}\\(\\s*["'\`]${chemin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    assert.match(code, motif,
      `L'en-tête déclare « ${verbe} /xapi${chemin} », qui n'existe pas dans le fichier. ` +
      `Une documentation fausse est pire qu'une absence de documentation : elle a fait ` +
      `chercher une route \`/xapi/mobile/ip\` qui n'a jamais existé.`);
  }
});
